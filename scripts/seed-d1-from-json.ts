#!/usr/bin/env tsx
/**
 * One-time bootstrap: read src/data/ukraineBills.json, INSERT bills + nested
 * votes into D1 (`viw_researcher_<env>`).
 *
 * Idempotent: uses INSERT OR IGNORE so re-running adds zero rows once seeded.
 * Stamps audit_log rows with actor='seed', reason='bootstrap from ukraineBills.json',
 * and a per-run trace ID so a Logpush query can return the full seed thread.
 *
 * Usage:
 *   tsx scripts/seed-d1-from-json.ts --env <dev|uat|stg|prod> [--dry-run]
 *
 * Pure transformation (JSON → SQL) is exported and unit-tested separately;
 * the wrangler shell-out is best-effort and tested by smoke.
 *
 * Traces to FR-49 AC-49.3, ADR-017.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { newUlid } from '../src/utils/ulid';

// Per-run trace ID — same shape as runtime FR-36 trace IDs (`tr_<16hex>`)
// so Logpush queries treat them uniformly.
function generateRunTraceId(): string {
  const hex = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return `tr_${hex}`;
}

/* -------------------------------------------------------------------------- */
/*                          Source JSON shape                                 */
/* -------------------------------------------------------------------------- */

interface CuratedBillJson {
  congress: number;
  type: string;
  number: string;
  featured?: boolean;
  label?: string;
  title: string;
  latestAction?: string;
  latestActionDate?: string;
  becameLaw?: boolean;
  congressGovUrl?: string;
  direction: string;
  directionReason?: string;
  summary?: unknown;
  votes?: CuratedVoteJson[];
}

interface CuratedVoteJson {
  chamber: 'House' | 'Senate';
  congress: number;
  session: number;
  rollCall: number;
  date: string;
  url?: string;
  action?: string;
  actionDate?: string;
  weight: number;
  directionMultiplier: number;
  kind: string;
}

/* -------------------------------------------------------------------------- */
/*                         Pure transformation                                */
/* -------------------------------------------------------------------------- */

/** Compose the FR-32 bill_id key from congress/type/number. */
export function billKey(b: { congress: number; type: string; number: string }): string {
  return `${b.congress}-${b.type}-${b.number}`;
}

/** Escape a SQL string literal — single-quote SQLite/D1 dialect. */
export function sqlString(v: string | null | undefined): string {
  if (v === null || v === undefined) return 'NULL';
  return `'${v.replace(/'/g, "''")}'`;
}

export function sqlNumber(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'NULL';
  if (!Number.isFinite(v)) return 'NULL';
  return String(v);
}

export function sqlBool(v: boolean | undefined): string {
  return v ? '1' : '0';
}

export interface SeedSqlOptions {
  isoNow: string;
  traceId: string;
  /** Override ULID generation for deterministic tests. */
  newId?: () => string;
}

/** D1 statement-size cap is ~100 KB; we cap summary_json well below that to
 *  leave room for surrounding INSERT bindings. AC-49.7. */
const SUMMARY_JSON_MAX_BYTES = 8 * 1024;
const TRUNCATION_MARKER = '… [truncated; full summary at congress_gov_url]';

/** AC-49.8 — pre-V4 curator JSON used "manual override" as a default
 *  direction-reason on most bills. The string carries no editorial
 *  meaning; treating it as data clutters the admin UI. Filtered to NULL. */
export function filterDirectionReason(raw: string | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.toLowerCase() === 'manual override') return null;
  return trimmed;
}

/**
 * Truncate a summary blob to fit AC-49.7's 8 KB budget. Preserves
 * actionDate / actionDesc / updateDate verbatim; trims `text` to fit.
 * Returns null when input is null / undefined.
 */
export function truncateSummary(summary: unknown): string | null {
  if (summary === null || summary === undefined) return null;
  const serialized = JSON.stringify(summary);
  if (serialized.length <= SUMMARY_JSON_MAX_BYTES) return serialized;
  // Too big — preserve the metadata fields, truncate the `text` field.
  if (typeof summary === 'object' && summary !== null) {
    const obj = summary as Record<string, unknown>;
    const meta: Record<string, unknown> = {};
    for (const k of ['actionDate', 'actionDesc', 'updateDate']) {
      if (k in obj) meta[k] = obj[k];
    }
    const metaJson = JSON.stringify({ ...meta, text: '' });
    // Budget for `text`: total cap minus the meta scaffold + truncation marker.
    const budget = SUMMARY_JSON_MAX_BYTES - metaJson.length - TRUNCATION_MARKER.length - 8;
    const text = typeof obj['text'] === 'string' ? obj['text'] : '';
    const truncatedText = text.slice(0, Math.max(0, budget)) + TRUNCATION_MARKER;
    return JSON.stringify({ ...meta, text: truncatedText });
  }
  // Non-object summary that's still too big — slice the JSON string itself.
  return serialized.slice(0, SUMMARY_JSON_MAX_BYTES - TRUNCATION_MARKER.length) +
    TRUNCATION_MARKER;
}

/**
 * Transform a curated-bills JSON document into a D1-ready SQL script.
 * Idempotent via INSERT OR IGNORE on the unique keys (`bill_id` for bills,
 * `(chamber,congress,session,roll_call)` for votes).
 *
 * Audit rows are stamped with actor='seed' and the run trace ID. Audit IDs
 * use newUlid() unless `newId` is overridden for test determinism.
 */
export function buildSeedSql(
  bills: CuratedBillJson[],
  opts: SeedSqlOptions,
): string {
  const lines: string[] = [];
  const newId = opts.newId ?? newUlid;
  lines.push('-- Generated by scripts/seed-d1-from-json.ts');
  lines.push(`-- Run trace: ${opts.traceId}`);
  lines.push("INSERT OR IGNORE INTO researchers (email, display_name, created_at)");
  lines.push(
    `  VALUES ('seed', 'Bootstrap seed', ${sqlString(opts.isoNow)});`,
  );
  for (const b of bills) {
    const billId = billKey(b);
    const billRowId = newId();
    // AC-49.7 — summary truncated to fit D1's per-statement size cap.
    const summaryJson = truncateSummary(b.summary);
    lines.push(
      `INSERT OR IGNORE INTO bills (
         id, bill_id, congress, type, number, featured, label, title,
         latest_action, latest_action_date, became_law, congress_gov_url,
         direction, direction_reason, summary_json, created_at, updated_at
       ) VALUES (
         ${sqlString(billRowId)},
         ${sqlString(billId)},
         ${sqlNumber(b.congress)},
         ${sqlString(b.type)},
         ${sqlString(b.number)},
         ${sqlBool(b.featured)},
         ${sqlString(b.label ?? null)},
         ${sqlString(b.title)},
         ${sqlString(b.latestAction ?? null)},
         ${sqlString(b.latestActionDate ?? null)},
         ${sqlBool(b.becameLaw)},
         ${sqlString(b.congressGovUrl ?? null)},
         ${sqlString(b.direction)},
         ${sqlString(filterDirectionReason(b.directionReason))},
         ${sqlString(summaryJson)},
         ${sqlString(opts.isoNow)},
         ${sqlString(opts.isoNow)}
       );`,
    );
    // Audit row for the bill (only fires when the INSERT actually inserted —
    // SQLite's INSERT OR IGNORE doesn't expose changes() inline, so on a
    // re-run the audit row may also be inserted-or-ignored via a unique
    // pseudo-key. For simplicity: include the row but make the audit_log
    // INSERT also OR IGNORE on a deterministic ID derived from row_id +
    // action so re-runs are no-ops).
    lines.push(
      `INSERT OR IGNORE INTO audit_log (
         id, actor_email, action, target_table, row_id, row_title,
         before_json, after_json, reason, trace_id, created_at
       ) VALUES (
         ${sqlString('seed-bills-' + billId)},
         'seed',
         'create',
         'bills',
         ${sqlString(billRowId)},
         ${sqlString(b.title)},
         NULL,
         NULL,
         'bootstrap from ukraineBills.json',
         ${sqlString(opts.traceId)},
         ${sqlString(opts.isoNow)}
       );`,
    );
    for (const v of b.votes ?? []) {
      const voteRowId = newId();
      lines.push(
        `INSERT OR IGNORE INTO votes (
           id, bill_id, chamber, congress, session, roll_call, date, url,
           action, action_date, weight, direction_multiplier, kind,
           created_at, updated_at
         ) VALUES (
           ${sqlString(voteRowId)},
           ${sqlString(billId)},
           ${sqlString(v.chamber)},
           ${sqlNumber(v.congress)},
           ${sqlNumber(v.session)},
           ${sqlNumber(v.rollCall)},
           ${sqlString(v.date)},
           ${sqlString(v.url ?? null)},
           ${sqlString(v.action ?? null)},
           ${sqlString(v.actionDate ?? null)},
           ${sqlNumber(v.weight)},
           ${sqlNumber(v.directionMultiplier)},
           ${sqlString(v.kind)},
           ${sqlString(opts.isoNow)},
           ${sqlString(opts.isoNow)}
         );`,
      );
      const voteAuditId = `seed-votes-${v.chamber}-${v.congress}-${v.session}-${v.rollCall}`;
      lines.push(
        `INSERT OR IGNORE INTO audit_log (
           id, actor_email, action, target_table, row_id, row_title,
           before_json, after_json, reason, trace_id, created_at
         ) VALUES (
           ${sqlString(voteAuditId)},
           'seed',
           'create',
           'votes',
           ${sqlString(voteRowId)},
           ${sqlString(`${billId} / ${v.chamber} roll ${v.rollCall}`)},
           NULL,
           NULL,
           'bootstrap from ukraineBills.json',
           ${sqlString(opts.traceId)},
           ${sqlString(opts.isoNow)}
         );`,
      );
    }
  }
  return lines.join('\n') + '\n';
}

/* -------------------------------------------------------------------------- */
/*                              Main (CLI entry)                              */
/* -------------------------------------------------------------------------- */

async function main() {
  const argv = process.argv.slice(2);
  const getArg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const env = getArg('--env');
  const dryRun = argv.includes('--dry-run');
  if (!env || !['dev', 'uat', 'stg', 'prod'].includes(env)) {
    console.error('Usage: tsx scripts/seed-d1-from-json.ts --env <dev|uat|stg|prod> [--dry-run]');
    process.exit(2);
  }
  const traceId = generateRunTraceId();

  const sourcePath = resolve('src/data/ukraineBills.json');
  const json = JSON.parse(readFileSync(sourcePath, 'utf8')) as CuratedBillJson[];
  const sql = buildSeedSql(json, {
    isoNow: new Date().toISOString(),
    traceId,
  });
  console.log(`[seed-d1] env=${env} trace=${traceId} bills=${json.length}`);
  console.log(`[seed-d1] generated ${sql.split('\n').length} SQL lines`);

  const tmp = mkdtempSync(join(tmpdir(), 'seed-d1-'));
  const sqlPath = join(tmp, 'seed.sql');
  writeFileSync(sqlPath, sql, 'utf8');
  console.log(`[seed-d1] wrote ${sqlPath}`);

  if (dryRun) {
    console.log('[seed-d1] --dry-run — not invoking wrangler.');
    return;
  }
  // Per wrangler.toml structure: prod is top-level (no [env.prod]), so
  // --env is omitted for prod. dev/uat/stg are env-scoped. --config pins
  // wrangler to voter-info-widget/wrangler.toml even when invoked from a
  // parent dir that has its own wrangler.jsonc.
  const envFlag = env === 'prod' ? '' : `--env ${env}`;
  const cmd = `npx wrangler d1 execute viw_researcher_${env} ${envFlag} --remote --config ./wrangler.toml --file=${sqlPath}`;
  console.log(`[seed-d1] $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
  console.log(`[seed-d1] done.`);
}

// Run only when invoked directly (not when imported by tests). Compares the
// invoked script path to this module's URL.
const invokedPath = process.argv[1] ?? '';
const isMain = import.meta.url.endsWith(invokedPath.replace(/\\/g, '/').split('/').pop() ?? '');
if (isMain && invokedPath.endsWith('seed-d1-from-json.ts')) {
  main().catch((err) => {
    console.error('[seed-d1] failed:', err);
    process.exit(1);
  });
}
