/**
 * `lw members seed` — CLI wrapper. Seeds the durable D1 `members` table from
 * Congress.gov. `lw kv publish` then projects member:v1: / state-members:v1: /
 * name-index:v1: from it. Mirrors `lw bills seed`.
 *
 * Exit codes: 0 ok / 1 config error / 2 partial (failures in audit_log).
 *
 * Traces to: FR-32 AC-32.39.
 */
import type { Command } from 'commander';
import { resolveRuntime } from '../lib/runtime';
import { seedMembers, type MemberSocials } from '../lib/members/seed';

const SOCIALS_URL = 'https://unitedstates.github.io/congress-legislators/legislators-social-media.json';

/** One upstream fetch → bioguideId → socials map. Empty map on failure (socials
 *  are optional; the seed still records identity). */
async function fetchSocials(): Promise<Map<string, MemberSocials>> {
  const map = new Map<string, MemberSocials>();
  try {
    const res = await fetch(SOCIALS_URL);
    if (!res.ok) return map;
    const data = (await res.json()) as Array<{ id?: { bioguide?: string }; social?: Record<string, string> }>;
    for (const entry of data) {
      const bioguide = entry.id?.bioguide;
      if (!bioguide || !entry.social) continue;
      const s: MemberSocials = {};
      for (const [k, v] of Object.entries(entry.social)) if (typeof v === 'string' && v) s[k] = v;
      if (Object.keys(s).length) map.set(bioguide, s);
    }
  } catch {
    // best-effort
  }
  return map;
}

export function attach(parent: Command): void {
  parent
    .command('seed')
    .description('Seed the durable D1 members table from Congress.gov (FR-32 AC-32.39)')
    .requiredOption('--env <env>', 'Environment: dev | uat | stg | prod')
    .option('--force', 'Re-write even if congress_update_date is unchanged')
    .option('--concurrency <n>', 'In-flight members (default 4)', (v) => Number.parseInt(v, 10))
    // AC-32.43 — selective seeding so cleanup/retry doesn't re-touch the roster.
    .option(
      '--bioguide <id>',
      'Seed ONLY this bioguide (repeatable); skips list enumeration',
      (v: string, acc: string[]) => { acc.push(v); return acc; },
      [] as string[],
    )
    .option('--only-missing', 'Seed ONLY bioguides not already in the members table')
    .option('--retry-failed', 'Seed ONLY bioguides with a recent member_seed_error audit row')
    .action(async (opts: {
      env: string; force?: boolean; concurrency?: number;
      bioguide?: string[]; onlyMissing?: boolean; retryFailed?: boolean;
    }) => {
      let runtime;
      try {
        runtime = resolveRuntime({ env: opts.env });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[lw members seed] config: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      // Build the explicit bioguide target list from --bioguide and/or
      // --retry-failed (recent audit failures). Either implies "targeted".
      let onlyBioguides: string[] | undefined = opts.bioguide && opts.bioguide.length > 0 ? [...opts.bioguide] : undefined;
      const invalid = (onlyBioguides ?? []).filter((b) => !/^[A-Z][0-9]{6}$/.test(b));
      if (invalid.length > 0) {
        // eslint-disable-next-line no-console
        console.error(`[lw members seed] config: invalid bioguide(s): ${invalid.join(', ')}`);
        process.exit(1);
      }
      if (opts.retryFailed) {
        const res = await runtime.d1
          .prepare("SELECT DISTINCT row_id FROM audit_log WHERE action = 'member_seed_error'")
          .all<{ row_id: string }>();
        const failed = (res.results ?? []).map((r) => r.row_id).filter((b) => /^[A-Z][0-9]{6}$/.test(b));
        onlyBioguides = [...new Set([...(onlyBioguides ?? []), ...failed])];
        runtime.logger.info(`members seed: --retry-failed → ${failed.length} bioguide(s) from audit_log`);
        if (onlyBioguides.length === 0) {
          runtime.logger.info('members seed: nothing to retry. Done.');
          process.exit(0);
        }
      }

      const result = await seedMembers({
        d1: runtime.d1,
        congressClient: runtime.congressClient,
        auditLog: runtime.auditLog,
        logger: runtime.logger,
        fetchSocials,
        force: opts.force,
        concurrency: opts.concurrency,
        onlyBioguides,
        onlyMissing: opts.onlyMissing,
      });

      process.exit(result.failed > 0 ? 2 : 0);
    });
}
