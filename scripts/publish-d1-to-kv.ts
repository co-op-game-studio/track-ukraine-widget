#!/usr/bin/env tsx
/**
 * D1 → KV publish pipeline (FR-51).
 *
 * Reads the editable D1 tables, projects them into the FR-32 + FR-51 KV
 * record shapes, diff-skips unchanged keys, writes the rest. Emits:
 *   bill:v1:{bill_id}                  (per FR-32 AC-32.2)
 *   comment:v1:{bill_id}               (per AC-51.4)
 *   social-post:v1:{bioguide_id}       (per AC-51.5)
 *   quote:v1:{bioguide_id}             (per AC-51.6)
 *   stats:v1:summary                   (per FR-56)
 *   audit-feed:v1:full                 (full audit projection)
 *   audit-feed:v1:public               (redacted, AC-58.2)
 *
 * Usage:
 *   tsx scripts/publish-d1-to-kv.ts --env <dev|uat|stg|prod> [--dry-run]
 *
 * Pure projection helpers are exported and unit-tested. The wrangler
 * shell-out reads D1 via `wrangler d1 execute --json` and writes KV via
 * `wrangler kv bulk put`.
 *
 * Traces to FR-51, FR-56, FR-58, ADR-017.
 */
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { resolveRuntime } from './lib/runtime';
import type { D1Like } from './lib/d1-client';

// AC-52.51 — projection logic + types live in `proxy/services/kv-projector.ts`
// so the read-through fallthrough on /api/bills (etc) and this manual warmer
// share one implementation. Re-exported below for backward compatibility with
// existing test imports.
import {
  projectBill as _projectBill,
  projectComments as _projectComments,
  projectSocialPosts as _projectSocialPosts,
  projectQuotes as _projectQuotes,
  type D1Bill as _D1Bill,
  type D1Vote as _D1Vote,
  type D1Comment as _D1Comment,
  type D1SocialPost as _D1SocialPost,
  type D1Quote as _D1Quote,
  type BillKvRecord as _BillKvRecord,
  type CommentKvRecord as _CommentKvRecord,
  type SocialPostKvRecord as _SocialPostKvRecord,
  type QuoteKvRecord as _QuoteKvRecord,
} from '../proxy/services/kv-projector';

export type D1Bill = _D1Bill;
export type D1Vote = _D1Vote;
export type D1Comment = _D1Comment;
export type D1SocialPost = _D1SocialPost;
export type D1Quote = _D1Quote;
export type BillKvRecord = _BillKvRecord;
export type CommentKvRecord = _CommentKvRecord;
export type SocialPostKvRecord = _SocialPostKvRecord;
export type QuoteKvRecord = _QuoteKvRecord;
export const projectBill = _projectBill;
export const projectComments = _projectComments;
export const projectSocialPosts = _projectSocialPosts;
export const projectQuotes = _projectQuotes;

import {
  projectMemberProfile,
  projectStateMembers,
  projectNameIndex,
  projectRosters,
  type MemberRow,
  type VoteCastRow,
} from './lib/members/project';

/* -------------------------------------------------------------------------- */
/*                          D1 row + KV record types                          */
/* -------------------------------------------------------------------------- */
/* D1Bill / D1Vote / D1Comment / D1SocialPost / D1Quote re-exported from
 * `proxy/services/kv-projector.ts` at the top of the file. */

export interface D1Audit {
  id: string;
  actor_email: string;
  action: string;
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
/*                        Output KV record shapes                             */
/* -------------------------------------------------------------------------- */

/* BillKvRecord / CommentKvRecord / SocialPostKvRecord / QuoteKvRecord
 * re-exported from `proxy/services/kv-projector.ts` at the top of the file. */

export interface StatsKvRecord {
  generatedAt: string;
  schemaVersion: 1;
  perBill: Array<{
    billId: string;
    voteCount: number;
    weightTotal: number;
    directionPro: number;
    directionAnti: number;
  }>;
  commentsTimeseries: Array<{ date: string; count: number }>;
  /**
   * FR-56 AC-56.1 — score-derived fields. Written by
   * `scripts/compute-party-priors.ts` via read-modify-write on top of the
   * record this script produces. Optional on the type because the base
   * publish run (`publish-d1-to-kv`) doesn't compute them; the priors
   * script overlays them in the second step of the publish workflow.
   */
  perRepHistogram?: { buckets: number[]; counts: number[] };
  topAntiUkraine?: Array<{ bioguideId: string; displayName: string; score: number; weightedAntiActions: number }>;
  partyPriors?: Record<string, number | null>;
}

export interface AuditFeedKvRecord {
  generatedAt: string;
  schemaVersion: 1;
  items: Array<unknown>;
}

/* -------------------------------------------------------------------------- */
/*                              Pure projections                              */
/* -------------------------------------------------------------------------- */

/** Stable JSON.stringify with alphabetical keys — byte-identical across runs. */
export function canonicalJson(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = sortKeys((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sortKeys(value));
}

/* projectBill / projectComments / projectSocialPosts / projectQuotes
 * re-exported from `proxy/services/kv-projector.ts` at the top of the file. */

export function projectStats(
  bills: D1Bill[],
  votes: D1Vote[],
  comments: D1Comment[],
  generatedAt: string,
): StatsKvRecord {
  const byBill = new Map<string, D1Vote[]>();
  for (const v of votes) {
    if (!byBill.has(v.bill_id)) byBill.set(v.bill_id, []);
    byBill.get(v.bill_id)!.push(v);
  }
  const perBill = bills
    .map((b) => {
      const vs = byBill.get(b.bill_id) ?? [];
      const weightTotal = vs.reduce((acc, v) => acc + v.weight, 0);
      const directionPro = b.direction === 'pro-ukraine' ? vs.length : 0;
      const directionAnti = b.direction === 'anti-ukraine' ? vs.length : 0;
      return {
        billId: b.bill_id,
        voteCount: vs.length,
        weightTotal,
        directionPro,
        directionAnti,
      };
    })
    .sort((a, b) => a.billId.localeCompare(b.billId));

  // Comments over the last 90 days, bucketed by ISO date.
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dayBuckets = new Map<string, number>();
  for (const c of comments.filter(c => c.created_at.slice(0, 10) >= cutoff)) {
    const day = c.created_at.slice(0, 10);
    dayBuckets.set(day, (dayBuckets.get(day) ?? 0) + 1);
  }
  const commentsTimeseries = [...dayBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

  return { generatedAt, schemaVersion: 1, perBill, commentsTimeseries };
}

/** Public audit feed redacts before/after/reason and strips email domain.
 *  Sort: created_at DESC, with audit-row ULID DESC as a deterministic
 *  tiebreaker — ULIDs are time-sortable so two rows in the same
 *  millisecond still come out newest-first. */
export function projectAuditFeedPublic(
  audits: D1Audit[],
  generatedAt: string,
  limit = 50,
): AuditFeedKvRecord {
  const sorted = [...audits]
    .sort((a, b) => {
      const c = b.created_at.localeCompare(a.created_at);
      return c !== 0 ? c : b.id.localeCompare(a.id);
    })
    .slice(0, limit);
  const items = sorted.map((r) => ({
    id: r.id,
    actorLocalPart: r.actor_email.split('@')[0] ?? r.actor_email,
    action: r.action,
    table: r.target_table,
    rowTitle: r.row_title,
    createdAt: r.created_at,
  }));
  return { generatedAt, schemaVersion: 1, items };
}

/**
 * Authenticated audit projection (FR-58 AC-58.1, AC-58.3, AC-58.6).
 *
 * Field-naming choice: snake_case matches the D1 column names and AC-58.1
 * spec verbatim. `handleAudit` returns this projection unchanged from KV;
 * researchers and ops queries rely on the consistency between D1 schema,
 * KV record, and API response.
 *
 * Contrast with the public projection (AC-58.2) which deliberately uses
 * camelCase + a shorter set of fields.
 */
export function projectAuditFeedFull(
  audits: D1Audit[],
  generatedAt: string,
  limit = 100,
): AuditFeedKvRecord {
  const sorted = [...audits]
    .sort((a, b) => {
      const c = b.created_at.localeCompare(a.created_at);
      return c !== 0 ? c : b.id.localeCompare(a.id);
    })
    .slice(0, limit);
  const items = sorted.map((r) => ({
    id: r.id,
    actor_email: r.actor_email,
    action: r.action,
    target_table: r.target_table,
    row_id: r.row_id,
    row_title: r.row_title,
    before: r.before_json ? JSON.parse(r.before_json) : null,
    after: r.after_json ? JSON.parse(r.after_json) : null,
    reason: r.reason,
    trace_id: r.trace_id,
    created_at: r.created_at,
  }));
  return { generatedAt, schemaVersion: 1, items };
}

/* -------------------------------------------------------------------------- */
/*                              Plan + diff logic                             */
/* -------------------------------------------------------------------------- */

export interface KvWritePlan {
  /** Map of `prefix+key` → canonical JSON to write. */
  writes: Map<string, string>;
}

export interface PublishInputs {
  bills: D1Bill[];
  votes: D1Vote[];
  comments: D1Comment[];
  posts: D1SocialPost[];
  quotes: D1Quote[];
  audits: D1Audit[];
  /** FR-32 AC-32.40 — durable member identity + casts, projected into
   *  member:v1: / state-members:v1: / name-index:v1: / roll-call-roster:v1:.
   *  Optional so existing callers/tests that don't pass them still work. */
  members?: MemberRow[];
  voteCasts?: VoteCastRow[];
  generatedAt: string;
}

/** Build the full KV write plan from D1 row sets. Pure function. */
export function buildPublishPlan(inputs: PublishInputs): KvWritePlan {
  const writes = new Map<string, string>();
  const { bills, votes, comments, posts, quotes, audits, generatedAt } = inputs;

  // Group votes by bill_id.
  const votesByBill = new Map<string, D1Vote[]>();
  for (const v of votes) {
    if (!votesByBill.has(v.bill_id)) votesByBill.set(v.bill_id, []);
    votesByBill.get(v.bill_id)!.push(v);
  }
  for (const b of bills) {
    const billVotes = votesByBill.get(b.bill_id) ?? [];
    writes.set(`bill:v1:${b.bill_id}`, canonicalJson(projectBill(b, billVotes, generatedAt)));
    // roll-call:v1:{chamber}:{c}:{s}:{rc} — immutable per-roll-call metadata,
    // read by /api/roll-calls + the rep bundle. Projected from D1 votes+bill.
    for (const v of billVotes) {
      const rollCallId = `${v.chamber.toLowerCase()}:${v.congress}:${v.session}:${v.roll_call}`;
      writes.set(`roll-call:v1:${rollCallId}`, canonicalJson({
        rollCallId,
        chamber: v.chamber,
        congress: v.congress,
        session: v.session,
        rollCall: v.roll_call,
        date: v.date,
        action: v.action ?? null,
        weight: v.weight,
        billId: b.bill_id,
        billTitle: b.title,
        generatedAt,
        schemaVersion: 1,
      }));
    }
  }

  // Group comments by bill_id.
  const commentsByBill = new Map<string, D1Comment[]>();
  for (const c of comments) {
    if (!commentsByBill.has(c.bill_id)) commentsByBill.set(c.bill_id, []);
    commentsByBill.get(c.bill_id)!.push(c);
  }
  for (const [billId, group] of commentsByBill) {
    writes.set(`comment:v1:${billId}`, canonicalJson(projectComments(billId, group, generatedAt)));
  }

  // Posts by bioguide.
  const postsByBio = new Map<string, D1SocialPost[]>();
  for (const p of posts) {
    if (!postsByBio.has(p.bioguide_id)) postsByBio.set(p.bioguide_id, []);
    postsByBio.get(p.bioguide_id)!.push(p);
  }
  for (const [bg, group] of postsByBio) {
    writes.set(`social-post:v1:${bg}`, canonicalJson(projectSocialPosts(bg, group, generatedAt)));
  }

  // Quotes by bioguide.
  const quotesByBio = new Map<string, D1Quote[]>();
  for (const q of quotes) {
    if (!quotesByBio.has(q.bioguide_id)) quotesByBio.set(q.bioguide_id, []);
    quotesByBio.get(q.bioguide_id)!.push(q);
  }
  for (const [bg, group] of quotesByBio) {
    writes.set(`quote:v1:${bg}`, canonicalJson(projectQuotes(bg, group, generatedAt)));
  }

  // Stats + audit feeds (always present).
  writes.set('stats:v1:summary', canonicalJson(projectStats(bills, votes, comments, generatedAt)));
  writes.set('audit-feed:v1:public', canonicalJson(projectAuditFeedPublic(audits, generatedAt)));
  writes.set('audit-feed:v1:full', canonicalJson(projectAuditFeedFull(audits, generatedAt)));

  // FR-32 AC-32.40 — member-derived prefixes, projected from the durable
  // `members` + `vote_casts` tables (no upstream fetch).
  const members = inputs.members ?? [];
  if (members.length > 0) {
    for (const m of members) {
      writes.set(`member:v1:${m.bioguide_id}`, canonicalJson(projectMemberProfile(m, generatedAt)));
    }
    for (const [state, rec] of projectStateMembers(members, generatedAt)) {
      writes.set(`state-members:v1:${state}`, canonicalJson(rec));
    }
    const { shards, meta } = projectNameIndex(members, generatedAt);
    for (const [letter, shard] of shards) {
      writes.set(`name-index:v1:${letter}`, canonicalJson(shard));
    }
    writes.set('name-index:v1:meta', canonicalJson(meta));
  }
  for (const [key, rec] of projectRosters(inputs.voteCasts ?? [], generatedAt)) {
    writes.set(key, canonicalJson(rec));
  }

  return { writes };
}

/** Diff plan against current KV state — return only keys that need updating. */
export function diffPlan(
  plan: KvWritePlan,
  currentValues: Map<string, string>,
): { changed: Map<string, string>; unchanged: number } {
  const changed = new Map<string, string>();
  let unchanged = 0;
  for (const [key, val] of plan.writes) {
    if (currentValues.get(key) === val) {
      unchanged++;
    } else {
      changed.set(key, val);
    }
  }
  return { changed, unchanged };
}

/* -------------------------------------------------------------------------- */
/*                              Wrangler shell-out                            */
/* -------------------------------------------------------------------------- */


function generateRunTraceId(): string {
  const hex = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return `tr_${hex}`;
}

/** Per AC-49.4 prose / wrangler.toml structure, prod is the top-level config
 *  (no `[env.prod]` section); dev/uat/stg are env-scoped. The flag varies. */
function envFlag(env: string): string {
  return env === 'prod' ? '' : `--env ${env}`;
}

/**
 * Read a table via the typed D1 REST client (no `wrangler` subprocess / stdout
 * parsing). This replaced the prior execSync-based reader, which scraped CLI
 * stdout and was capped by execSync's 1MB maxBuffer — a large `SELECT * FROM
 * vote_casts` overflowed it and the failure was silently swallowed into an
 * empty result, shipping a gutted KV (v4.1.2 incident). The REST client returns
 * full result sets with structured errors. (KV writes still shell out to
 * `wrangler kv bulk put` below — that path is unaffected by this read fix.)
 */
async function d1Query<T>(d1: D1Like, sql: string): Promise<T[]> {
  const res = await d1.prepare(sql).all<T>();
  return res.results ?? [];
}

/**
 * True only for a "table does not exist" error (a pre-migration env where the
 * table hasn't been created yet). Everything else — network failure, auth/5xx,
 * malformed JSON — is a REAL failure that must not be swallowed. AC-32.44.
 */
export function isMissingTableError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // SQLite/D1 phrasing: "no such table: members" / "table ... does not exist".
  return /no such table/.test(msg) || /does not exist/.test(msg);
}

/**
 * d1Query that tolerates ONLY a missing table (pre-migration env → []). Any
 * other read error PROPAGATES so publish aborts loudly rather than projecting a
 * hollow KV from an empty result set (AC-32.44).
 */
export async function safeD1Query<T>(d1: D1Like, sql: string): Promise<T[]> {
  try {
    return await d1Query<T>(d1, sql);
  } catch (err) {
    if (isMissingTableError(err)) {
      console.warn(`[publish-d1] table missing, skipping (${sql}): ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
    // Real failure (network, auth, 5xx, parse) — do NOT swallow; a silent
    // empty result would ship a gutted cache.
    throw err;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const getArg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const env = getArg('--env');
  const dryRun = argv.includes('--dry-run');
  if (!env || !['dev', 'uat', 'stg', 'prod'].includes(env)) {
    console.error('Usage: tsx scripts/publish-d1-to-kv.ts --env <dev|uat|stg|prod> [--dry-run]');
    process.exit(2);
  }
  const traceId = generateRunTraceId();
  const generatedAt = new Date().toISOString();
  console.log(`[publish-d1] env=${env} trace=${traceId}`);

  console.log('[publish-d1] reading D1…');
  // Typed REST D1 client (no wrangler subprocess / stdout scraping).
  const { d1 } = resolveRuntime({ env });
  const bills = await d1Query<D1Bill>(d1, 'SELECT * FROM bills');
  const votes = await d1Query<D1Vote>(d1, 'SELECT * FROM votes');
  const comments = await d1Query<D1Comment>(d1, 'SELECT * FROM comments');
  const posts = await d1Query<D1SocialPost>(d1, 'SELECT * FROM social_posts');
  const quotes = await d1Query<D1Quote>(d1, 'SELECT * FROM quotes');
  const audits = await d1Query<D1Audit>(d1, 'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200');
  // FR-32 AC-32.40 — durable member identity + casts (tables may not exist on
  // older envs pre-migration; tolerate a missing table as empty, fail loud on
  // any other read error — AC-32.44).
  const members = await safeD1Query<MemberRow>(d1, 'SELECT * FROM members');
  const voteCasts = await safeD1Query<VoteCastRow>(d1, 'SELECT * FROM vote_casts');
  console.log(
    `[publish-d1] loaded bills=${bills.length} votes=${votes.length} ` +
      `comments=${comments.length} posts=${posts.length} quotes=${quotes.length} audits=${audits.length} ` +
      `members=${members.length} voteCasts=${voteCasts.length}`,
  );

  const plan = buildPublishPlan({
    bills,
    votes,
    comments,
    posts,
    quotes,
    audits,
    members,
    voteCasts,
    generatedAt,
  });
  console.log(`[publish-d1] plan: ${plan.writes.size} keys`);

  if (dryRun) {
    for (const k of plan.writes.keys()) console.log(`  would write: ${k}`);
    console.log('[publish-d1] --dry-run — done.');
    return;
  }

  // Write all keys via `wrangler kv bulk put`.
  const tmp = mkdtempSync(join(tmpdir(), 'publish-d1-'));
  const payload = [...plan.writes.entries()].map(([key, value]) => ({ key, value }));
  const payloadPath = join(tmp, 'kv-payload.json');
  writeFileSync(payloadPath, JSON.stringify(payload), 'utf8');
  console.log(`[publish-d1] wrote payload to ${payloadPath} (${payload.length} keys)`);
  const cmd = `npx wrangler kv bulk put --binding KV_VOTER_INFO ${envFlag(env)} --remote --config ./wrangler.toml ${payloadPath}`;
  console.log(`[publish-d1] $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
  console.log(`[publish-d1] done.`);
}

const invokedPath = process.argv[1] ?? '';
const isMain =
  import.meta.url.endsWith(invokedPath.replace(/\\/g, '/').split('/').pop() ?? '') &&
  invokedPath.endsWith('publish-d1-to-kv.ts');
if (isMain) {
  main().catch((err) => {
    console.error('[publish-d1] failed:', err);
    process.exit(1);
  });
}
