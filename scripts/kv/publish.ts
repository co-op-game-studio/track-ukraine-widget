/**
 * `lw kv publish` — CLI wrapper.
 *
 * Projects ALL KV records from D1 via scripts/publish-d1-to-kv.ts (FR-32
 * AC-32.40): bill / comment / quote / social-post / stats / audit-feed AND the
 * formerly-upstream-only member / state-members / name-index / roll-call-roster
 * / roll-call prefixes — now sourced from the durable `members` + `vote_casts`
 * tables. KV is a pure cache; re-running publish fully restores it from D1 with
 * no upstream fetch. (The legacy upstream-fetch publisher `publish-to-kv.ts` is
 * retired from this path.)
 *
 * Why a subprocess and not an import: the script is an IIFE with top-level argv
 * parsing + process.exit(); importing would run it at import time with the
 * parent argv. Shelling out preserves behavior exactly.
 */

import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function attach(parent: Command): void {
  parent
    .command('publish')
    .description('Project all KV records from D1 (member/state/name-index/roster/bill/etc.)')
    .requiredOption('--env <env>', 'Environment: dev | uat | stg | prod')
    .option('--dry-run', 'Show what would be written without writing')
    .action(async (opts: { env: string; dryRun?: boolean }) => {
      const script = resolve(__dirname, '..', 'publish-d1-to-kv.ts');
      const args: string[] = ['--env', opts.env];
      if (opts.dryRun) args.push('--dry-run');

      // shell: true is required so this works on Windows where `npx`
      // resolves to a .cmd shim. DEP0190 warns about shell injection — not
      // a concern here because every arg is constructed from commander's
      // validated options (env is one of dev/uat/stg/prod; the rest are
      // boolean flags).
      const code = await new Promise<number>((resolveExit) => {
        const proc = spawn('npx', ['tsx', script, ...args], {
          stdio: 'inherit',
          shell: true,
        });
        proc.on('close', (c) => resolveExit(c ?? 0));
        proc.on('error', (err) => {
          // eslint-disable-next-line no-console
          console.error(`[lw kv publish] spawn error: ${err.message}`);
          resolveExit(1);
        });
      });
      process.exit(code);
    });
}
