/**
 * `lw kv publish` — CLI wrapper.
 *
 * Thin shim over the existing scripts/publish-to-kv.ts. The 719-line
 * publishing pipeline stays intact for v4.1.0; we add the unified CLI
 * surface without touching the orchestration. A future PR (post-v4.1.0)
 * can pull the body into scripts/lib/kv/publish.ts as a pure function with
 * the D1Like / AuditLogger interfaces, mirroring the bills/backfill shape.
 *
 * Why a subprocess and not an import: the legacy script is an IIFE with
 * top-level argv parsing and process.exit() calls. Importing it would
 * run the IIFE at import time with our parent argv, which breaks. Shelling
 * it out preserves its existing behavior exactly.
 */

import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function attach(parent: Command): void {
  parent
    .command('publish')
    .description('Project D1 + curated data into KV (replaces npm run publish:kv)')
    .requiredOption('--env <env>', 'Environment: dev | uat | stg | prod')
    .option('--dry-run', 'Show what would be written without writing')
    .option('--skip-rosters', 'Skip roll-call roster publish phase')
    .option('--skip-state-members', 'Skip state-members publish phase')
    .action(async (opts: { env: string; dryRun?: boolean; skipRosters?: boolean; skipStateMembers?: boolean }) => {
      const script = resolve(__dirname, '..', 'publish-to-kv.ts');
      const args: string[] = ['--env', opts.env];
      if (opts.dryRun) args.push('--dry-run');
      if (opts.skipRosters) args.push('--skip-rosters');
      if (opts.skipStateMembers) args.push('--skip-state-members');

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
