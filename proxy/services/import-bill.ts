/**
 * Worker adapter for importBillCore.
 *
 * As of v4.1.0, the orchestration body lives in
 * `scripts/lib/bills/import-core.ts` so the same code powers the `lw` CLI
 * (FR-59 corpus backfill) and the Worker's per-bill admin actions. This
 * file is a 30-line shim that constructs the three injected interfaces
 * (D1Like / CongressClient / AuditLogger) from Worker bindings, plus the
 * Worker-only KV-invalidate callback, and forwards into the core.
 *
 * Public exports preserved for backward compatibility:
 *   - importBillFromCongress(req, opts) — same signature as pre-v4.1.0
 *   - extractCongressionalRecord(text) — re-exported from core
 *   - freshnessIntervalMs / isFreshnessDue — re-exported from core
 */

import type { ProxyEnv } from '../env';
import { KV_KEY } from './kv-projector';
import { logEvent } from '../observability/log';
import {
  importBillCore,
  extractCongressionalRecord,
  freshnessIntervalMs,
  isFreshnessDue,
  type ImportBillResult as CoreResult,
  type ImportBillRequest as CoreRequest,
} from '../../scripts/lib/bills/import-core';
import type { D1Like } from '../../scripts/lib/d1-client';
import type { CongressClient } from '../../scripts/lib/congress-client';
import { makeRealCongressClient } from '../../scripts/lib/congress-client';
import { makeD1AuditLogger } from '../../scripts/lib/audit-log';

/* -------------------------------------------------------------------------- */
/*                              Public re-exports                              */
/* -------------------------------------------------------------------------- */

export { extractCongressionalRecord, freshnessIntervalMs, isFreshnessDue };

/** Back-compat type alias — same shape as pre-v4.1.0 ImportRequest. */
export type ImportRequest = CoreRequest;

/** Back-compat type alias — same shape as pre-v4.1.0 ImportResult. */
export type ImportResult = CoreResult;

interface ProxyOpts {
  env: ProxyEnv;
  /** Origin to use when same-Worker subrequesting (unused now; kept for back-compat). */
  workerOrigin: string;
}

/* -------------------------------------------------------------------------- */
/*                              Worker adapter                                 */
/* -------------------------------------------------------------------------- */

/**
 * Pre-v4.1.0 signature preserved. Internally delegates to importBillCore
 * with Worker-flavored impls of the injected interfaces.
 */
export async function importBillFromCongress(
  req: ImportRequest,
  opts: ProxyOpts,
): Promise<ImportResult> {
  const env = opts.env;
  const d1 = env.D1_VOTER_INFO! as unknown as D1Like;
  const kv = env.KV_VOTER_INFO;

  if (!env.CONGRESS_API_KEY) {
    throw new Error('CONGRESS_API_KEY not configured');
  }

  const congressClient: CongressClient = makeRealCongressClient({
    apiKey: env.CONGRESS_API_KEY,
    // Worker stays at ratePerHour=0 (no throttle). Two reasons:
    //   1) Per-request handlers shouldn't block on a global token bucket
    //      — the Worker only has the in-flight request's CPU budget.
    //   2) The token bucket is per-Worker-instance, not global, so it
    //      can't meaningfully enforce a Congress.gov rate ceiling here.
    // The CLI (`lw bills backfill`) is the actual ingest path; it runs
    // with ratePerHour=5000 per scripts/lib/runtime.ts.
  });

  const auditLog = makeD1AuditLogger(d1);

  return importBillCore(req, {
    d1,
    congressClient,
    auditLog,
    kvInvalidate: (billId: string) => kv.delete(KV_KEY.bill(billId)),
    log: (e) =>
      logEvent(
        { env: env.ENV_NAME ?? 'unknown', traceId: req.traceId },
        e as Parameters<typeof logEvent>[1],
      ),
  });
}
