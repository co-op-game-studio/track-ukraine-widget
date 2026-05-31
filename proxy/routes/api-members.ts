/**
 * /api/members/{bioguideId} — KV-backed member profile with read-through
 * fill from Congress.gov.
 *
 * Owns its implementation as of Phase 12 T-075 (2026-04-19).
 *
 * Traces: FR-32 AC-32.1, AC-32.18, AC-32.19. FR-42. FR-55 AC-55.6 / ADR-018 §6
 * (party-prior stamping during read-through fill).
 */
import type { ProxyEnv } from '../env';
import type { DispatchResult, WaitUntilLike } from './common';
import { jsonResponse } from './common';
import { corsHeaders } from '../security/origin-allowlist';
import { sanitizeHttpUrl } from '../security/url-validator';
import { normalizeSearchKey } from '../kv/name-index';
import { KV_PREFIXES } from '../kv/prefixes';
import { PROFILE_TTL_SECONDS, type MemberProfile } from '../kv/member-profile';
import { projectMemberProfile, type MemberRow } from '../services/member-projector';

/* ─── Party-prior stamping (FR-55 AC-55.6 / ADR-018 §6) ─────────────────── */

interface PartyPriorsRecord {
  generatedAt: string;
  schemaVersion: number;
  /** Map of party code ('D' | 'R' | 'I' | …) → mean Ukraine score in [-1, +1],
   *  or `null` for degenerate populations (<5 full-confidence reps). */
  priors: Record<string, number | null>;
}

/** Cached priors map within a single Worker isolate. The KV record changes
 *  only when the publish job runs (every 15 min on cron); per-request KV
 *  reads are cheap but module-scope memoization saves the round-trip in the
 *  common case. Reset to `null` on each isolate boot. */
let priorsCache: { fetchedAt: number; map: Record<string, number | null> } | null = null;
const PRIORS_CACHE_TTL_MS = 5 * 60 * 1000;

/** Look up the per-party prior map. Always returns an object; missing record
 *  or KV error → empty map → frontend treats every rep as "no shrink." */
async function loadPartyPriors(env: ProxyEnv): Promise<Record<string, number | null>> {
  if (priorsCache && Date.now() - priorsCache.fetchedAt < PRIORS_CACHE_TTL_MS) {
    return priorsCache.map;
  }
  try {
    const raw = await env.KV_VOTER_INFO.get(KV_PREFIXES.scores + 'party-priors', 'text');
    if (!raw) {
      // Cold deploy or pre-publish: priors not yet computed. Frontend
      // gracefully degrades to raw-score behavior (ADR-018 cold-start path).
      priorsCache = { fetchedAt: Date.now(), map: {} };
      return priorsCache.map;
    }
    const record = JSON.parse(raw as string) as PartyPriorsRecord;
    priorsCache = { fetchedAt: Date.now(), map: record.priors ?? {} };
    return priorsCache.map;
  } catch {
    // Malformed JSON or KV outage: same fallback as missing record. Don't
    // 5xx the member request just because the priors KV blob is broken.
    priorsCache = { fetchedAt: Date.now(), map: {} };
    return priorsCache.map;
  }
}

/** Stamp `partyPrior` onto a member profile. Mutates in place and returns
 *  the same reference for ergonomic chaining. */
function stampPartyPrior(profile: MemberProfile, priors: Record<string, number | null>): MemberProfile {
  // Look up by exact party code first ('D' / 'R' / 'I'). If the rep's party
  // doesn't appear in the priors map (cold-start or new third-party), use
  // null → no shrink, raw score wins (ADR-018 degenerate-population fallback).
  const value = profile.party in priors ? priors[profile.party] ?? null : null;
  profile.partyPrior = value;
  return profile;
}

/**
 * Fetch + assemble a member profile from upstream Congress.gov in three
 * parallel legs (detail, sponsored, cosponsored). Detail is REQUIRED;
 * sponsored/cosponsored degrade to empty lists on timeout or malformed
 * body so ancillary slowness doesn't 502 the whole profile.
 *
 * Exported for direct-invocation tests + future tooling (the warmer
 * invokes it too).
 */
export async function buildProfileFromUpstream(
  bioguideId: string,
  env: ProxyEnv,
): Promise<MemberProfile | null> {
  if (!env.CONGRESS_API_KEY) return null;
  const keyQS = `api_key=${env.CONGRESS_API_KEY}`;

  async function fetchOrNull(url: string): Promise<Response | null> {
    try {
      return await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return null;
    }
  }

  const [detailRes, sponsoredRes, cosponsoredRes] = await Promise.all([
    fetchOrNull(`https://api.congress.gov/v3/member/${bioguideId}?format=json&${keyQS}`),
    fetchOrNull(
      `https://api.congress.gov/v3/member/${bioguideId}/sponsored-legislation?limit=250&format=json&${keyQS}`,
    ),
    fetchOrNull(
      `https://api.congress.gov/v3/member/${bioguideId}/cosponsored-legislation?limit=250&format=json&${keyQS}`,
    ),
  ]);

  if (!detailRes) throw new Error('member detail upstream_timeout');
  if (detailRes.status === 404) return null;
  if (!detailRes.ok) throw new Error(`member detail ${detailRes.status}`);

  interface TermEntry {
    chamber?: 'House of Representatives' | 'Senate';
    congress?: number;
    district?: number;
    startYear?: number;
    endYear?: number;
  }
  let detail: {
    member: {
      bioguideId: string;
      firstName?: string;
      lastName?: string;
      directOrderName?: string;
      state: string;
      district?: number;
      partyHistory?: { partyName: string }[];
      terms?: TermEntry[] | { item: TermEntry[] };
      depiction?: { imageUrl?: string };
      officialWebsiteUrl?: string;
    };
  };
  try {
    const text = await detailRes.text();
    detail = JSON.parse(text);
  } catch {
    throw new Error('member detail upstream_body_invalid');
  }
  const m = detail.member;
  const rawTerms = m.terms;
  const terms: TermEntry[] = Array.isArray(rawTerms) ? rawTerms : (rawTerms?.item ?? []);
  let currentTerm: TermEntry | undefined;
  // Earliest start year across all terms = year member first entered office.
  // Members who've served non-contiguous terms (rare but real) correctly
  // surface their very-first-term year, not their current-stint-only year.
  let yearEntered: number | undefined;
  for (const t of terms) {
    if (!currentTerm || (t.endYear ?? 0) >= (currentTerm.endYear ?? 0)) currentTerm = t;
    if (typeof t.startYear === 'number') {
      if (yearEntered === undefined || t.startYear < yearEntered) {
        yearEntered = t.startYear;
      }
    }
  }
  const chamber: 'House' | 'Senate' =
    currentTerm?.chamber === 'Senate' ? 'Senate' : 'House';
  const partyName = m.partyHistory?.[m.partyHistory.length - 1]?.partyName ?? '';
  const party = partyName.startsWith('Democrat')
    ? 'D'
    : partyName.startsWith('Republican')
      ? 'R'
      : partyName.startsWith('Independent')
        ? 'I'
        : partyName.charAt(0).toUpperCase();

  async function parseListOrEmpty<K extends string>(
    res: Response | null,
    key: K,
  ): Promise<unknown[]> {
    if (!res || !res.ok) return [];
    try {
      const text = await res.text();
      const body = JSON.parse(text) as Record<K, unknown[] | undefined>;
      return body[key] ?? [];
    } catch {
      return [];
    }
  }
  const sponsored = await parseListOrEmpty(sponsoredRes, 'sponsoredLegislation');
  const cosponsored = await parseListOrEmpty(cosponsoredRes, 'cosponsoredLegislation');

  const first = m.firstName ?? '';
  const last = m.lastName ?? '';
  const officialName = m.directOrderName ?? `${first} ${last}`.trim();
  return {
    bioguideId: m.bioguideId,
    first,
    last,
    officialName,
    state: m.state,
    district: currentTerm?.district ?? m.district ?? null,
    chamber,
    party,
    photoUrl: sanitizeHttpUrl(m.depiction?.imageUrl),
    website: sanitizeHttpUrl(m.officialWebsiteUrl),
    searchKey: normalizeSearchKey(`${first} ${last}`),
    sponsored,
    cosponsored,
    // UAT (2026-04-19): earliest term start year — used by the widget to
    // render "· since YYYY" in member chips and the detail header.
    yearEntered,
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
  };
}

/**
 * Route handler for `GET /api/members/{bioguideId}`.
 *
 * Flow: validate bioguide shape → KV cache-read → on miss, read-through
 * fill from upstream + waitUntil KV write → return JSON profile.
 */
export async function handleMemberProfile(
  bioguideId: string,
  request: Request,
  env: ProxyEnv,
  ctx: WaitUntilLike,
  origin: string,
): Promise<DispatchResult> {
  if (!/^[A-Z][0-9]{6}$/.test(bioguideId)) {
    return {
      response: jsonResponse(400, { error: 'invalid_bioguide_id' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }

  const cached = await env.KV_VOTER_INFO.get(KV_PREFIXES.member + bioguideId, 'text');
  if (cached) {
    // FR-55 AC-55.6 / ADR-018 §6 — older cached records may pre-date the
    // partyPrior field (or were written before the publish job ran for the
    // first time). Stamp it on the way out so the client always sees a
    // current value without needing to wait for the 30-day TTL to expire.
    let body: string = cached as string;
    try {
      const profile = JSON.parse(body) as MemberProfile;
      const priors = await loadPartyPriors(env);
      stampPartyPrior(profile, priors);
      body = JSON.stringify(profile);
    } catch {
      // Malformed cached JSON: serve as-is rather than 5xx; the next miss
      // will rebuild it cleanly.
    }
    const headers = new Headers(corsHeaders(origin));
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Cache-Control', 'public, max-age=60, s-maxage=300');
    headers.set('X-Cache', 'HIT');
    return {
      response: new Response(request.method === 'HEAD' ? null : body, {
        status: 200,
        headers,
      }),
      shape: 'api-proxied',
    };
  }

  // FR-32 AC-32.41 — KV miss: self-heal from the durable D1 `members` row
  // (write-through caches it) before falling back to the upstream read-through.
  if (env.D1_VOTER_INFO) {
    try {
      const row = await env.D1_VOTER_INFO
        .prepare('SELECT * FROM members WHERE bioguide_id = ?')
        .bind(bioguideId)
        .first<MemberRow>();
      if (row) {
        const d1Profile = projectMemberProfile(row, new Date().toISOString());
        const priors = await loadPartyPriors(env);
        stampPartyPrior(d1Profile, priors);
        const body = JSON.stringify(d1Profile);
        ctx.waitUntil(env.KV_VOTER_INFO.put(KV_PREFIXES.member + bioguideId, body, { expirationTtl: PROFILE_TTL_SECONDS }));
        const headers = new Headers(corsHeaders(origin));
        headers.set('Content-Type', 'application/json; charset=utf-8');
        headers.set('Cache-Control', 'public, max-age=60, s-maxage=300');
        headers.set('X-Cache', 'D1');
        return {
          response: new Response(request.method === 'HEAD' ? null : body, { status: 200, headers }),
          shape: 'api-proxied',
        };
      }
    } catch {
      // D1 unavailable / table missing → fall through to upstream read-through.
    }
  }

  let profile: MemberProfile | null;
  try {
    profile = await buildProfileFromUpstream(bioguideId, env);
  } catch (e) {
    const msg = (e as Error).message;
    const isTimeout = msg.includes('upstream_timeout');
    return {
      response: jsonResponse(
        isTimeout ? 504 : 502,
        {
          error: isTimeout ? 'upstream_timeout' : 'upstream_error',
          detail: msg,
        },
        { ...corsHeaders(origin), 'Cache-Control': 'no-store' },
      ),
      shape: 'worker-emitted',
    };
  }

  if (!profile) {
    return {
      response: jsonResponse(404, { error: 'member_not_found', bioguideId }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }

  // FR-55 AC-55.6 / ADR-018 §6 — stamp partyPrior before the KV write so
  // every cached record carries the current prior.
  const priors = await loadPartyPriors(env);
  stampPartyPrior(profile, priors);

  const body = JSON.stringify(profile);
  ctx.waitUntil(
    env.KV_VOTER_INFO.put(KV_PREFIXES.member + bioguideId, body, {
      expirationTtl: PROFILE_TTL_SECONDS,
    }),
  );

  const headers = new Headers(corsHeaders(origin));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'public, max-age=60, s-maxage=300');
  headers.set('X-Cache', 'MISS');
  return {
    response: new Response(request.method === 'HEAD' ? null : body, {
      status: 200,
      headers,
    }),
    shape: 'api-proxied',
  };
}
