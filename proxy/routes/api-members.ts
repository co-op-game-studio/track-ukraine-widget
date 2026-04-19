/**
 * /api/members/{bioguideId} — KV-backed member profile with read-through
 * fill from Congress.gov.
 *
 * Owns its implementation as of Phase 12 T-075 (2026-04-19).
 *
 * Traces: FR-32 AC-32.1, AC-32.18, AC-32.19. FR-42.
 */
import type { ProxyEnv } from '../env';
import type { DispatchResult, WaitUntilLike } from './common';
import { jsonResponse } from './common';
import { corsHeaders } from '../security/origin-allowlist';
import { sanitizeHttpUrl } from '../security/url-validator';
import { normalizeSearchKey } from '../kv/name-index';
import { KV_PREFIXES } from '../kv/prefixes';
import { PROFILE_TTL_SECONDS, type MemberProfile } from '../kv/member-profile';

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
  for (const t of terms) {
    if (!currentTerm || (t.endYear ?? 0) >= (currentTerm.endYear ?? 0)) currentTerm = t;
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
    const headers = new Headers(corsHeaders(origin));
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Cache-Control', 'public, max-age=60, s-maxage=300');
    headers.set('X-Cache', 'HIT');
    return {
      response: new Response(request.method === 'HEAD' ? null : (cached as string), {
        status: 200,
        headers,
      }),
      shape: 'api-proxied',
    };
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
