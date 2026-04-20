#!/usr/bin/env node
/**
 * One-off: purge member:v1:* from dev + uat KV so the Worker's
 * read-through regenerates them with the yearEntered field (UAT
 * 2026-04-19). Explicitly excludes stg + prod for safety.
 *
 * Usage: node scripts/purge-members-nonprod.mjs
 */
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TARGETS = {
  dev: '743b2feda53648cd8242d3b89538bfac',
  uat: '3756142363984d218d5f489151716b30',
  // stg + prod deliberately omitted — they will rebuild naturally on
  // the next member detail fetch, but we don't want an unexpected
  // cache stampede against Congress.gov from here.
};

for (const [env, id] of Object.entries(TARGETS)) {
  console.log(`\n=== ${env} (${id}) ===`);
  const listOut = execSync(
    `npx wrangler kv key list --namespace-id ${id} --prefix "member:v1:" --remote`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  // Wrangler sometimes prepends ⛅️ banner + auth text; find the JSON array.
  const arrStart = listOut.indexOf('[');
  const arrEnd = listOut.lastIndexOf(']');
  const rawJson = arrStart >= 0 && arrEnd > arrStart
    ? listOut.slice(arrStart, arrEnd + 1)
    : '[]';
  const keys = JSON.parse(rawJson).map((k) => k.name);
  console.log(`  member:v1:* keys: ${keys.length}`);
  if (keys.length === 0) continue;
  const dir = mkdtempSync(join(tmpdir(), 'purge-'));
  const file = join(dir, 'keys.json');
  writeFileSync(file, JSON.stringify(keys), 'utf8');
  execSync(
    `npx wrangler kv bulk delete --namespace-id ${id} --remote --force ${file}`,
    { stdio: 'inherit' },
  );
  console.log(`  ✓ purged ${keys.length} records from ${env}`);
}
console.log('\nDone. Next member-profile fetch will rebuild with yearEntered.');
