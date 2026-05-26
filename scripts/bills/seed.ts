/**
 * `lw bills seed` — CLI wrapper.
 *
 * Argv → input shape → seedBills() → exit code.
 *
 * Exit codes per AC-59.1:
 *   0 — all bills processed successfully (or no bills matched).
 *   1 — configuration error (missing API key, unreachable D1, bad --env).
 *   2 — at-least-one-bill-failed (partial success). Failures are in
 *       audit_log. CI treats this as a warning, not a red build.
 *
 * Environment-agnostic: the same code path runs against any env. `--env`
 * picks the D1/KV bindings; `--local` opts into the local wrangler binding
 * for fast dev iteration (default is remote for every env).
 */

import type { Command } from 'commander';
import { resolveRuntime } from '../lib/runtime';
import { seedBills } from '../lib/bills/seed';

export function attach(parent: Command): void {
  parent
    .command('seed')
    .description('Ensure every bill in D1 reflects Congress.gov truth (FR-59)')
    .requiredOption('--env <env>', 'Environment: dev | uat | stg | prod')
    .option('--limit <n>', 'Max bills to process this run', (v) => Number.parseInt(v, 10))
    .option('--after <bill_id>', 'Resume cursor — start after this bill_id')
    .option('--force', 'Force re-pull even if congress_update_date is unchanged')
    .option(
      '--concurrency <n>',
      'In-flight bills (default 4; token bucket throttles aggregate to 5000/h)',
      (v) => Number.parseInt(v, 10),
    )
    .option(
      '--congress <n>',
      'Filter to one congress (117 | 118 | 119)',
      (v) => Number.parseInt(v, 10),
    )
    .option(
      '--local',
      'Use the local wrangler D1 binding instead of remote (dev iteration only)',
    )
    .option('--dry-run', 'Walk bills + show what would change, but do not write — NOT YET IMPLEMENTED')
    .action(
      async (opts: {
        env: string;
        limit?: number;
        after?: string;
        force?: boolean;
        concurrency?: number;
        congress?: number;
        local?: boolean;
        dryRun?: boolean;
      }) => {
        if (opts.dryRun) {
          // eslint-disable-next-line no-console
          console.error('[lw bills seed] --dry-run not yet implemented');
          process.exit(1);
        }

        let runtime;
        try {
          runtime = resolveRuntime({ env: opts.env, remote: !opts.local });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[lw bills seed] config: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }

        const result = await seedBills({
          d1: runtime.d1,
          congressClient: runtime.congressClient,
          auditLog: runtime.auditLog,
          logger: runtime.logger,
          kvInvalidate: runtime.kvInvalidate,
          after: opts.after,
          limit: opts.limit,
          force: opts.force,
          concurrency: opts.concurrency,
          filter: opts.congress ? (row) => row.congress === opts.congress : undefined,
        });

        process.exit(result.failed > 0 ? 2 : 0);
      },
    );
}
