#!/usr/bin/env node
/**
 * Sync prod curator data (KV) to stg. T-025e / FR-30.
 *
 * Copies all keys with these prefixes from prod KV → stg KV:
 *   member:v1:*, bill:v1:*, roll-call:v1:*, name-index:v1:*
 *
 * The cache:v1:* prefix (ADR-009 response cache) is deliberately NOT synced —
 * stg has its own traffic and must not inherit prod's response caches.
 *
 * Uses wrangler for read (prod namespace) and write (stg namespace).
 * Requires CLOUDFLARE_API_TOKEN.
 *
 * Usage:
 *   node scripts/sync-stg-data.mjs [--dry-run]
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

const PREFIXES = ['member:v1:', 'bill:v1:', 'roll-call:v1:', 'name-index:v1:'];

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

console.log('Listing prod keys...');
const allKeys = [];
for (const prefix of PREFIXES) {
  const out = sh(`npx wrangler kv key list --namespace-id ${NAMESPACES.prod} --prefix "${prefix}" --remote`);
  const keys = JSON.parse(out);
  console.log(`  ${prefix} → ${keys.length} keys`);
  for (const k of keys) allKeys.push(k.name);
}
console.log(`Total: ${allKeys.length} keys to sync`);

if (DRY_RUN) {
  console.log('\n--dry-run: no writes performed');
  process.exit(0);
}

// Fetch values in series (KV key get doesn't support bulk read reliably via CLI).
// Build a bulk-put payload for stg.
const pairs = [];
for (let i = 0; i < allKeys.length; i++) {
  const key = allKeys[i];
  const value = sh(`npx wrangler kv key get "${key}" --namespace-id ${NAMESPACES.prod} --remote`);
  pairs.push({ key, value });
  if ((i + 1) % 50 === 0) console.log(`  read ${i + 1}/${allKeys.length}`);
}

const dir = mkdtempSync(join(tmpdir(), 'stgsync-'));
const payloadPath = join(dir, 'bulk.json');
writeFileSync(payloadPath, JSON.stringify(pairs), 'utf8');

console.log(`\nWriting to stg namespace...`);
sh(`npx wrangler kv bulk put --namespace-id ${NAMESPACES.stg} --remote ${payloadPath}`);

console.log(`\n✓ Synced ${pairs.length} keys from prod → stg KV`);
