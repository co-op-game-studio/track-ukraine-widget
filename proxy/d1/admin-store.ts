/**
 * Admin store — typed CRUD over D1 for the V4 editable content.
 *
 * The store is the only module that writes to D1. It enforces:
 *   - ULID PKs for new rows
 *   - ISO-8601 created_at / updated_at population
 *   - Validation per resource (FR-54 weight bounds, platform / media-kind enums, FK existence)
 *   - **Atomic mutation + audit via D1.batch** (FR-50 AC-50.3) so an audit
 *     row is impossible to skip and the audit row carries the inbound
 *     trace ID (FR-50 AC-50.7) for cross-correlation with structured logs.
 *
 * All writers accept `actorEmail` and `traceId` — the route layer threads
 * these from `extractAdminActor` and the inbound request's trace ID.
 *
 * Traces to FR-49, FR-50 AC-50.3 / AC-50.7, FR-51 AC-51.4..AC-51.6, FR-54.
 */
import type { D1Like, D1PreparedStatementLike, KVLike } from '../env';
import { KV_KEY } from '../services/kv-projector';
import { newUlid, isUlid } from '../../src/utils/ulid';
import { sanitizeHttpUrl } from '../security/url-validator';

/* -------------------------------------------------------------------------- */
/*                              Domain row shapes                             */
/* -------------------------------------------------------------------------- */

export interface BillRow {
  id: string;
  bill_id: string;
  congress: number;
  type: string;
  number: string;
  featured: number;
  label: string | null;
  title: string;
  /** AC-52.57 — researcher-editable short blurb. Falls back to `title` when null. */
  display_title: string | null;
  latest_action: string | null;
  latest_action_date: string | null;
  became_law: number;
  congress_gov_url: string | null;
  direction: string;
  direction_reason: string | null;
  summary_json: string | null;
  /** AC-52.58 — sponsor (denormalized from /v3/bill/.../?include sponsor). */
  sponsor_bioguide_id: string | null;
  sponsor_full_name: string | null;
  sponsor_party: string | null;
  sponsor_state: string | null;
  introduced_date: string | null;
  created_at: string;
  updated_at: string;
}

/** AC-52.58 — one row per cosponsor of a bill. */
export interface BillCosponsorRow {
  id: string;
  bill_id: string;
  bioguide_id: string;
  full_name: string;
  party: string | null;
  state: string | null;
  district: string | null;
  is_original_cosponsor: number;
  sponsorship_date: string | null;
  sponsorship_withdrawn_date: string | null;
  congress_update_date: string | null;
  created_at: string;
  updated_at: string;
}

/** AC-52.59 — one row per action recorded by Congress.gov on a bill. */
export interface BillActionRow {
  id: string;
  bill_id: string;
  action_date: string | null;
  action_text: string | null;
  action_code: string | null;
  source_system: string | null;
  congressional_record_url: string | null;
  congressional_record_citation: string | null;
  recorded_chamber: string | null;
  recorded_roll_call: number | null;
  congress_update_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface VoteRow {
  id: string;
  bill_id: string;
  chamber: string;
  congress: number;
  session: number;
  roll_call: number;
  date: string;
  url: string | null;
  action: string | null;
  action_date: string | null;
  weight: number;
  /** FR-63 — the vote's own Ukraine direction ('pro'|'anti'|'neutral'). */
  direction: string;
  /** FR-63 — set when a researcher confirms the direction (review surface). */
  direction_reviewed_at: string | null;
  direction_reviewed_by: string | null;
  /** @deprecated FR-63 — no longer drives scoring; kept one release. */
  direction_multiplier: number;
  kind: string;
  /** FR-54 AC-54.6 — standing rationale for current weight + multiplier. */
  weight_reason: string | null;
  created_at: string;
  updated_at: string;
}

/* AC-52.38 — comments / social_posts / quotes carry weight + direction
 * (matching the votes shape) instead of the legacy [-1,+1] score_adjustment
 * slider. The score formula now consumes them as synthetic actions; see
 * AC-52.44. */
export interface CommentRow {
  id: string;
  bill_id: string;
  attached_to_roll_call_id: string | null;
  body_markdown: string;
  weight: number;
  direction: number;
  author_email: string;
  created_at: string;
  updated_at: string;
}

export interface SocialPostRow {
  id: string;
  bioguide_id: string;
  platform: string;
  url: string;
  posted_at: string | null;
  body_text: string;
  weight: number;
  direction: number;
  comment: string | null;
  author_email: string;
  created_at: string;
  updated_at: string;
}

export interface QuoteRow {
  id: string;
  bioguide_id: string;
  media_kind: string;
  source_url: string;
  source_label: string | null;
  quoted_at: string | null;
  body_text: string;
  weight: number;
  direction: number;
  comment: string | null;
  /** Optional ancillary links: JSON array of {label, url}. Migration 0008. */
  links_json: string | null;
  author_email: string;
  created_at: string;
  updated_at: string;
}

/** A user-defined tag (Settings ▸ Tags). Migration 0008. */
export interface TagRow {
  id: string;
  slug: string;
  label: string;
  color: string;
  description: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
}

/** Persistent per-handle poll status (last attempt outcome). Migration 0008. */
export interface HandlePollStatus {
  handle_id: string;
  platform: string;
  handle: string;
  display_name: string | null;
  bioguide_id: string | null;
  last_polled_at: string | null;        // last SUCCESS
  last_poll_attempted_at: string | null; // last attempt regardless of outcome
  last_poll_status: string | null;       // 'ok' | 'error' | null = never tried
  last_poll_error: string | null;
  last_poll_trace_id: string | null;
}

export interface AuditRow {
  id: string;
  actor_email: string;
  action: 'create' | 'update' | 'delete';
  target_table: string;
  row_id: string;
  row_title: string | null;
  before_json: string | null;
  after_json: string | null;
  reason: string | null;
  trace_id: string;
  created_at: string;
}

/* -------------------------------------------------------------------------- */
/*                              Validation errors                             */
/* -------------------------------------------------------------------------- */

export class ValidationError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const VALID_PLATFORMS = new Set(['x', 'facebook', 'youtube', 'instagram', 'other']);
const VALID_MEDIA_KINDS = new Set(['video', 'audio', 'text', 'image', 'social']);
const VALID_DIRECTIONS = new Set(['pro-ukraine', 'anti-ukraine', 'ambiguous']);
/** FR-63 — per-VOTE direction domain (distinct from bill direction). */
const VALID_VOTE_DIRECTIONS = new Set(['pro', 'anti', 'neutral']);
const VALID_CHAMBERS = new Set(['House', 'Senate']);

/* -------------------------------------------------------------------------- */
/*                              Common writer state                           */
/* -------------------------------------------------------------------------- */

export interface MutationContext {
  actorEmail: string;
  traceId: string;
  reason?: string;
  /** AC-52.47 — KV invalidation. The store deletes the affected keys after
   *  the D1 batch lands. Optional so tests with no KV harness still work. */
  kv?: KVLike;
}

export interface AuditPayload {
  action: 'create' | 'update' | 'delete';
  targetTable: string;
  rowId: string;
  rowTitle: string | null;
  before: unknown | null;
  after: unknown | null;
}

function isoNow(): string {
  return new Date().toISOString();
}

function buildAuditStmt(
  d1: D1Like,
  ctx: MutationContext,
  payload: AuditPayload,
): D1PreparedStatementLike {
  const id = newUlid();
  return d1
    .prepare(
      `INSERT INTO audit_log (
         id, actor_email, action, target_table, row_id, row_title,
         before_json, after_json, reason, trace_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      ctx.actorEmail,
      payload.action,
      payload.targetTable,
      payload.rowId,
      payload.rowTitle,
      payload.before === null ? null : JSON.stringify(payload.before),
      payload.after === null ? null : JSON.stringify(payload.after),
      ctx.reason ?? null,
      ctx.traceId,
      isoNow(),
    );
}

/**
 * Run a mutation + its audit row atomically via D1.batch().
 * D1's batch is an implicit transaction — all-or-nothing. If any
 * statement fails, the entire batch rolls back, satisfying AC-50.3.
 *
 * AC-52.47 — after a successful batch, invalidate the affected KV cache
 * keys so the next embed read repopulates from D1. KV deletes are best-
 * effort: a failure logs but does NOT roll back the D1 mutation. The
 * scaling-backoff cron (AC-52.49) and the manual republish script will
 * heal any stragglers eventually.
 */
export async function runMutationWithAudit(
  d1: D1Like,
  ctx: MutationContext,
  mutation: D1PreparedStatementLike,
  audit: AuditPayload,
  kvKeysToInvalidate: readonly string[] = [],
): Promise<void> {
  // Auto-provision researcher row on first write — avoids FK constraint
  // failures when a new admin user (via CF Access) creates content.
  const ensureResearcher = d1
    .prepare('INSERT INTO researchers (email, created_at) VALUES (?, ?) ON CONFLICT (email) DO NOTHING')
    .bind(ctx.actorEmail, new Date().toISOString());
  const auditStmt = buildAuditStmt(d1, ctx, audit);
  const results = await d1.batch([ensureResearcher, mutation, auditStmt]);
  for (const r of results) {
    if (!r.success) {
      throw new Error(`d1_batch_failed: ${r.error ?? 'unknown'}`);
    }
  }
  if (ctx.kv && kvKeysToInvalidate.length > 0) {
    await Promise.all(
      kvKeysToInvalidate.map((k) =>
        ctx.kv!.delete(k).catch(() => {
          // Best-effort; eventual consistency via cron + manual republish.
        }),
      ),
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                                    Bills                                   */
/* -------------------------------------------------------------------------- */

export interface BillCreateInput {
  bill_id: string;
  congress: number;
  type: string;
  number: string;
  featured?: boolean;
  label?: string | null;
  title: string;
  display_title?: string | null;
  latest_action?: string | null;
  latest_action_date?: string | null;
  became_law?: boolean;
  congress_gov_url?: string | null;
  direction: string;
  direction_reason?: string | null;
  summary_json?: string | null;
  sponsor_bioguide_id?: string | null;
  sponsor_full_name?: string | null;
  sponsor_party?: string | null;
  sponsor_state?: string | null;
  introduced_date?: string | null;
}

function validateBillCreate(input: BillCreateInput): void {
  if (!input.bill_id) throw new ValidationError('invalid_bill_id', 'bill_id is required');
  if (!input.title) throw new ValidationError('invalid_title', 'title is required');
  if (!VALID_DIRECTIONS.has(input.direction)) {
    throw new ValidationError('invalid_direction', `direction must be one of ${[...VALID_DIRECTIONS].join(', ')}`);
  }
}

export async function createBill(
  d1: D1Like,
  ctx: MutationContext,
  input: BillCreateInput,
): Promise<BillRow> {
  validateBillCreate(input);
  const now = isoNow();
  const row: BillRow = {
    id: newUlid(),
    bill_id: input.bill_id,
    congress: input.congress,
    type: input.type,
    number: input.number,
    featured: input.featured ? 1 : 0,
    label: input.label ?? null,
    title: input.title,
    display_title: input.display_title ?? null,
    latest_action: input.latest_action ?? null,
    latest_action_date: input.latest_action_date ?? null,
    became_law: input.became_law ? 1 : 0,
    congress_gov_url: input.congress_gov_url ?? null,
    direction: input.direction,
    direction_reason: input.direction_reason ?? null,
    summary_json: input.summary_json ?? null,
    sponsor_bioguide_id: input.sponsor_bioguide_id ?? null,
    sponsor_full_name: input.sponsor_full_name ?? null,
    sponsor_party: input.sponsor_party ?? null,
    sponsor_state: input.sponsor_state ?? null,
    introduced_date: input.introduced_date ?? null,
    created_at: now,
    updated_at: now,
  };
  const stmt = d1
    .prepare(
      `INSERT INTO bills (
         id, bill_id, congress, type, number, featured, label, title, display_title,
         latest_action, latest_action_date, became_law, congress_gov_url,
         direction, direction_reason, summary_json,
         sponsor_bioguide_id, sponsor_full_name, sponsor_party, sponsor_state, introduced_date,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id, row.bill_id, row.congress, row.type, row.number, row.featured,
      row.label, row.title, row.display_title, row.latest_action, row.latest_action_date,
      row.became_law, row.congress_gov_url, row.direction, row.direction_reason,
      row.summary_json,
      row.sponsor_bioguide_id, row.sponsor_full_name, row.sponsor_party, row.sponsor_state, row.introduced_date,
      row.created_at, row.updated_at,
    );
  await runMutationWithAudit(d1, ctx, stmt, {
    action: 'create',
    targetTable: 'bills',
    rowId: row.id,
    rowTitle: row.title,
    before: null,
    after: row,
  }, [KV_KEY.bill(row.bill_id)]);
  return row;
}

export async function getBill(d1: D1Like, id: string): Promise<BillRow | null> {
  return d1.prepare('SELECT * FROM bills WHERE id = ?').bind(id).first<BillRow>();
}

export async function listBills(
  d1: D1Like,
  opts: { limit?: number; offset?: number } = {},
): Promise<BillRow[]> {
  const limit = Math.min(opts.limit ?? 100, 250);
  const offset = opts.offset ?? 0;
  const result = await d1
    .prepare('SELECT * FROM bills ORDER BY congress DESC, type, number LIMIT ? OFFSET ?')
    .bind(limit, offset)
    .all<BillRow>();
  return result.results ?? [];
}

/** AC-52.22 — list votes for one bill, ordered for the inline section.
 *  Order matches FR-32 chronology: newest congress/session first, then roll_call ASC
 *  so an editor scanning a bill sees the procedural sequence within each session. */
export async function listVotesByBill(d1: D1Like, billId: string): Promise<VoteRow[]> {
  const result = await d1
    .prepare(
      'SELECT * FROM votes WHERE bill_id = ? ORDER BY congress DESC, session DESC, roll_call ASC',
    )
    .bind(billId)
    .all<VoteRow>();
  return result.results ?? [];
}

/** AC-52.58 — list cosponsors for a bill, ordered by sponsorship_date asc.
 *  Original cosponsors typically all share `is_original_cosponsor = 1` and the
 *  bill's introduced date; later cosponsors are listed in chronological order. */
export async function listCosponsorsByBill(
  d1: D1Like,
  billId: string,
): Promise<BillCosponsorRow[]> {
  const result = await d1
    .prepare(
      `SELECT * FROM bill_cosponsors
        WHERE bill_id = ?
        ORDER BY is_original_cosponsor DESC, sponsorship_date ASC, full_name ASC`,
    )
    .bind(billId)
    .all<BillCosponsorRow>();
  return result.results ?? [];
}

/** AC-52.59 — list actions for a bill, newest first. */
export async function listActionsByBill(
  d1: D1Like,
  billId: string,
): Promise<BillActionRow[]> {
  const result = await d1
    .prepare(
      `SELECT * FROM bill_actions
        WHERE bill_id = ?
        ORDER BY action_date DESC, id DESC`,
    )
    .bind(billId)
    .all<BillActionRow>();
  return result.results ?? [];
}

/** AC-52.22 — list comments for one bill, newest first. */
export async function listCommentsByBill(d1: D1Like, billId: string): Promise<CommentRow[]> {
  const result = await d1
    .prepare('SELECT * FROM comments WHERE bill_id = ? ORDER BY created_at DESC')
    .bind(billId)
    .all<CommentRow>();
  return result.results ?? [];
}

export type BillUpdate = Partial<Omit<BillCreateInput, 'bill_id'>>;

export async function updateBill(
  d1: D1Like,
  ctx: MutationContext,
  id: string,
  patch: BillUpdate,
): Promise<BillRow> {
  const before = await getBill(d1, id);
  if (!before) throw new ValidationError('not_found', `bill not found: ${id}`);
  if (patch.direction !== undefined && !VALID_DIRECTIONS.has(patch.direction)) {
    throw new ValidationError('invalid_direction', 'direction is invalid');
  }
  const after: BillRow = {
    ...before,
    congress: patch.congress ?? before.congress,
    type: patch.type ?? before.type,
    number: patch.number ?? before.number,
    featured: patch.featured === undefined ? before.featured : patch.featured ? 1 : 0,
    label: patch.label === undefined ? before.label : patch.label,
    title: patch.title ?? before.title,
    display_title: patch.display_title === undefined ? before.display_title : patch.display_title,
    latest_action: patch.latest_action === undefined ? before.latest_action : patch.latest_action,
    latest_action_date: patch.latest_action_date === undefined ? before.latest_action_date : patch.latest_action_date,
    became_law: patch.became_law === undefined ? before.became_law : patch.became_law ? 1 : 0,
    congress_gov_url: patch.congress_gov_url === undefined ? before.congress_gov_url : patch.congress_gov_url,
    direction: patch.direction ?? before.direction,
    direction_reason: patch.direction_reason === undefined ? before.direction_reason : patch.direction_reason,
    summary_json: patch.summary_json === undefined ? before.summary_json : patch.summary_json,
    sponsor_bioguide_id: patch.sponsor_bioguide_id === undefined ? before.sponsor_bioguide_id : patch.sponsor_bioguide_id,
    sponsor_full_name: patch.sponsor_full_name === undefined ? before.sponsor_full_name : patch.sponsor_full_name,
    sponsor_party: patch.sponsor_party === undefined ? before.sponsor_party : patch.sponsor_party,
    sponsor_state: patch.sponsor_state === undefined ? before.sponsor_state : patch.sponsor_state,
    introduced_date: patch.introduced_date === undefined ? before.introduced_date : patch.introduced_date,
    updated_at: isoNow(),
  };
  const stmt = d1
    .prepare(
      `UPDATE bills SET
         congress = ?, type = ?, number = ?, featured = ?, label = ?, title = ?, display_title = ?,
         latest_action = ?, latest_action_date = ?, became_law = ?,
         congress_gov_url = ?, direction = ?, direction_reason = ?,
         summary_json = ?,
         sponsor_bioguide_id = ?, sponsor_full_name = ?, sponsor_party = ?, sponsor_state = ?, introduced_date = ?,
         updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      after.congress, after.type, after.number, after.featured, after.label,
      after.title, after.display_title, after.latest_action, after.latest_action_date, after.became_law,
      after.congress_gov_url, after.direction, after.direction_reason,
      after.summary_json,
      after.sponsor_bioguide_id, after.sponsor_full_name, after.sponsor_party, after.sponsor_state, after.introduced_date,
      after.updated_at, id,
    );
  await runMutationWithAudit(d1, ctx, stmt, {
    action: 'update',
    targetTable: 'bills',
    rowId: id,
    rowTitle: after.title,
    before,
    after,
  }, [KV_KEY.bill(after.bill_id)]);
  return after;
}

export async function deleteBill(
  d1: D1Like,
  ctx: MutationContext,
  id: string,
): Promise<void> {
  const before = await getBill(d1, id);
  if (!before) throw new ValidationError('not_found', `bill not found: ${id}`);
  const stmt = d1.prepare('DELETE FROM bills WHERE id = ?').bind(id);
  await runMutationWithAudit(d1, ctx, stmt, {
    action: 'delete',
    targetTable: 'bills',
    rowId: id,
    rowTitle: before.title,
    before,
    after: null,
  }, [KV_KEY.bill(before.bill_id), KV_KEY.comments(before.bill_id)]);
}

/* -------------------------------------------------------------------------- */
/*                                    Votes                                   */
/* -------------------------------------------------------------------------- */

export interface VoteCreateInput {
  bill_id: string;
  chamber: string;
  congress: number;
  session: number;
  roll_call: number;
  date: string;
  url?: string | null;
  action?: string | null;
  action_date?: string | null;
  weight: number;
  /** FR-63 — explicit per-vote direction; defaults to 'neutral'. */
  direction?: string;
  direction_multiplier?: number;
  kind: string;
  /** FR-54 AC-54.6 — optional standing rationale. */
  weight_reason?: string | null;
}

/** FR-63 — validate a per-vote direction, defaulting to 'neutral'. */
function validateVoteDirection(d: string | undefined): string {
  if (d === undefined) return 'neutral';
  if (!VALID_VOTE_DIRECTIONS.has(d)) {
    throw new ValidationError('invalid_direction', `vote direction must be one of ${[...VALID_VOTE_DIRECTIONS].join(', ')}`);
  }
  return d;
}

function validateVoteWeight(weight: number): number {
  if (typeof weight !== 'number' || !Number.isFinite(weight)) {
    throw new ValidationError('invalid_weight', 'weight must be a finite number');
  }
  if (weight < 0) return 0;
  if (weight > 5) {
    throw new ValidationError('invalid_weight', 'weight must be ≤ 5');
  }
  return weight;
}

function validateDirectionMultiplier(dm: number | undefined): number {
  if (dm === undefined) return 1;
  if (dm !== -1 && dm !== 0 && dm !== 1) {
    throw new ValidationError('invalid_direction', 'direction must be -1, 0, or 1');
  }
  return dm;
}

export async function createVote(
  d1: D1Like,
  ctx: MutationContext,
  input: VoteCreateInput,
): Promise<VoteRow> {
  if (!VALID_CHAMBERS.has(input.chamber)) {
    throw new ValidationError('invalid_chamber', 'chamber must be House or Senate');
  }
  const billExists = await d1
    .prepare('SELECT 1 FROM bills WHERE bill_id = ? LIMIT 1')
    .bind(input.bill_id)
    .first<{ '1': number }>();
  if (!billExists) {
    throw new ValidationError('unknown_bill_id', `unknown bill_id: ${input.bill_id}`);
  }
  const now = isoNow();
  const trimmedReason = input.weight_reason?.trim();
  const row: VoteRow = {
    id: newUlid(),
    bill_id: input.bill_id,
    chamber: input.chamber,
    congress: input.congress,
    session: input.session,
    roll_call: input.roll_call,
    date: input.date,
    url: input.url ?? null,
    action: input.action ?? null,
    action_date: input.action_date ?? null,
    weight: validateVoteWeight(input.weight),
    direction: validateVoteDirection(input.direction),
    direction_reviewed_at: null,
    direction_reviewed_by: null,
    direction_multiplier: validateDirectionMultiplier(input.direction_multiplier),
    kind: input.kind,
    weight_reason: trimmedReason && trimmedReason.length > 0 ? trimmedReason : null,
    created_at: now,
    updated_at: now,
  };
  const stmt = d1
    .prepare(
      `INSERT INTO votes (
         id, bill_id, chamber, congress, session, roll_call, date, url,
         action, action_date, weight, direction, direction_multiplier, kind,
         weight_reason, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id, row.bill_id, row.chamber, row.congress, row.session, row.roll_call,
      row.date, row.url, row.action, row.action_date, row.weight, row.direction,
      row.direction_multiplier, row.kind, row.weight_reason, row.created_at, row.updated_at,
    );
  await runMutationWithAudit(d1, ctx, stmt, {
    action: 'create',
    targetTable: 'votes',
    rowId: row.id,
    rowTitle: `${row.bill_id} / ${row.chamber} roll ${row.roll_call}`,
    before: null,
    after: row,
  }, [KV_KEY.bill(row.bill_id)]);
  return row;
}

export async function getVote(d1: D1Like, id: string): Promise<VoteRow | null> {
  return d1.prepare('SELECT * FROM votes WHERE id = ?').bind(id).first<VoteRow>();
}

export interface VoteUpdate {
  weight?: number;
  /** FR-63 — set the vote's explicit direction. Supplying it marks the vote as
   *  reviewed (stamps direction_reviewed_at/by from the actor). */
  direction?: string;
  direction_multiplier?: number;
  kind?: string;
  action?: string | null;
  action_date?: string | null;
  url?: string | null;
  date?: string;
  /** FR-54 AC-54.6 — update the standing rationale. */
  weight_reason?: string | null;
}

export async function updateVote(
  d1: D1Like,
  ctx: MutationContext,
  id: string,
  patch: VoteUpdate,
): Promise<VoteRow> {
  const before = await getVote(d1, id);
  if (!before) throw new ValidationError('not_found', `vote not found: ${id}`);
  // Trim weight_reason; whitespace-only stores as NULL (AC-54.6).
  let nextWeightReason = before.weight_reason;
  if (patch.weight_reason !== undefined) {
    if (patch.weight_reason === null) {
      nextWeightReason = null;
    } else {
      const trimmed = patch.weight_reason.trim();
      nextWeightReason = trimmed.length > 0 ? trimmed : null;
    }
  }
  // FR-63 — supplying `direction` marks the vote reviewed: stamp who/when.
  const directionProvided = patch.direction !== undefined;
  const nextDirection = directionProvided
    ? validateVoteDirection(patch.direction)
    : before.direction;
  const now = isoNow();
  const after: VoteRow = {
    ...before,
    weight: patch.weight === undefined ? before.weight : validateVoteWeight(patch.weight),
    direction: nextDirection,
    direction_reviewed_at: directionProvided ? now : before.direction_reviewed_at,
    direction_reviewed_by: directionProvided ? ctx.actorEmail : before.direction_reviewed_by,
    direction_multiplier:
      patch.direction_multiplier === undefined
        ? before.direction_multiplier
        : validateDirectionMultiplier(patch.direction_multiplier),
    kind: patch.kind ?? before.kind,
    action: patch.action === undefined ? before.action : patch.action,
    action_date: patch.action_date === undefined ? before.action_date : patch.action_date,
    url: patch.url === undefined ? before.url : patch.url,
    date: patch.date ?? before.date,
    weight_reason: nextWeightReason,
    updated_at: now,
  };
  const stmt = d1
    .prepare(
      `UPDATE votes SET weight = ?, direction = ?, direction_reviewed_at = ?,
         direction_reviewed_by = ?, direction_multiplier = ?, kind = ?,
         action = ?, action_date = ?, url = ?, date = ?, weight_reason = ?,
         updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      after.weight, after.direction, after.direction_reviewed_at,
      after.direction_reviewed_by, after.direction_multiplier, after.kind,
      after.action, after.action_date, after.url, after.date, after.weight_reason,
      after.updated_at, id,
    );
  await runMutationWithAudit(d1, ctx, stmt, {
    action: 'update',
    targetTable: 'votes',
    rowId: id,
    rowTitle: `${after.bill_id} / ${after.chamber} roll ${after.roll_call}`,
    before,
    after,
  }, [KV_KEY.bill(after.bill_id)]);
  return after;
}

export async function deleteVote(
  d1: D1Like,
  ctx: MutationContext,
  id: string,
): Promise<void> {
  const before = await getVote(d1, id);
  if (!before) throw new ValidationError('not_found', `vote not found: ${id}`);
  const stmt = d1.prepare('DELETE FROM votes WHERE id = ?').bind(id);
  await runMutationWithAudit(d1, ctx, stmt, {
    action: 'delete',
    targetTable: 'votes',
    rowId: id,
    rowTitle: `${before.bill_id} / ${before.chamber} roll ${before.roll_call}`,
    before,
    after: null,
  }, [KV_KEY.bill(before.bill_id)]);
}

/* -------------------------------------------------------------------------- */
/*                                  Comments                                  */
/* -------------------------------------------------------------------------- */

export interface CommentCreateInput {
  bill_id: string;
  attached_to_roll_call_id?: string | null;
  body_markdown: string;
  weight?: number;
  direction?: number;
}

export async function createComment(
  d1: D1Like,
  ctx: MutationContext,
  input: CommentCreateInput,
): Promise<CommentRow> {
  if (!input.body_markdown) {
    throw new ValidationError('invalid_body', 'body_markdown is required');
  }
  const billExists = await d1
    .prepare('SELECT 1 FROM bills WHERE bill_id = ? LIMIT 1')
    .bind(input.bill_id)
    .first<{ '1': number }>();
  if (!billExists) {
    throw new ValidationError('unknown_bill_id', `unknown bill_id: ${input.bill_id}`);
  }
  const now = isoNow();
  const row: CommentRow = {
    id: newUlid(),
    bill_id: input.bill_id,
    attached_to_roll_call_id: input.attached_to_roll_call_id ?? null,
    body_markdown: input.body_markdown,
    weight: validateVoteWeight(input.weight ?? 0),
    direction: validateDirectionMultiplier(input.direction ?? 0),
    author_email: ctx.actorEmail,
    created_at: now,
    updated_at: now,
  };
  const stmt = d1
    .prepare(
      `INSERT INTO comments (
         id, bill_id, attached_to_roll_call_id, body_markdown,
         weight, direction, author_email, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id, row.bill_id, row.attached_to_roll_call_id, row.body_markdown,
      row.weight, row.direction, row.author_email, row.created_at, row.updated_at,
    );
  await runMutationWithAudit(d1, ctx, stmt, {
    action: 'create',
    targetTable: 'comments',
    rowId: row.id,
    rowTitle: row.body_markdown.slice(0, 80),
    before: null,
    after: row,
  }, [KV_KEY.comments(row.bill_id)]);
  return row;
}

export async function getComment(d1: D1Like, id: string): Promise<CommentRow | null> {
  return d1.prepare('SELECT * FROM comments WHERE id = ?').bind(id).first<CommentRow>();
}

export interface CommentUpdate {
  body_markdown?: string;
  weight?: number;
  direction?: number;
  attached_to_roll_call_id?: string | null;
}

export async function updateComment(
  d1: D1Like,
  ctx: MutationContext,
  id: string,
  patch: CommentUpdate,
): Promise<CommentRow> {
  const before = await getComment(d1, id);
  if (!before) throw new ValidationError('not_found', `comment not found: ${id}`);
  const after: CommentRow = {
    ...before,
    body_markdown: patch.body_markdown ?? before.body_markdown,
    weight: patch.weight === undefined ? before.weight : validateVoteWeight(patch.weight),
    direction: patch.direction === undefined ? before.direction : validateDirectionMultiplier(patch.direction),
    attached_to_roll_call_id:
      patch.attached_to_roll_call_id === undefined
        ? before.attached_to_roll_call_id
        : patch.attached_to_roll_call_id,
    updated_at: isoNow(),
  };
  const stmt = d1
    .prepare(
      `UPDATE comments SET body_markdown = ?, weight = ?, direction = ?,
         attached_to_roll_call_id = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(after.body_markdown, after.weight, after.direction, after.attached_to_roll_call_id, after.updated_at, id);
  await runMutationWithAudit(d1, ctx, stmt, {
    action: 'update',
    targetTable: 'comments',
    rowId: id,
    rowTitle: after.body_markdown.slice(0, 80),
    before,
    after,
  }, [KV_KEY.comments(after.bill_id)]);
  return after;
}

export async function deleteComment(
  d1: D1Like,
  ctx: MutationContext,
  id: string,
): Promise<void> {
  const before = await getComment(d1, id);
  if (!before) throw new ValidationError('not_found', `comment not found: ${id}`);
  const stmt = d1.prepare('DELETE FROM comments WHERE id = ?').bind(id);
  await runMutationWithAudit(d1, ctx, stmt, {
    action: 'delete',
    targetTable: 'comments',
    rowId: id,
    rowTitle: before.body_markdown.slice(0, 80),
    before,
    after: null,
  }, [KV_KEY.comments(before.bill_id)]);
}

/* -------------------------------------------------------------------------- */
/*                                Social posts                                */
/* -------------------------------------------------------------------------- */

export interface SocialPostCreateInput {
  bioguide_id: string;
  platform: string;
  url: string;
  posted_at?: string | null;
  body_text: string;
  weight?: number;
  direction?: number;
  comment?: string | null;
}

export async function createSocialPost(
  d1: D1Like,
  ctx: MutationContext,
  input: SocialPostCreateInput,
): Promise<SocialPostRow> {
  if (!VALID_PLATFORMS.has(input.platform)) {
    throw new ValidationError('invalid_platform', `platform must be one of ${[...VALID_PLATFORMS].join(', ')}`);
  }
  const safeUrl = sanitizeHttpUrl(input.url);
  if (!safeUrl) throw new ValidationError('invalid_url', 'url must be a valid http(s) URL');
  if (!input.body_text) throw new ValidationError('invalid_body', 'body_text is required');
  const now = isoNow();
  const row: SocialPostRow = {
    id: newUlid(),
    bioguide_id: input.bioguide_id,
    platform: input.platform,
    url: safeUrl,
    posted_at: input.posted_at ?? null,
    body_text: input.body_text,
    weight: validateVoteWeight(input.weight ?? 0),
    direction: validateDirectionMultiplier(input.direction ?? 0),
    comment: input.comment ?? null,
    author_email: ctx.actorEmail,
    created_at: now,
    updated_at: now,
  };
  const stmt = d1
    .prepare(
      `INSERT INTO social_posts (
         id, bioguide_id, platform, url, posted_at, body_text,
         weight, direction, comment, author_email, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id, row.bioguide_id, row.platform, row.url, row.posted_at,
      row.body_text, row.weight, row.direction, row.comment, row.author_email,
      row.created_at, row.updated_at,
    );
  await runMutationWithAudit(d1, ctx, stmt, {
    action: 'create',
    targetTable: 'social_posts',
    rowId: row.id,
    rowTitle: row.body_text.slice(0, 80),
    before: null,
    after: row,
  }, [KV_KEY.socialPosts(row.bioguide_id)]);
  return row;
}

export async function getSocialPost(d1: D1Like, id: string): Promise<SocialPostRow | null> {
  return d1.prepare('SELECT * FROM social_posts WHERE id = ?').bind(id).first<SocialPostRow>();
}

export interface SocialPostUpdate {
  platform?: string;
  url?: string;
  posted_at?: string | null;
  body_text?: string;
  weight?: number;
  direction?: number;
  comment?: string | null;
}

export async function updateSocialPost(
  d1: D1Like,
  ctx: MutationContext,
  id: string,
  patch: SocialPostUpdate,
): Promise<SocialPostRow> {
  const before = await getSocialPost(d1, id);
  if (!before) throw new ValidationError('not_found', `social_post not found: ${id}`);
  if (patch.platform !== undefined && !VALID_PLATFORMS.has(patch.platform)) {
    throw new ValidationError('invalid_platform', 'platform is invalid');
  }
  const after: SocialPostRow = {
    ...before,
    platform: patch.platform ?? before.platform,
    url: patch.url ?? before.url,
    posted_at: patch.posted_at === undefined ? before.posted_at : patch.posted_at,
    body_text: patch.body_text ?? before.body_text,
    weight: patch.weight === undefined ? before.weight : validateVoteWeight(patch.weight),
    direction: patch.direction === undefined ? before.direction : validateDirectionMultiplier(patch.direction),
    comment: patch.comment === undefined ? before.comment : patch.comment,
    updated_at: isoNow(),
  };
  const stmt = d1
    .prepare(
      `UPDATE social_posts SET platform = ?, url = ?, posted_at = ?,
         body_text = ?, weight = ?, direction = ?, comment = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      after.platform, after.url, after.posted_at, after.body_text,
      after.weight, after.direction, after.comment, after.updated_at, id,
    );
  await runMutationWithAudit(d1, ctx, stmt, {
    action: 'update',
    targetTable: 'social_posts',
    rowId: id,
    rowTitle: after.body_text.slice(0, 80),
    before,
    after,
  }, [KV_KEY.socialPosts(after.bioguide_id)]);
  return after;
}

export async function deleteSocialPost(
  d1: D1Like,
  ctx: MutationContext,
  id: string,
): Promise<void> {
  const before = await getSocialPost(d1, id);
  if (!before) throw new ValidationError('not_found', `social_post not found: ${id}`);
  const stmt = d1.prepare('DELETE FROM social_posts WHERE id = ?').bind(id);
  await runMutationWithAudit(d1, ctx, stmt, {
    action: 'delete',
    targetTable: 'social_posts',
    rowId: id,
    rowTitle: before.body_text.slice(0, 80),
    before,
    after: null,
  }, [KV_KEY.socialPosts(before.bioguide_id)]);
}

/* -------------------------------------------------------------------------- */
/*                                   Quotes                                   */
/* -------------------------------------------------------------------------- */

export interface QuoteCreateInput {
  bioguide_id: string;
  media_kind: string;
  source_url: string;
  source_label?: string | null;
  quoted_at?: string | null;
  body_text: string;
  weight?: number;
  direction?: number;
  comment?: string | null;
  /** Optional ancillary links: array of {label, url}. Stored as JSON. */
  links?: Array<{ label: string; url: string }> | null;
  /** Optional tag IDs to apply on create. Each must exist in `tags`. */
  tag_ids?: string[];
}

export async function createQuote(
  d1: D1Like,
  ctx: MutationContext,
  input: QuoteCreateInput,
): Promise<QuoteRow> {
  if (!VALID_MEDIA_KINDS.has(input.media_kind)) {
    throw new ValidationError('invalid_media_kind', `media_kind must be one of ${[...VALID_MEDIA_KINDS].join(', ')}`);
  }
  if (!input.source_url) throw new ValidationError('invalid_source_url', 'source_url is required');
  if (!input.body_text) throw new ValidationError('invalid_body', 'body_text is required');

  // Duplicate check: same source URL + bioguide = same quote.
  const existing = await d1
    .prepare('SELECT id, weight, direction FROM quotes WHERE source_url = ? AND bioguide_id = ?')
    .bind(input.source_url, input.bioguide_id)
    .first<{ id: string; weight: number; direction: number }>();
  if (existing) {
    throw new ValidationError(
      'duplicate_source',
      `This URL has already been added for this person (quote ${existing.id}, weight ${existing.weight}, direction ${existing.direction > 0 ? 'pro' : existing.direction < 0 ? 'anti' : 'unstated'})`,
    );
  }
  const now = isoNow();
  const linksJson = input.links && input.links.length > 0 ? JSON.stringify(input.links) : null;
  const row: QuoteRow = {
    id: newUlid(),
    bioguide_id: input.bioguide_id,
    media_kind: input.media_kind,
    source_url: input.source_url,
    source_label: input.source_label ?? null,
    quoted_at: input.quoted_at ?? null,
    body_text: input.body_text,
    weight: validateVoteWeight(input.weight ?? 0),
    direction: validateDirectionMultiplier(input.direction ?? 0),
    comment: input.comment ?? null,
    links_json: linksJson,
    author_email: ctx.actorEmail,
    created_at: now,
    updated_at: now,
  };
  const stmt = d1
    .prepare(
      `INSERT INTO quotes (
         id, bioguide_id, media_kind, source_url, source_label, quoted_at,
         body_text, weight, direction, comment, links_json, author_email,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id, row.bioguide_id, row.media_kind, row.source_url, row.source_label,
      row.quoted_at, row.body_text, row.weight, row.direction, row.comment,
      row.links_json, row.author_email, row.created_at, row.updated_at,
    );
  await runMutationWithAudit(d1, ctx, stmt, {
    action: 'create',
    targetTable: 'quotes',
    rowId: row.id,
    rowTitle: row.body_text.slice(0, 80),
    before: null,
    after: row,
  }, [KV_KEY.quotes(row.bioguide_id)]);

  // Apply tags (if any). Best-effort — failures don't roll back the quote;
  // researcher can re-tag from the UI.
  if (input.tag_ids && input.tag_ids.length > 0) {
    for (const tagId of input.tag_ids) {
      try {
        await d1
          .prepare(
            `INSERT OR IGNORE INTO quote_tags (quote_id, tag_id, applied_at, applied_by)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(row.id, tagId, now, ctx.actorEmail)
          .run();
      } catch {
        // Tag may have been deleted between client load and submit; skip silently.
      }
    }
  }

  return row;
}

export async function getQuote(d1: D1Like, id: string): Promise<QuoteRow | null> {
  return d1.prepare('SELECT * FROM quotes WHERE id = ?').bind(id).first<QuoteRow>();
}

/** List quotes, optionally filtered by bioguide_id. Newest first. */
export async function listQuotes(
  d1: D1Like,
  opts: { bioguideId?: string; limit?: number; offset?: number } = {},
): Promise<QuoteRow[]> {
  const limit = Math.min(opts.limit ?? 100, 250);
  const offset = opts.offset ?? 0;
  if (opts.bioguideId) {
    const result = await d1
      .prepare('SELECT * FROM quotes WHERE bioguide_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .bind(opts.bioguideId, limit, offset)
      .all<QuoteRow>();
    return result.results ?? [];
  }
  const result = await d1
    .prepare('SELECT * FROM quotes ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .bind(limit, offset)
    .all<QuoteRow>();
  return result.results ?? [];
}

export interface QuoteUpdate {
  media_kind?: string;
  source_url?: string;
  source_label?: string | null;
  quoted_at?: string | null;
  body_text?: string;
  weight?: number;
  direction?: number;
  comment?: string | null;
}

export async function updateQuote(
  d1: D1Like,
  ctx: MutationContext,
  id: string,
  patch: QuoteUpdate,
): Promise<QuoteRow> {
  const before = await getQuote(d1, id);
  if (!before) throw new ValidationError('not_found', `quote not found: ${id}`);
  if (patch.media_kind !== undefined && !VALID_MEDIA_KINDS.has(patch.media_kind)) {
    throw new ValidationError('invalid_media_kind', 'media_kind is invalid');
  }
  const after: QuoteRow = {
    ...before,
    media_kind: patch.media_kind ?? before.media_kind,
    source_url: patch.source_url ?? before.source_url,
    source_label: patch.source_label === undefined ? before.source_label : patch.source_label,
    quoted_at: patch.quoted_at === undefined ? before.quoted_at : patch.quoted_at,
    body_text: patch.body_text ?? before.body_text,
    weight: patch.weight === undefined ? before.weight : validateVoteWeight(patch.weight),
    direction: patch.direction === undefined ? before.direction : validateDirectionMultiplier(patch.direction),
    comment: patch.comment === undefined ? before.comment : patch.comment,
    updated_at: isoNow(),
  };
  const stmt = d1
    .prepare(
      `UPDATE quotes SET media_kind = ?, source_url = ?, source_label = ?,
         quoted_at = ?, body_text = ?, weight = ?, direction = ?, comment = ?,
         updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      after.media_kind, after.source_url, after.source_label, after.quoted_at,
      after.body_text, after.weight, after.direction, after.comment, after.updated_at, id,
    );
  await runMutationWithAudit(d1, ctx, stmt, {
    action: 'update',
    targetTable: 'quotes',
    rowId: id,
    rowTitle: after.body_text.slice(0, 80),
    before,
    after,
  }, [KV_KEY.quotes(after.bioguide_id)]);
  return after;
}

export async function deleteQuote(
  d1: D1Like,
  ctx: MutationContext,
  id: string,
): Promise<void> {
  const before = await getQuote(d1, id);
  if (!before) throw new ValidationError('not_found', `quote not found: ${id}`);
  const stmt = d1.prepare('DELETE FROM quotes WHERE id = ?').bind(id);
  await runMutationWithAudit(d1, ctx, stmt, {
    action: 'delete',
    targetTable: 'quotes',
    rowId: id,
    rowTitle: before.body_text.slice(0, 80),
    before,
    after: null,
  }, [KV_KEY.quotes(before.bioguide_id)]);
}

/* -------------------------------------------------------------------------- */
/*                                  Audit log                                 */
/* -------------------------------------------------------------------------- */

export async function listAudit(
  d1: D1Like,
  opts: { limit?: number; since?: string } = {},
): Promise<AuditRow[]> {
  const limit = Math.min(opts.limit ?? 50, 100);
  let stmt: D1PreparedStatementLike;
  if (opts.since) {
    stmt = d1
      .prepare('SELECT * FROM audit_log WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?')
      .bind(opts.since, limit);
  } else {
    stmt = d1
      .prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?')
      .bind(limit);
  }
  const result = await stmt.all<AuditRow>();
  return result.results ?? [];
}

/* -------------------------------------------------------------------------- */
/*                              Re-export utilities                           */
/* -------------------------------------------------------------------------- */

export { isUlid, newUlid };
