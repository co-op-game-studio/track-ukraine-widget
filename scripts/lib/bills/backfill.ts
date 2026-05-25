/**
 * backfillBills — pure orchestrator for "iterate every bill in D1 and
 * call importBillCore for each."
 *
 * Per AC-59.1 + AC-59.10:
 *   - Reads bills ordered by `bill_id ASC`. Resumable via `after` cursor.
 *   - Calls `importBillCore` with `force=false` by default so the
 *     bill-level freshness gate skips unchanged bills (1 API call each
 *     instead of ~7).
 *   - 4-way concurrency across bills. The shared CongressClient token
 *     bucket throttles aggregate to 5,000/h regardless of concurrency.
 *   - Per-bill failures are logged to audit_log and do NOT abort the loop.
 *   - Verbose logging surfaces per-bill timing + counters when LW_VERBOSITY
 *     is set.
 */

import type { D1Like } from '../d1-client';
import type { CongressClient } from '../congress-client';
import type { AuditLogger } from '../audit-log';
import type { CliLogger } from '../logger';
import { importBillCore, type ImportBillResult } from './import-core';
import { generateTraceId } from '../trace';

export interface BackfillBillsInput {
  d1: D1Like;
  congressClient: CongressClient;
  auditLog: AuditLogger;
  logger: CliLogger;
  /** Resume cursor — only process rows with bill_id > this value. */
  after?: string;
  /** Cap on bills processed this run. Default: no cap. */
  limit?: number;
  /** Force re-pull even if congress_update_date is unchanged. Default false. */
  force?: boolean;
  /** Concurrency width. Default 4 — the shared token bucket throttles. */
  concurrency?: number;
  /** Audit-log actor email. Default `ci@backfill`. */
  actorEmail?: string;
  /** Filter to bills matching this predicate (e.g. only 119th). */
  filter?: (row: BillRow) => boolean;
}

export interface BackfillBillsResult {
  processed: number;
  ok: number;
  failed: number;
  cached: number;
  errors: Array<{ bill_id: string; error: string; traceId: string }>;
  durationMs: number;
  lastBillId: string | null;
}

interface BillRow {
  bill_id: string;
  congress: number;
  type: string;
  number: string;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_ACTOR = 'ci@backfill';

export async function backfillBills(input: BackfillBillsInput): Promise<BackfillBillsResult> {
  const t0 = Date.now();
  const {
    d1,
    congressClient,
    auditLog,
    logger,
    after = '',
    limit,
    force = false,
    concurrency = DEFAULT_CONCURRENCY,
    actorEmail = DEFAULT_ACTOR,
    filter,
  } = input;

  logger.info(
    `backfill start: after=${after || '(none)'} limit=${limit ?? 'none'} force=${force} concurrency=${concurrency}`,
  );

  // 1. Pull the work list. Single query — even thousands of bills is OK
  //    because we only read 4 columns per row.
  const sql = `SELECT bill_id, congress, type, number FROM bills WHERE bill_id > ? ORDER BY bill_id ASC${limit ? ' LIMIT ?' : ''}`;
  const stmt = limit
    ? d1.prepare(sql).bind(after, limit)
    : d1.prepare(sql).bind(after);
  const queryRes = await stmt.all<BillRow>();
  let rows = queryRes.results ?? [];
  if (filter) rows = rows.filter(filter);
  logger.verbose(`backfill: ${rows.length} bills to process`);

  // 2. Run with bounded concurrency. Each slot picks the next bill from
  //    the queue until empty. Errors land in `errors[]` and don't stop
  //    the loop.
  const result: BackfillBillsResult = {
    processed: 0,
    ok: 0,
    failed: 0,
    cached: 0,
    errors: [],
    durationMs: 0,
    lastBillId: null,
  };

  let cursor = 0;
  async function worker(slotId: number): Promise<void> {
    while (cursor < rows.length) {
      const i = cursor++;
      const row = rows[i]!;
      const traceId = generateTraceId();
      const tBill = Date.now();
      try {
        logger.verbose(`[slot ${slotId}] ${row.bill_id} start trace=${traceId}`);
        const r: ImportBillResult = await importBillCore(
          {
            congress: row.congress,
            type: row.type,
            number: row.number,
            force,
            actorEmail,
            traceId,
          },
          {
            d1,
            congressClient,
            auditLog,
            log: (e) => {
              const event = typeof e.event === 'string' ? e.event : 'log';
              const level = typeof e.level === 'string' ? e.level : undefined;
              logger.event({ ...e, event, level });
            },
          },
        );
        result.ok++;
        if (r.cached) result.cached++;
        const elapsedMs = Date.now() - tBill;
        const tag = r.cached ? 'cached' : 'ok';
        logger.info(
          `[backfill] ${row.bill_id} ${tag} ${elapsedMs}ms ` +
          `votes_in=${r.votes_imported} votes_up=${r.votes_updated} votes_skip=${r.votes_skipped} ` +
          `cos=${r.cosponsors_imported} act=${r.actions_imported}`,
        );
      } catch (err) {
        result.failed++;
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push({ bill_id: row.bill_id, error: message, traceId });
        const elapsedMs = Date.now() - tBill;
        logger.error(`[backfill] ${row.bill_id} FAILED ${elapsedMs}ms trace=${traceId}: ${message}`);
        // Best-effort audit row. If this also fails, just log and move on.
        try {
          await auditLog.log({
            action: 'bill_backfill_error',
            actorEmail,
            targetTable: 'bills',
            rowId: row.bill_id,
            reason: message,
            traceId,
          });
        } catch (auditErr) {
          logger.warn(
            `[backfill] ${row.bill_id} audit-log write failed: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
          );
        }
      } finally {
        result.processed++;
        result.lastBillId = row.bill_id;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, Math.max(rows.length, 1)) }, (_, i) =>
    worker(i + 1),
  );
  await Promise.all(workers);

  result.durationMs = Date.now() - t0;
  const fresh = result.ok - result.cached;
  logger.info(
    `backfill done: processed=${result.processed} ok=${result.ok} cached=${result.cached} fresh=${fresh} failed=${result.failed} ${(result.durationMs / 1000).toFixed(1)}s`,
  );
  if (result.errors.length > 0) {
    logger.warn(`backfill: ${result.errors.length} bills failed. See audit_log + above for details.`);
  }
  return result;
}
