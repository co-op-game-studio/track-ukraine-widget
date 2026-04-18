#!/usr/bin/env tsx
/** One-shot: purge member:v1:* from all four env namespaces. */
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NAMESPACES: Record<string, string> = {
  dev: '743b2feda53648cd8242d3b89538bfac',
  uat: '3756142363984d218d5f489151716b30',
  stg: '4ff9a8e54b82489fb9a300466bd68686',
  prod: '72d3dbce1a1d4ea4aec74b305d7995e6',
};

for (const [env, id] of Object.entries(NAMESPACES)) {
  console.log(`=== ${env} ===`);
  const listOut = execSync(
    `npx wrangler kv key list --namespace-id ${id} --prefix "member:v1:" --remote`,
    { encoding: 'utf8' },
  );
  const keys = (JSON.parse(listOut) as { name: string }[]).map((k) => k.name);
  console.log(`  keys: ${keys.length}`);
  if (keys.length === 0) continue;
  const dir = mkdtempSync(join(tmpdir(), 'purge-'));
  const file = join(dir, 'keys.json');
  writeFileSync(file, JSON.stringify(keys), 'utf8');
  execSync(
    `npx wrangler kv bulk delete --namespace-id ${id} --remote --force ${file}`,
    { stdio: 'inherit' },
  );
}
console.log('\n✓ member:v1:* purged on all envs');
