/**
 * importBillCore — pure orchestrator for "fetch one bill from Congress.gov
 * + write it (and its votes + cosponsors + actions) into D1."
 *
 * Extracted from proxy/services/import-bill.ts in v4.1.0 so the same logic
 * powers both the Worker admin API (one-bill admin actions) and the `lw`
 * CLI (corpus backfill, FR-59). Inputs are the three injected interfaces
 * (D1Like, CongressClient, AuditLogger) — no Worker types, no env vars,
 * no global fetch.
 *
 * AC traces (carried over from import-bill.ts): AC-52.49 freshness gate,
 * AC-52.50 preserve curation, AC-52.58 cosponsor + sponsor extraction,
 * AC-52.59 actions wipe-and-reload, AC-52.66 Congressional Record refs.
 *
 * v4.1.0 new ACs:
 *   AC-59.5 — became_law correctly mapped from `bill.laws[].length > 0`.
 *   AC-59.6 — every recordedVote in every action is imported (not just
 *             a curator-pre-resolved subset).
 *   AC-59.10 — idempotent: re-running with unchanged Congress state writes
 *              zero new rows.
 */

import type { D1Like, D1PreparedStatement } from '../d1-client';
import type { CongressClient } from '../congress-client';
import type { AuditLogger } from '../audit-log';
import { newUlid } from '../../../src/utils/ulid';

/* -------------------------------------------------------------------------- */
/*                                Public types                                */
/* -------------------------------------------------------------------------- */

export interface ImportBillRequest {
  congress: number;
  type: string; // HR / S / HJRES / SJRES / HRES / SRES
  number: string;
  /** Force re-fetch even if upstream updateDate is unchanged. */
  force?: boolean;
  /** Audit-log actor (`ci@backfill`, an email, …). */
  actorEmail: string;
  /** Per-import trace ID for log + audit correlation. */
  traceId: string;
}

export interface ImportBillDeps {
  d1: D1Like;
  congressClient: CongressClient;
  /** AuditLogger is no longer used by importBillCore (the import audit row
   *  is now pushed into the atomic d1.batch) but the field is kept on the
   *  interface so callers (backfill driver) can use the same deps bundle
   *  shape and write `bill_backfill_error` audit rows from the loop. */
  auditLog?: AuditLogger;
  /** Optional KV invalidation callback. Worker passes one that hits
   *  `env.KV_VOTER_INFO.delete(...)`. CLI passes a CF KV REST API impl. */
  kvInvalidate?: (billId: string) => Promise<void>;
  /** Optional structured-log callback. Worker passes `logEvent` from
   *  proxy/observability/log; CLI passes a console.log-shaped fn. */
  log?: (event: Record<string, unknown>) => void;
}

export interface ImportBillResult {
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
/*                                  Helpers                                    */
/* -------------------------------------------------------------------------- */

const ISO = (): string => new Date().toISOString();

/** AC-52.58 — pull every cosponsor across pages (cap 5 pages = 1,250 rows). */
async function fetchCosponsorsAllPages(
  client: CongressClient,
  billSlug: string,
  traceId: string,
): Promise<NonNullable<UpstreamCosponsorsResp['cosponsors']>> {
  const out: NonNullable<UpstreamCosponsorsResp['cosponsors']> = [];
  let offset = 0;
  for (let page = 0; page < 5; page++) {
    const resp = await client.get<UpstreamCosponsorsResp>(
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

/** AC-52.66 — extract a Congressional Record citation from an action's text. */
export function extractCongressionalRecord(text: string | null | undefined): {
  citation: string | null;
  url: string | null;
} {
  if (!text) return { citation: null, url: null };
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

/** AC-52.49 — scaling backoff. */
export function freshnessIntervalMs(updatedAt: string, now = Date.now()): number {
  const ageMs = now - new Date(updatedAt).getTime();
  const HOUR = 60 * 60 * 1000;
  if (ageMs < 24 * HOUR) return 1 * HOUR;
  if (ageMs < 7 * 24 * HOUR) return 3 * HOUR;
  if (ageMs < 30 * 24 * HOUR) return 12 * HOUR;
  return 24 * HOUR;
}

export function isFreshnessDue(
  updatedAt: string,
  lastCheckAt: string | null,
  now = Date.now(),
): boolean {
  if (!lastCheckAt) return true;
  const interval = freshnessIntervalMs(updatedAt, now);
  return now - new Date(lastCheckAt).getTime() >= interval;
}

/* -------------------------------------------------------------------------- */
/*                              Main orchestrator                              */
/* -------------------------------------------------------------------------- */

export async function importBillCore(
  req: ImportBillRequest,
  deps: ImportBillDeps,
): Promise<ImportBillResult> {
  const t0 = Date.now();
  // auditLog is intentionally not destructured — the audit row is now
  // written into d1.batch (review #2). The field stays on deps for callers.
  const { d1, congressClient, kvInvalidate, log } = deps;
  const billId = `${req.congress}-${req.type.toUpperCase()}-${req.number}`;

  // 1. Fetch bill detail. Required.
  const detail = await congressClient.get<UpstreamBillDetail>(
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

  // 3. AC-52.49 — short-circuit on unchanged updateDate.
  if (
    !req.force &&
    !isNew &&
    upstreamUpdateDate &&
    existing!.congress_update_date === upstreamUpdateDate
  ) {
    log?.({
      event: 'bill_import_cache_hit',
      level: 'info',
      billId,
      congress_update_date: upstreamUpdateDate,
      traceId: req.traceId,
    });
    return {
      bill: { bill_id: billId, title: detail.bill.title ?? '', direction: existing!.direction },
      votes_imported: 0,
      votes_updated: 0,
      votes_skipped: -1,
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
    congressClient.get<UpstreamSummaries>(`v3/bill/${billSlug}/summaries`, req.traceId).catch(() => null),
    congressClient.get<UpstreamActions>(`v3/bill/${billSlug}/actions?limit=250`, req.traceId),
    fetchCosponsorsAllPages(congressClient, billSlug, req.traceId),
  ]);

  // 5. Walk actions, collect every recordedVote reference (AC-59.6).
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

  // 6. House roll-call detail per RC (Senate skipped — XML pipeline).
  const voteUpdateDates = new Map<string, string | null>();
  for (const rc of rollCalls) {
    if (rc.chamber !== 'House') {
      voteUpdateDates.set(`${rc.chamber}:${rc.roll_call}`, null);
      continue;
    }
    try {
      const v = await congressClient.get<UpstreamHouseVote>(
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

  // 7. Build the D1 batch.
  const now = ISO();
  const summaryJson = summaries?.summaries?.length
    ? JSON.stringify(summaries.summaries[summaries.summaries.length - 1])
    : null;
  const stmts: D1PreparedStatement[] = [];

  // Sponsor extraction (AC-52.58).
  const sponsor = detail.bill.sponsors?.[0];
  const sponsorBioguide = sponsor?.bioguideId ?? null;
  const sponsorFullName = sponsor?.fullName ?? null;
  const sponsorParty = sponsor?.party ?? null;
  const sponsorState = sponsor?.state ?? null;
  const introducedDate = detail.bill.introducedDate ?? null;

  // AC-59.5 — became_law correctly mapped from laws[].length > 0.
  const becameLaw = (detail.bill.laws?.length ?? 0) > 0 ? 1 : 0;

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
          becameLaw,
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
          becameLaw,
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

  // Existing votes for this bill.
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
               url, action, action_date, weight, direction, direction_multiplier, kind,
               weight_reason, congress_update_date, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
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
            // FR-63 — freshly imported, not-yet-classified votes are 'neutral'
            // (unreviewed) until a researcher reviews them via the review surface.
            'neutral',
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

  // 7b. AC-52.58 — refresh cosponsors (wipe-and-reload).
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

  // 7c. AC-52.59 — refresh actions.
  stmts.push(d1.prepare('DELETE FROM bill_actions WHERE bill_id = ?').bind(billId));
  let actions_imported = 0;
  for (const a of actions?.actions ?? []) {
    const sourceSystemName = a.sourceSystem?.name ?? null;
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

  // 8. Audit row — single parent for the whole import. Pushed into the
  // batch so it lands atomically with the bills/votes/cosponsors/actions
  // rows. Pre-v4.1.0 had this exact posture; the v4.1.0 extraction must
  // preserve it (review #2 — audit atomicity).
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

  // 9. Commit batch — bill, votes, cosponsors, actions, audit ALL atomic.
  await d1.batch(stmts);

  // 10. Invalidate KV. Worker: env.KV.delete via the injected callback.
  // CLI: cf-kv-rest-api impl (runtime.ts). Best-effort — failures swallowed.
  if (kvInvalidate) {
    await kvInvalidate(billId).catch(() => undefined);
  }

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
