#!/usr/bin/env tsx
/**
 * Sync prod curator-written KV records to stg. T-025e / FR-30.
 *
 * Copies keys with these prefixes from prod → stg:
 *   bill:v1:*, roll-call:v1:*, name-index:v1:*
 *
 * Does NOT copy:
 *   - member:v1:* (filled by the Worker read-through from upstream — stg will
 *     lazily rebuild its own profile cache against the live Congress.gov API)
 *   - cache:v1:*  (ADR-009 response cache — env-local traffic only)
 *
 * Usage: tsx scripts/sync-stg-data.ts [--dry-run]
 *
 * Traces: FR-30, T-025e, ADR-011.
 */
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');

const NAMESPACES = {
  prod: '72d3dbce1a1d4ea4aec74b305d7995e6',
  stg: '4ff9a8e54b82489fb9a300466bd68686',
};

const PREFIXES = ['bill:v1:', 'roll-call:v1:', 'name-index:v1:'] as const;

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

console.log('Writing to stg namespace...');
sh(`npx wrangler kv bulk put --namespace-id ${NAMESPACES.stg} --remote ${payloadPath}`);

console.log(`\n✓ Synced ${pairs.length} keys from prod → stg KV`);
