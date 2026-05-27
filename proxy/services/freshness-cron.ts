/**
 * Scaling-backoff freshness cron (AC-52.49).
 *
 * Runs hourly. Walks `bills` table looking for rows whose
 * `last_freshness_check_at + scaling_interval(updated_at)` ≤ now. For each,
 * re-runs the import (which compares Congress.gov `updateDate` and refreshes
 * static columns + invalidates KV per AC-52.47 / AC-52.50).
 *
 * Backoff schedule (per `freshnessIntervalMs`):
 *   - bill seen < 24h ago    → recheck every 1h
 *   - < 7d                   → every 3h
 *   - < 30d                  → every 12h
 *   - ≥ 30d                  → every 24h
 *
 * Constraints inside the cron:
 *   - Cap how many bills get refreshed per tick (avoid Congress.gov rate
 *     limits). Default: 25 per run.
 *   - Skip bills whose import yields a 5xx — log and move on.
 *
 * Traces: AC-52.49.
 */
import type { ProxyEnv } from '../env';
import { isFreshnessDue } from './import-bill';
import { importBillFromCongress } from './import-bill';
import { logEvent } from '../observability/log';

interface DueBillRow {
  bill_id: string;
  congress: number;
  type: string;
  number: string;
  updated_at: string;
  last_freshness_check_at: string | null;
}

const MAX_REFRESHES_PER_RUN = 25;
const ACTOR_EMAIL_FOR_CRON = 'cron@system';

export async function runFreshnessCron(
  env: ProxyEnv,
  workerOrigin: string,
  now: Date = new Date(),
): Promise<{ checked: number; refreshed: number; skipped: number; errors: number }> {
  const traceId = `cron-${Math.random().toString(36).slice(2, 14)}`;
  const d1 = env.D1_VOTER_INFO;
  if (!d1) {
    logEvent(
      { env: env.ENV_NAME ?? 'unknown', traceId },
      { event: 'freshness_cron_skipped', level: 'warn', reason: 'no_d1' },
    );
    return { checked: 0, refreshed: 0, skipped: 0, errors: 0 };
  }

  // Pull all bills with their freshness markers; client-side decide which
  // are due. With the bill corpus expected to stay below ~10k rows, this
  // is fine; if it grows, switch to a SQL-side WHERE clause computed against
  // the floor of the schedule.
  const result = await d1
    .prepare(
      `SELECT bill_id, congress, type, number, updated_at, last_freshness_check_at
       FROM bills`,
    )
    .all<DueBillRow>();
  const all = result.results ?? [];
  let checked = 0;
  let refreshed = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of all) {
    if (!isFreshnessDue(row.updated_at, row.last_freshness_check_at, now.getTime())) {
      continue;
    }
    if (refreshed >= MAX_REFRESHES_PER_RUN) {
      // Rate-limit: leave the rest for the next tick.
      skipped++;
      continue;
    }
    checked++;
    try {
      const r = await importBillFromCongress(
        {
          congress: row.congress,
          type: row.type,
          number: row.number,
          force: false,
          actorEmail: ACTOR_EMAIL_FOR_CRON,
          traceId,
        },
        { env, workerOrigin },
      );
      if (r.cached) {
        // Upstream unchanged; we still need to record the "asked at" stamp
        // so the next tick doesn't redundantly recheck.
        await d1
          .prepare('UPDATE bills SET last_freshness_check_at = ? WHERE bill_id = ?')
          .bind(now.toISOString(), row.bill_id)
          .run();
      }
      refreshed++;
    } catch (err) {
      errors++;
      logEvent(
        { env: env.ENV_NAME ?? 'unknown', traceId },
        {
          event: 'freshness_cron_error',
          level: 'warn',
          bill_id: row.bill_id,
          error: (err as Error).message,
        },
      );
    }
  }

  logEvent(
    { env: env.ENV_NAME ?? 'unknown', traceId },
    {
      event: 'freshness_cron_done',
      level: 'info',
      checked,
      refreshed,
      skipped,
      errors,
      total_due_evaluated: all.length,
    },
  );
  return { checked, refreshed, skipped, errors };
}
