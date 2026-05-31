/**
 * seedMembers — pure orchestrator for "enumerate every current-Congress member
 * and ensure the durable D1 `members` row reflects Congress.gov truth." Mirrors
 * scripts/lib/bills/seed.ts. The `members` table is the source of truth that
 * `lw kv publish` projects member:v1: / state-members:v1: / name-index:v1: from.
 *
 * Per member: fetch /v3/member/{id} (detail) + sponsored + cosponsored
 * legislation; join socials (one shared fetch); freshness-gate on the detail's
 * updateDate (skip re-write when unchanged unless --force); upsert. Failures →
 * audit_log (action='member_seed_error') + continue. Exit-result mirrors bills.
 *
 * Traces to: FR-32 AC-32.39.
 */
import type { D1Like } from '../d1-client';
import type { CongressClient } from '../congress-client';
import type { AuditLogger } from '../audit-log';
import type { CliLogger } from '../logger';
import { normalizeSearchKey } from '../../../proxy/kv/name-index';
import { stateToCode, partyLetter, isNonVotingDelegate } from './normalize';
import { generateTraceId } from '../trace';

export type MemberSocials = Record<string, string>;

export interface SeedMembersInput {
  d1: D1Like;
  congressClient: CongressClient;
  auditLog: AuditLogger;
  logger: CliLogger;
  /** Returns bioguideId → socials map (one upstream fetch). Injected for tests. */
  fetchSocials: () => Promise<Map<string, MemberSocials>>;
  force?: boolean;
  concurrency?: number;
  actorEmail?: string;
  /** AC-32.43 — selective seeding. When set, seed ONLY these bioguides and
   *  skip list enumeration entirely (zero list calls). */
  onlyBioguides?: string[];
  /** AC-32.43 — enumerate the roster but seed ONLY bioguides absent from the
   *  D1 `members` table (existing rows incur zero detail calls). */
  onlyMissing?: boolean;
}

export interface SeedMembersResult {
  processed: number;
  ok: number;
  cached: number;
  failed: number;
  errors: Array<{ bioguideId: string; error: string; traceId: string }>;
  durationMs: number;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_ACTOR = 'ci@seed';

/* ----------------------------- upstream shapes ----------------------------- */

interface TermEntry { chamber?: string; district?: number; startYear?: number; endYear?: number }
interface MemberDetail {
  member?: {
    bioguideId: string;
    firstName?: string; lastName?: string; directOrderName?: string;
    state?: string; district?: number;
    partyHistory?: { partyName: string }[];
    terms?: TermEntry[] | { item: TermEntry[] };
    depiction?: { imageUrl?: string };
    officialWebsiteUrl?: string;
    updateDate?: string;
  };
}

async function listCurrentBioguides(client: CongressClient, traceId: string): Promise<string[]> {
  const out: string[] = [];
  const PAGE = 250;
  let offset = 0;
  // The fake/test returns one page; production paginates until short page.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = await client.get<{ members?: Array<{ bioguideId?: string }> }>(
      `/v3/member?currentMember=true&limit=${PAGE}&offset=${offset}`,
      traceId,
    );
    const members = data?.members ?? [];
    for (const m of members) if (m.bioguideId) out.push(m.bioguideId);
    if (members.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}

export async function seedMembers(input: SeedMembersInput): Promise<SeedMembersResult> {
  const t0 = Date.now();
  const {
    d1, congressClient, auditLog, logger, fetchSocials,
    force = false, concurrency = DEFAULT_CONCURRENCY, actorEmail = DEFAULT_ACTOR,
    onlyBioguides, onlyMissing = false,
  } = input;

  // AC-32.43 — resolve the work list selectively. `onlyBioguides` skips the
  // list endpoint entirely; otherwise enumerate, then `onlyMissing` drops
  // bioguides already present in D1 (so existing rows cost zero detail calls).
  const listTrace = generateTraceId();
  let bioguides: string[];
  if (onlyBioguides && onlyBioguides.length > 0) {
    bioguides = [...new Set(onlyBioguides)];
  } else {
    bioguides = await listCurrentBioguides(congressClient, listTrace);
    if (onlyMissing) {
      const existing = await d1.prepare('SELECT bioguide_id FROM members').all<{ bioguide_id: string }>();
      const have = new Set((existing.results ?? []).map((r) => r.bioguide_id));
      bioguides = bioguides.filter((b) => !have.has(b));
    }
  }
  const socialsMap = await fetchSocials();
  logger.info(`members seed start: ${bioguides.length} members force=${force} concurrency=${concurrency}${onlyMissing ? ' (only-missing)' : ''}${onlyBioguides ? ' (targeted)' : ''}`);

  const result: SeedMembersResult = { processed: 0, ok: 0, cached: 0, failed: 0, errors: [], durationMs: 0 };

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < bioguides.length) {
      const bioguideId = bioguides[cursor++]!;
      const traceId = generateTraceId();
      try {
        const cached = await importOne(bioguideId);
        result.ok++;
        if (cached) result.cached++;
      } catch (err) {
        result.failed++;
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push({ bioguideId, error: message, traceId });
        logger.error(`[members] ${bioguideId} FAILED trace=${traceId}: ${message}`);
        try {
          await auditLog.log({
            action: 'member_seed_error', actorEmail, targetTable: 'members',
            rowId: bioguideId, reason: message, traceId,
          });
        } catch { /* best-effort */ }
      } finally {
        result.processed++;
      }
    }
  }

  async function importOne(bioguideId: string): Promise<boolean> {
    const traceId = generateTraceId();
    const detail = await congressClient.get<MemberDetail>(`/v3/member/${bioguideId}?format=json`, traceId);
    const m = detail?.member;
    if (!m) throw new Error('member detail missing');
    const upstreamUpdate = m.updateDate ?? null;

    // Freshness gate (AC-32.39).
    if (!force && upstreamUpdate) {
      const existing = await d1
        .prepare('SELECT congress_update_date FROM members WHERE bioguide_id = ?')
        .bind(bioguideId)
        .first<{ congress_update_date: string | null }>();
      if (existing && existing.congress_update_date === upstreamUpdate) {
        logger.info(`[members] ${bioguideId} cached`);
        return true;
      }
    }

    const rawTerms = m.terms;
    const terms: TermEntry[] = Array.isArray(rawTerms) ? rawTerms : (rawTerms?.item ?? []);
    let currentTerm: TermEntry | undefined;
    let yearEntered: number | undefined;
    for (const t of terms) {
      if (!currentTerm || (t.endYear ?? 0) >= (currentTerm.endYear ?? 0)) currentTerm = t;
      if (typeof t.startYear === 'number' && (yearEntered === undefined || t.startYear < yearEntered)) yearEntered = t.startYear;
    }
    const chamber: 'House' | 'Senate' = currentTerm?.chamber === 'Senate' ? 'Senate' : 'House';
    const party = partyLetter(m.partyHistory?.[m.partyHistory.length - 1]?.partyName ?? '');
    const state = stateToCode(m.state ?? '');
    const first = m.firstName ?? '';
    const last = m.lastName ?? '';
    const officialName = m.directOrderName ?? `${first} ${last}`.trim();

    const [sponsoredResp, cosponsoredResp] = await Promise.all([
      congressClient.get<{ sponsoredLegislation?: unknown[] }>(`/v3/member/${bioguideId}/sponsored-legislation?limit=250&format=json`, traceId),
      congressClient.get<{ cosponsoredLegislation?: unknown[] }>(`/v3/member/${bioguideId}/cosponsored-legislation?limit=250&format=json`, traceId),
    ]);
    const sponsored = sponsoredResp?.sponsoredLegislation ?? [];
    const cosponsored = cosponsoredResp?.cosponsoredLegislation ?? [];

    const socials = socialsMap.get(bioguideId);
    const now = new Date().toISOString();
    await d1
      .prepare(
        `INSERT OR REPLACE INTO members
           (bioguide_id, first, last, official_name, state, chamber, district, party,
            photo_url, website, search_key, year_entered, is_non_voting,
            socials_json, sponsored_json, cosponsored_json,
            congress_update_date, last_freshness_check_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        bioguideId, first, last, officialName, state, chamber,
        currentTerm?.district ?? m.district ?? null, party,
        m.depiction?.imageUrl ?? null, m.officialWebsiteUrl ?? null,
        normalizeSearchKey(`${first} ${last}`),
        yearEntered ?? null, isNonVotingDelegate(chamber, state) ? 1 : 0,
        socials ? JSON.stringify(socials) : null,
        JSON.stringify(sponsored), JSON.stringify(cosponsored),
        upstreamUpdate, now, now, now,
      )
      .run();
    logger.info(`[members] ${bioguideId} ok`);
    return false;
  }

  const workers = Array.from({ length: Math.min(concurrency, Math.max(bioguides.length, 1)) }, () => worker());
  await Promise.all(workers);

  result.durationMs = Date.now() - t0;
  logger.info(`members seed done: processed=${result.processed} ok=${result.ok} cached=${result.cached} failed=${result.failed} ${(result.durationMs / 1000).toFixed(1)}s`);
  return result;
}
