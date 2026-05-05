#!/usr/bin/env tsx
/**
 * Unified deploy script — builds, deploys, and seeds all static data.
 *
 * Usage:
 *   tsx scripts/deploy.ts --env <dev|uat|stg|prod>
 *
 * Requires env vars for CF Access service token (to hit admin seed endpoint):
 *   CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET
 *
 * Steps:
 *   1. tsc (typecheck)
 *   2. vite build (embed widget)
 *   3. vite build admin SPA
 *   4. D1 migrations apply (schema up-to-date before Worker goes live)
 *   5. wrangler deploy
 *   6. POST /api/admin/ingest/seed (triggers ensureIngestSeeded in Worker)
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Load .env if present (for CF_ACCESS_CLIENT_ID/SECRET).
try {
  const envFile = readFileSync(resolve(process.cwd(), '.env'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* no .env — fine, use existing env vars */ }

const argv = process.argv.slice(2);
const getArg = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const env = getArg('--env');
if (!env || !['dev', 'uat', 'stg', 'prod'].includes(env)) {
  console.error('Usage: tsx scripts/deploy.ts --env <dev|uat|stg|prod>');
  process.exit(2);
}

const skipSeed = argv.includes('--skip-seed');

const origins: Record<string, string> = {
  dev: 'https://dev.vote.cogs.it.com',
  uat: 'https://uat.vote.cogs.it.com',
  stg: 'https://stg.vote.cogs.it.com',
  prod: 'https://vote.cogs.it.com',
};
const origin = origins[env]!;

function run(label: string, cmd: string) {
  console.log(`\n── ${label} ──`);
  console.log(`$ ${cmd}\n`);
  execSync(cmd, { stdio: 'inherit', cwd: process.cwd() });
}

// 1. Typecheck
run('Typecheck', 'npx tsc --noEmit');

// 2. Build SPA preview (clears dist/)
run('Build SPA preview', 'npx vite build');

// 3. Build lib (IIFE widget bundle — emptyOutDir:false so SPA assets survive)
run('Build lib (IIFE)', 'npx vite build --mode lib');

// 4. Build admin SPA
run('Build admin SPA', 'npx vite build --config vite.admin.config.ts');

// 5. Generate SRI manifest for the IIFE bundle
run('Build SRI manifest', 'node scripts/build-sri.mjs');

const envFlag = `--env ${env}`;
const dbName = `viw_researcher_${env}`;

// 6. D1 migrations — schema must be current before the new Worker goes live.
run('D1 migrations', `npx wrangler d1 migrations apply ${dbName} ${envFlag} --remote --config wrangler.toml`);

// 7. Deploy Worker
run('Deploy Worker', `npx wrangler deploy --config wrangler.toml ${envFlag}`);

// 6. Seed — POST to the admin seed endpoint with CF Access service token.
if (skipSeed) {
  console.log('\n── Seed skipped (--skip-seed) ──');
} else {
  console.log('\n── Seed static data ──');
  const clientId = process.env.CF_ACCESS_CLIENT_ID ?? '';
  const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET ?? '';

  if (!clientId || !clientSecret) {
    console.warn(
      'WARNING: CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET not set.\n' +
      'Cannot auto-seed. Set these env vars or run seed manually via admin UI.\n' +
      'Continuing without seed.',
    );
  } else {
    const seedUrl = `${origin}/api/admin/ingest/seed`;
    console.log(`POST ${seedUrl}`);

    try {
      const res = execSync(
        `curl -s -X POST "${seedUrl}" ` +
        `-H "CF-Access-Client-Id: ${clientId}" ` +
        `-H "CF-Access-Client-Secret: ${clientSecret}" ` +
        `-H "Content-Type: application/json" ` +
        `-d "{}" ` +
        `--max-time 120`,
        { encoding: 'utf-8', timeout: 130_000 },
      );
      console.log('Seed result:', res);
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      console.error('Seed request failed.');
      if (err.stdout) console.error('stdout:', err.stdout);
      if (err.stderr) console.error('stderr:', err.stderr);
      // Don't fail the deploy for a seed failure.
    }
  }
}

console.log(`\nDeploy complete: ${origin}/admin`);
