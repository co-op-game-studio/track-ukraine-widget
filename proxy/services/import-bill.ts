/**
 * Bill onboarding orchestrator (AC-52.49).
 *
 * Given (congress, type, number), pulls the bill detail + summaries +
 * actions + every roll-call detail referenced by the actions from
 * Congress.gov, then writes a single transactional D1 batch. On collision
 * with an existing bill row, refreshes static-from-Congress columns and
 * preserves researcher curation per AC-52.50. Per-row `congress_update_date`
 * short-circuits re-fetches when nothing has changed (AC-52.49 freshness
 * check).
 *
 * Pure-ish: side effects are upstream fetch + D1 write + KV invalidate.
 * The function returns a small `ImportResult` shape that the API route
 * forwards as JSON.
 *
 * Traces: AC-52.46, AC-52.49, AC-52.50.
 */
import type { ProxyEnv } from '../env';
import { newUlid } from '../d1/admin-store';
import { KV_KEY } from './kv-projector';
import { logEvent } from '../observability/log';

export interface ImportRequest {
  congress: number;
  type: string; // HR / S / HJRES / SJRES / etc.
  number: string;
  /** Force re-fetch even if upstream `updateDate` hasn't moved. */
  force?: boolean;
  /** Researcher attribution (passes from `extractAdminActor`). */
  actorEmail: string;
  traceId: string;
}

export interface ImportResult {
  bill: { bill_id: string; title: string; direction: string };
  votes_imported: number;
  votes_updated: number;
  votes_skipped: number;
  cosponsors_imported: number;
  actions_imported: number;
  cached: boolean;
  duration_ms: number;
  trace_id: string;
}

interface ProxyOpts {
  env: ProxyEnv;
  /** Origin to use when same-Worker subrequesting (`/api/congress/...`) */
  workerOrigin: string;
}

const ISO = () => new Date().toISOString();

/* -------------------------------------------------------------------------- */
/*                          Same-Worker subrequest                            */
/* -------------------------------------------------------------------------- */

/** Hit api.congress.gov directly with the Worker's API key.
 *
 *  Earlier this used a same-Worker subrequest to `/api/congress/*` so caching
 *  + key-injection would happen for free. That breaks on CF Access-protected
 *  hostnames (the subrequest goes through the edge → Access intercepts → 302
 *  to login → orchestrator sees a non-2xx and throws). Going direct avoids
 *  the loop entirely and shaves the per-call latency. The orchestrator runs
 *  rarely enough (researcher-triggered import + scheduled cron) that we
 *  don't need the tiered cache hit on the hot path.
 *
 *  Returns null on 404 (bill / sub-resource doesn't exist), throws otherwise.
 */
async function fetchCongress<T>(
  o: ProxyOpts,
  path: string,
  traceId: string,
): Promise<T | null> {
  const apiKey = o.env.CONGRESS_API_KEY;
  if (!apiKey) throw new Error('CONGRESS_API_KEY not configured');
  const url = new URL(`https://api.congress.gov/${path}`);
  // Path-style filtering: orchestrator paths sometimes include `?limit=...`,
  // make sure we forward those plus add the api_key + format=json.
  url.searchParams.set('api_key', apiKey);
  if (!url.searchParams.has('format')) url.searchParams.set('format', 'json');
  const resp = await globalThis.fetch(url.toString(), {
    method: 'GET',
    headers: {
      'X-Trace-Id': traceId,
      Accept: 'application/json',
      'User-Agent': 'voter-info-widget-import/1 (+https://github.com)',
    },
  });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new Error(`congress_upstream_${resp.status} ${url.pathname}`);
  }
  return (await resp.json()) as T;
}

/** AC-52.58 — pull every cosponsor across pages. Cap at 5 pages (1250 rows)
 *  to bound the work; popular bills like 117-HR-2471 (Ukraine Disaster Aid)
 *  rarely cross 200. */
async function fetchCosponsorsAllPages(
  o: ProxyOpts,
  billSlug: string,
  traceId: string,
): Promise<NonNullable<UpstreamCosponsorsResp['cosponsors']>> {
  const out: NonNullable<UpstreamCosponsorsResp['cosponsors']> = [];
  let offset = 0;
  for (let page = 0; page < 5; page++) {
    const resp = await fetchCongress<UpstreamCosponsorsResp>(
      o,
      `v3/bill/${billSlug}/cosponsors?limit=250&offset=${offset}`,
      traceId,
    );
    const items = resp?.cosponsors ?? [];
    out.push(...items);
    if (items.length < 250) break;
    offset += 250;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*                              Upstream shapes                                */
/* -------------------------------------------------------------------------- */

interface UpstreamSponsor {
  bioguideId?: string;
  fullName?: string;
  party?: string;
  state?: string;
}

interface UpstreamBillDetail {
  bill?: {
    title?: string;
    updateDate?: string;
    latestAction?: { actionDate?: string; text?: string };
    laws?: unknown[];
    congressGovUrl?: string;
    introducedDate?: string;
    sponsors?: UpstreamSponsor[];
  };
}

interface UpstreamCosponsorsResp {
  cosponsors?: Array<{
    bioguideId?: string;
    fullName?: string;
    party?: string;
    state?: string;
    district?: number | string;
    isOriginalCosponsor?: boolean;
    sponsorshipDate?: string;
    sponsorshipWithdrawnDate?: string | null;
  }>;
  pagination?: { count?: number; next?: string };
}

interface UpstreamActionRow {
  actionDate?: string;
  text?: string;
  actionCode?: string;
  sourceSystem?: { name?: string; code?: number };
  recordedVotes?: Array<{
    chamber?: string;
    congress?: number;
    sessionNumber?: number;
    rollNumber?: number;
    url?: string;
    date?: string;
  }>;
  // Some actions carry a CR reference embedded.
  congressionalRecord?: {
    citation?: string;
    url?: string;
  };
}

interface UpstreamActions {
  actions?: UpstreamActionRow[];
}

interface UpstreamHouseVote {
  houseRollCallVote?: {
    voteQuestion?: string;
    result?: string;
    startDate?: string;
    updateDate?: string;
  };
}

interface UpstreamSummaries {
  summaries?: Array<{
    actionDesc?: string;
    text?: string;
    updateDate?: string;
  }>;
}

/* -------------------------------------------------------------------------- */
/*                              Main orchestrator                              */
/* -------------------------------------------------------------------------- */

export async function importBillFromCongress(
  req: ImportRequest,
  opts: ProxyOpts,
): Promise<ImportResult> {
  const t0 = Date.now();
  const env = opts.env;
  const d1 = env.D1_VOTER_INFO!;
  const kv = env.KV_VOTER_INFO;
  const billId = `${req.congress}-${req.type.toUpperCase()}-${req.number}`;

  // 1. Fetch bill detail (cheap, cached). Required.
  const detail = await fetchCongress<UpstreamBillDetail>(
    opts,
    `v3/bill/${req.congress}/${req.type.toLowerCase()}/${req.number}`,
    req.traceId,
  );
  if (!detail || !detail.bill) {
    throw new Error('bill_not_found');
  }
  const upstreamUpdateDate = detail.bill.updateDate ?? null;

  // 2. Look up existing row to decide refresh-or-skip.
  const existing = await d1
    .prepare('SELECT * FROM bills WHERE bill_id = ?')
    .bind(billId)
    .first<{
      id: string;
      bill_id: string;
      direction: string;
      direction_reason: string | null;
      featured: number;
      label: string | null;
      congress_update_date: string | null;
    }>();
  const isNew = existing === null;

  // 3. AC-52.51 — short-circuit on unchanged updateDate.
  if (
    !req.force &&
    !isNew &&
    upstreamUpdateDate &&
    existing!.congress_update_date === upstreamUpdateDate
  ) {
    logEvent(
      { env: env.ENV_NAME ?? 'unknown', traceId: req.traceId },
      {
        event: 'bill_import_cache_hit',
        level: 'info',
        billId,
        congress_update_date: upstreamUpdateDate,
      },
    );
    return {
      bill: { bill_id: billId, title: detail.bill.title ?? '', direction: existing!.direction },
      votes_imported: 0,
      votes_updated: 0,
      votes_skipped: -1, // -1 signals "didn't enumerate"
      cosponsors_imported: 0,
      actions_imported: 0,
      cached: true,
      duration_ms: Date.now() - t0,
      trace_id: req.traceId,
    };
  }

  // 4. Fetch summaries + actions + cosponsors in parallel.
  const billSlug = `${req.congress}/${req.type.toLowerCase()}/${req.number}`;
  const [summaries, actions, cosponsors] = await Promise.all([
    fetchCongress<UpstreamSummaries>(
      opts,
      `v3/bill/${billSlug}/summaries`,
      req.traceId,
    ).catch(() => null),
    fetchCongress<UpstreamActions>(
      opts,
      `v3/bill/${billSlug}/actions?limit=250`,
      req.traceId,
    ),
    fetchCosponsorsAllPages(opts, billSlug, req.traceId),
  ]);

  // 5. Walk actions, collect every recordedVote reference.
  type RC = {
    chamber: string;
    congress: number;
    session: number;
    roll_call: number;
    date: string;
    url: string | null;
    action: string | null;
    action_date: string | null;
  };
  const rollCalls: RC[] = [];
  const seen = new Set<string>();
  for (const a of actions?.actions ?? []) {
    for (const rv of a.recordedVotes ?? []) {
      const chamber = rv.chamber ?? '';
      const congress = rv.congress ?? req.congress;
      const session = rv.sessionNumber ?? 0;
      const rc = rv.rollNumber ?? 0;
      if (!chamber || !rc) continue;
      const key = `${chamber}:${congress}:${session}:${rc}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rollCalls.push({
        chamber,
        congress,
        session,
        roll_call: rc,
        date: rv.date ?? a.actionDate ?? '',
        url: rv.url ?? null,
        action: a.text ?? null,
        action_date: a.actionDate ?? null,
      });
    }
  }

  // 6. Fetch House roll-call detail per RC (Senate skipped — XML pipeline
  //    out of scope for this import step; Senate votes can be added in a
  //    future pass).
  const voteUpdateDates = new Map<string, string | null>();
  for (const rc of rollCalls) {
    if (rc.chamber !== 'House') {
      voteUpdateDates.set(`${rc.chamber}:${rc.roll_call}`, null);
      continue;
    }
    try {
      const v = await fetchCongress<UpstreamHouseVote>(
        opts,
        `v3/house-vote/${rc.congress}/${rc.session}/${rc.roll_call}`,
        req.traceId,
      );
      voteUpdateDates.set(
        `${rc.chamber}:${rc.roll_call}`,
        v?.houseRollCallVote?.updateDate ?? null,
      );
    } catch {
      voteUpdateDates.set(`${rc.chamber}:${rc.roll_call}`, null);
    }
  }

  // 7. Build the D1 batch. Bill row first; votes after.
  const now = ISO();
  const summaryJson = summaries?.summaries?.length
    ? JSON.stringify(summaries.summaries[summaries.summaries.length - 1])
    : null;
  const stmts: unknown[] = []; // typed loosely to fit either prepare or batch shape

  // Sponsor extraction (AC-52.58). The bill detail's `sponsors[0]` is the
  // primary sponsor; further entries are co-sponsors that already appear in
  // the cosponsors endpoint, so we ignore them here.
  const sponsor = detail.bill.sponsors?.[0];
  const sponsorBioguide = sponsor?.bioguideId ?? null;
  const sponsorFullName = sponsor?.fullName ?? null;
  const sponsorParty = sponsor?.party ?? null;
  const sponsorState = sponsor?.state ?? null;
  const introducedDate = detail.bill.introducedDate ?? null;

  if (isNew) {
    const id = newUlid();
    stmts.push(
      d1
        .prepare(
          `INSERT INTO bills (
             id, bill_id, congress, type, number, featured, label, title, display_title,
             latest_action, latest_action_date, became_law, congress_gov_url,
             direction, direction_reason, summary_json,
             sponsor_bioguide_id, sponsor_full_name, sponsor_party, sponsor_state, introduced_date,
             congress_update_date, last_freshness_check_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, NULL, ?, ?, ?, ?, 'ambiguous', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          billId,
          req.congress,
          req.type.toUpperCase(),
          req.number,
          detail.bill.title ?? '',
          detail.bill.latestAction?.text ?? null,
          detail.bill.latestAction?.actionDate ?? null,
          (detail.bill.laws?.length ?? 0) > 0 ? 1 : 0,
          detail.bill.congressGovUrl ?? null,
          summaryJson,
          sponsorBioguide,
          sponsorFullName,
          sponsorParty,
          sponsorState,
          introducedDate,
          upstreamUpdateDate,
          now,
          now,
          now,
        ),
    );
  } else {
    // AC-52.50 — refresh static, preserve curation. `display_title` is
    // researcher-curated → never overwritten by import.
    stmts.push(
      d1
        .prepare(
          `UPDATE bills SET
             title = ?, latest_action = ?, latest_action_date = ?,
             became_law = ?, congress_gov_url = ?, summary_json = ?,
             sponsor_bioguide_id = ?, sponsor_full_name = ?, sponsor_party = ?, sponsor_state = ?,
             introduced_date = ?,
             congress_update_date = ?, last_freshness_check_at = ?,
             updated_at = ?
           WHERE bill_id = ?`,
        )
        .bind(
          detail.bill.title ?? '',
          detail.bill.latestAction?.text ?? null,
          detail.bill.latestAction?.actionDate ?? null,
          (detail.bill.laws?.length ?? 0) > 0 ? 1 : 0,
          detail.bill.congressGovUrl ?? null,
          summaryJson,
          sponsorBioguide,
          sponsorFullName,
          sponsorParty,
          sponsorState,
          introducedDate,
          upstreamUpdateDate,
          now,
          now,
          billId,
        ),
    );
  }

  // Existing votes for this bill, keyed by composite identity.
  const existingVotes = await d1
    .prepare(
      'SELECT id, chamber, congress, session, roll_call, congress_update_date FROM votes WHERE bill_id = ?',
    )
    .bind(billId)
    .all<{
      id: string;
      chamber: string;
      congress: number;
      session: number;
      roll_call: number;
      congress_update_date: string | null;
    }>();
  const existingByKey = new Map<string, { id: string; congress_update_date: string | null }>();
  for (const v of existingVotes.results ?? []) {
    existingByKey.set(`${v.chamber}:${v.congress}:${v.session}:${v.roll_call}`, {
      id: v.id,
      congress_update_date: v.congress_update_date,
    });
  }

  let votes_imported = 0;
  let votes_updated = 0;
  let votes_skipped = 0;
  for (const rc of rollCalls) {
    const k = `${rc.chamber}:${rc.congress}:${rc.session}:${rc.roll_call}`;
    const upstreamVoteUpdate = voteUpdateDates.get(`${rc.chamber}:${rc.roll_call}`) ?? null;
    const existingVote = existingByKey.get(k);
    if (existingVote) {
      // AC-52.49 per-vote staleness gate.
      if (
        !req.force &&
        upstreamVoteUpdate &&
        existingVote.congress_update_date === upstreamVoteUpdate
      ) {
        votes_skipped++;
        continue;
      }
      stmts.push(
        d1
          .prepare(
            `UPDATE votes SET
               date = ?, url = ?, action = ?, action_date = ?,
               congress_update_date = ?, updated_at = ?
             WHERE id = ?`,
          )
          .bind(
            rc.date,
            rc.url,
            rc.action,
            rc.action_date,
            upstreamVoteUpdate,
            now,
            existingVote.id,
          ),
      );
      votes_updated++;
    } else {
      stmts.push(
        d1
          .prepare(
            `INSERT INTO votes (
               id, bill_id, chamber, congress, session, roll_call, date,
               url, action, action_date, weight, direction_multiplier, kind,
               weight_reason, congress_update_date, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
          )
          .bind(
            newUlid(),
            billId,
            rc.chamber,
            rc.congress,
            rc.session,
            rc.roll_call,
            rc.date,
            rc.url,
            rc.action,
            rc.action_date,
            1,
            1,
            'unknown',
            upstreamVoteUpdate,
            now,
            now,
          ),
      );
      votes_imported++;
    }
  }

  // 7b. AC-52.58 — refresh cosponsors. Wipe-and-reload: cosponsors are
  // entirely upstream-owned (no researcher curation to preserve) and the
  // upstream list is the canonical "who currently cosponsors this bill"
  // truth — including withdrawals — so a clean swap is correct.
  stmts.push(d1.prepare('DELETE FROM bill_cosponsors WHERE bill_id = ?').bind(billId));
  let cosponsors_imported = 0;
  for (const c of cosponsors) {
    if (!c.bioguideId || !c.fullName) continue;
    stmts.push(
      d1
        .prepare(
          `INSERT INTO bill_cosponsors (
             id, bill_id, bioguide_id, full_name, party, state, district,
             is_original_cosponsor, sponsorship_date, sponsorship_withdrawn_date,
             congress_update_date, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          newUlid(),
          billId,
          c.bioguideId,
          c.fullName,
          c.party ?? null,
          c.state ?? null,
          c.district === undefined || c.district === null ? null : String(c.district),
          c.isOriginalCosponsor ? 1 : 0,
          c.sponsorshipDate ?? null,
          c.sponsorshipWithdrawnDate ?? null,
          upstreamUpdateDate,
          now,
          now,
        ),
    );
    cosponsors_imported++;
  }

  // 7c. AC-52.59 — refresh actions. Same wipe-and-reload posture: actions are
  // upstream-only and an action that disappears from upstream (rare; only
  // happens on Congress.gov data corrections) should disappear locally too.
  stmts.push(d1.prepare('DELETE FROM bill_actions WHERE bill_id = ?').bind(billId));
  let actions_imported = 0;
  for (const a of actions?.actions ?? []) {
    const sourceSystemName = a.sourceSystem?.name ?? null;
    // AC-52.66 — Congressional Record reference detection. Three sources, in
    // priority order:
    //   (1) action.congressionalRecord = { url, citation } (rare but trusted)
    //   (2) sourceSystem='Library of Congress' + a recordedVote URL on
    //       congress.gov/congressional-record/...
    //   (3) regex extraction from action.text (most common in real data —
    //       see extractCongressionalRecord for the patterns).
    let crUrl: string | null = a.congressionalRecord?.url ?? null;
    let crCitation: string | null = a.congressionalRecord?.citation ?? null;
    if (!crUrl && sourceSystemName === 'Library of Congress') {
      const cr = (a.recordedVotes ?? []).find((rv) =>
        (rv.url ?? '').includes('/congressional-record/'),
      );
      crUrl = cr?.url ?? null;
    }
    if (!crCitation) {
      const extracted = extractCongressionalRecord(a.text ?? null);
      crCitation = extracted.citation;
      // Don't overwrite a real URL with null; only adopt url if we don't have one.
      if (!crUrl && extracted.url) crUrl = extracted.url;
    }
    const recVote = (a.recordedVotes ?? [])[0];
    stmts.push(
      d1
        .prepare(
          `INSERT INTO bill_actions (
             id, bill_id, action_date, action_text, action_code, source_system,
             congressional_record_url, congressional_record_citation,
             recorded_chamber, recorded_roll_call,
             congress_update_date, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          newUlid(),
          billId,
          a.actionDate ?? null,
          a.text ?? null,
          a.actionCode ?? null,
          sourceSystemName,
          crUrl,
          crCitation,
          recVote?.chamber ?? null,
          recVote?.rollNumber ?? null,
          upstreamUpdateDate,
          now,
          now,
        ),
    );
    actions_imported++;
  }

  // 8. Audit row — single parent for the whole import.
  stmts.push(
    d1
      .prepare(
        `INSERT INTO audit_log (
           id, actor_email, action, target_table, row_id, row_title,
           before_json, after_json, reason, trace_id, created_at
         ) VALUES (?, ?, 'import_bill', 'bills', ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .bind(
        newUlid(),
        req.actorEmail,
        billId,
        detail.bill.title ?? billId,
        JSON.stringify({
          votes_imported,
          votes_updated,
          votes_skipped,
          cosponsors_imported,
          actions_imported,
        }),
        `Bill import (force=${req.force ? '1' : '0'})`,
        req.traceId,
        now,
      ),
  );

  // 9. Commit. D1.batch is atomic — any failure rolls back the whole set.
  await d1.batch(stmts as Parameters<typeof d1.batch>[0]);

  // 10. Invalidate KV (best-effort; cron + manual republish heal stragglers).
  await kv.delete(KV_KEY.bill(billId)).catch(() => undefined);

  return {
    bill: {
      bill_id: billId,
      title: detail.bill.title ?? '',
      direction: existing?.direction ?? 'ambiguous',
    },
    votes_imported,
    votes_updated,
    votes_skipped,
    cosponsors_imported,
    actions_imported,
    cached: false,
    duration_ms: Date.now() - t0,
    trace_id: req.traceId,
  };
}

/* -------------------------------------------------------------------------- */
/*                  Helper: decide which bills are due for cron               */
/* -------------------------------------------------------------------------- */

/** AC-52.66 — extract a Congressional Record citation from an action's text.
 *  Congress.gov's `/v3/bill/.../actions` doesn't reliably populate the
 *  structured `congressionalRecord.url` / `.citation` fields, so the
 *  citation is embedded in `action.text`. We match three observed patterns:
 *    "(text: CR H1405-1407)"  → "H1405-1407"
 *    "discussed in CR S5092"  → "S5092"
 *    "see Page S1234"         → "S1234"
 *  The URL field stays NULL (Congress.gov doesn't always provide one).
 *  Pure helper, exported for unit testing. */
export function extractCongressionalRecord(text: string | null | undefined): {
  citation: string | null;
  url: string | null;
} {
  if (!text) return { citation: null, url: null };
  // Try the most-specific patterns first so a "(text: CR H1405)" doesn't get
  // shadowed by the bare CR fallthrough.
  const patterns = [
    /\(text:\s*CR\s+([HSE]\d+(?:-\d+)?)\)/i,
    /\bCR\s+([HSE]\d+(?:-\d+)?)\b/i,
    /\bPage\s+([HSE]\d+(?:-\d+)?)\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return { citation: m[1], url: null };
  }
  return { citation: null, url: null };
}

/** AC-52.49 — scaling backoff. Maps "how recently was this bill seen?" to
 *  a re-check interval. */
export function freshnessIntervalMs(updatedAt: string, now = Date.now()): number {
  const ageMs = now - new Date(updatedAt).getTime();
  const HOUR = 60 * 60 * 1000;
  if (ageMs < 24 * HOUR) return 1 * HOUR;
  if (ageMs < 7 * 24 * HOUR) return 3 * HOUR;
  if (ageMs < 30 * 24 * HOUR) return 12 * HOUR;
  return 24 * HOUR;
}

/** True if this bill is due for a freshness re-check. */
export function isFreshnessDue(
  updatedAt: string,
  lastCheckAt: string | null,
  now = Date.now(),
): boolean {
  if (!lastCheckAt) return true;
  const interval = freshnessIntervalMs(updatedAt, now);
  return now - new Date(lastCheckAt).getTime() >= interval;
}
