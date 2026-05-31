/**
 * `lw rosters seed` — CLI wrapper. Seeds durable per-member roll-call casts
 * into D1 `vote_casts` from upstream, enumerated from the curated `votes`
 * roll-calls. Mirrors `lw bills seed`.
 *
 * Exit codes:
 *   0 — all roll-calls processed (or none).
 *   1 — configuration error (missing API key / D1 creds / bad --env).
 *   2 — at-least-one roll-call failed (partial; failures in audit_log).
 *
 * Traces to: FR-32 AC-32.36, AC-32.38.
 */
import type { Command } from 'commander';
import { resolveRuntime } from '../lib/runtime';
import { seedRosters } from '../lib/rosters/seed';
import { makeCastFetchers } from '../lib/rosters/fetch-casts';

export function attach(parent: Command): void {
  parent
    .command('seed')
    .description('Seed per-member roll-call casts into D1 vote_casts (FR-32 AC-32.36)')
    .requiredOption('--env <env>', 'Environment: dev | uat | stg | prod')
    .option('--concurrency <n>', 'In-flight roll-calls (default 4)', (v) => Number.parseInt(v, 10))
    .action(async (opts: { env: string; concurrency?: number }) => {
      let runtime;
      const apiKey = process.env.CONGRESS_API_KEY ?? process.env.VITE_CONGRESS_API_KEY;
      try {
        runtime = resolveRuntime({ env: opts.env });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[lw rosters seed] config: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      if (!apiKey) {
        // eslint-disable-next-line no-console
        console.error('[lw rosters seed] config: CONGRESS_API_KEY not set');
        process.exit(1);
      }

      const result = await seedRosters({
        d1: runtime.d1,
        fetchers: makeCastFetchers(apiKey),
        auditLog: runtime.auditLog,
        logger: runtime.logger,
        concurrency: opts.concurrency,
      });

      process.exit(result.failed > 0 ? 2 : 0);
    });
}
