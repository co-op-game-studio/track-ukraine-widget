#!/usr/bin/env tsx
/**
 * Sync prod curator-written KV records to a target env. T-025e / FR-30.
 *
 * Copies keys with these prefixes from prod → target:
 *   bill:v1:*, roll-call:v1:*, name-index:v1:*, state-members:v1:*
 *
 * Does NOT copy:
 *   - member:v1:* (filled by the Worker read-through from upstream — target
 *     will lazily rebuild its own profile cache against the live Congress.gov API)
 *   - cache:v1:*  (ADR-009 response cache — env-local traffic only)
 *
 * Target env resolution (in priority order):
 *   1. env var `SYNC_TARGET_ENV` (stg | uat) — set by the stg-rehearsal workflow
 *   2. default: stg (original behavior preserved)
 *
 * Usage:
 *   tsx scripts/sync-stg-data.ts [--dry-run]
 *   SYNC_TARGET_ENV=uat tsx scripts/sync-stg-data.ts
 *
 * Traces: FR-30, T-025e, ADR-011, UAT 2026-04-19 parameterization.
 */
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');

const NAMESPACES: Record<string, string> = {
  prod: '72d3dbce1a1d4ea4aec74b305d7995e6',
  stg:  '4ff9a8e54b82489fb9a300466bd68686',
  uat:  '3756142363984d218d5f489151716b30',
  dev:  '743b2feda53648cd8242d3b89538bfac',
};

const TARGET = (process.env.SYNC_TARGET_ENV ?? 'stg').toLowerCase();
if (!['stg', 'uat'].includes(TARGET)) {
  console.error(`Invalid SYNC_TARGET_ENV="${TARGET}" — must be 'stg' or 'uat'.`);
  process.exit(2);
}
const TARGET_NAMESPACE = NAMESPACES[TARGET]!;
console.log(`Sync target: ${TARGET} (namespace ${TARGET_NAMESPACE})`);

const PREFIXES = ['bill:v1:', 'roll-call:v1:', 'name-index:v1:', 'state-members:v1:'] as const;

function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

console.log('Listing prod keys...');
const allKeys: string[] = [];
for (const prefix of PREFIXES) {
  const out = sh(`npx wrangler kv key list --namespace-id ${NAMESPACES.prod} --prefix "${prefix}" --remote`);
  const keys = JSON.parse(out) as { name: string }[];
  console.log(`  ${prefix} → ${keys.length} keys`);
  for (const k of keys) allKeys.push(k.name);
}
console.log(`Total: ${allKeys.length} keys to sync`);

if (DRY_RUN) {
  console.log('--dry-run: no writes performed');
  process.exit(0);
}

const pairs: { key: string; value: string }[] = [];
for (let i = 0; i < allKeys.length; i++) {
  const key = allKeys[i]!;
  const value = sh(`npx wrangler kv key get "${key}" --namespace-id ${NAMESPACES.prod} --remote`);
  pairs.push({ key, value });
  if ((i + 1) % 50 === 0) console.log(`  read ${i + 1}/${allKeys.length}`);
}

const dir = mkdtempSync(join(tmpdir(), 'stgsync-'));
const payloadPath = join(dir, 'bulk.json');
writeFileSync(payloadPath, JSON.stringify(pairs), 'utf8');

console.log(`Writing to ${TARGET} namespace...`);
sh(`npx wrangler kv bulk put --namespace-id ${TARGET_NAMESPACE} --remote ${payloadPath}`);

console.log(`\n✓ Synced ${pairs.length} keys from prod → ${TARGET} KV`);
