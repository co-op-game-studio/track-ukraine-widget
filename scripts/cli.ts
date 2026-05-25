#!/usr/bin/env tsx
/**
 * `lw` — legislation-watch CLI.
 *
 * Single entrypoint for every ingest, projection, and ops job that runs
 * outside the Worker. Subcommands live in scripts/<resource>/<verb>.ts and
 * share pure-function cores in scripts/lib/<resource>/.
 *
 * Why a CLI and not a Worker scheduled handler:
 *   Per memory `feedback_seeding_is_buildops_not_runtime`, every ingest job
 *   is build/ops, not runtime. The Worker stays a pure read/edit surface.
 *
 * Invocation:
 *   npx lw <resource> <verb> [options]
 *   tsx scripts/cli.ts <resource> <verb> [options]
 *   tsx scripts/<resource>/<verb>.ts [options]   # bypass for dev iteration
 */

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
  version: string;
};

const program = new Command();

program
  .name('lw')
  .description('legislation-watch ops CLI — ingest, projection, and admin tasks')
  .version(pkg.version)
  .option('-v, --verbose', 'verbose output — per-phase progress, timing, counters, trace IDs')
  .option('-d, --debug', 'debug output — verbose PLUS raw upstream URLs (key-redacted), HTTP statuses, payload sizes')
  .hook('preAction', (thisCmd) => {
    // Top-level --verbose / --debug propagate to subcommands via the
    // global `LW_VERBOSITY` env var so deeply-nested code paths (e.g.
    // CongressClient inside importBillCore) can pick them up without
    // threading a logger through every signature.
    const opts = thisCmd.opts<{ verbose?: boolean; debug?: boolean }>();
    if (opts.debug) process.env.LW_VERBOSITY = 'debug';
    else if (opts.verbose) process.env.LW_VERBOSITY = 'verbose';
    else process.env.LW_VERBOSITY = 'quiet';
  });

/* ------------------------------------------------------------------------ */
/*                              bills group                                 */
/* ------------------------------------------------------------------------ */

const bills = program.command('bills').description('Bill ingest + maintenance');

// Subcommands wire themselves in via the imports below.
// Each subcommand module exports `attach(program: Command)` which calls
// .command(...) on the passed Command instance.

import { attach as attachBillsBackfill } from './bills/backfill';
attachBillsBackfill(bills);

/* ------------------------------------------------------------------------ */
/*                                kv group                                  */
/* ------------------------------------------------------------------------ */

const kv = program.command('kv').description('KV projection from D1');

import { attach as attachKvPublish } from './kv/publish';
attachKvPublish(kv);

/* ------------------------------------------------------------------------ */

program.parseAsync(process.argv).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`[lw] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
