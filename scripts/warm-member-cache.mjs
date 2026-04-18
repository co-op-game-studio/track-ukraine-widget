#!/usr/bin/env node
/**
 * Prewarm the Worker KV + edge cache for every current-Congress member.
 *
 * How it works:
 *   1. Read every name-index:v1:{letter} shard from the live KV namespace
 *      via the name-search endpoint (one shard per letter a-z).
 *   2. Collect the unique bioguideIds from those shards.
 *   3. For each bioguideId, GET /api/members/{id} against the public host.
 *      The Worker's read-through fills KV member:v1:{id} on first hit
 *      (30-day TTL) and Cloudflare's edge caches the response under its
 *      Cache-Control header.
 *
 * Traffic: one /api/name-search call per letter (~26), plus one
 * /api/members/{id} call per unique member (~540). All go through our
 * cache layer, so the upstream Congress API sees at most one member-
 * profile fan-out per bioguideId — a one-time cost instead of per-user.
 *
 * Usage:
 *   node scripts/warm-member-cache.mjs [--host https://vote.cogs.it.com] \
 *                                      [--concurrency 8] [--dry-run]
 */
import process from 'node:process';

const args = process.argv.slice(2);
function arg(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
}
const HOST = arg('--host', 'https://vote.cogs.it.com').replace(/\/$/, '');
const CONCURRENCY = Number(arg('--concurrency', '8'));
const DRY_RUN = args.includes('--dry-run');
const ORIGIN = 'https://trackukraine.com';

async function getJson(url) {
  const res = await fetch(url, { headers: { Origin: ORIGIN } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function main() {
  console.log(`Warming cache against ${HOST} (concurrency=${CONCURRENCY}${DRY_RUN ? ', DRY RUN' : ''})`);

  // Page through the Congress member directory via our proxy. Cached
  // upstream response (24h edge now), so this is at most one Congress
  // API hit per page regardless of how many times we run.
  const bioguides = new Set();
  let offset = 0;
  const limit = 250;
  console.log(`Collecting bioguides from /api/congress/v3/member...`);
  while (true) {
    const url = `${HOST}/api/congress/v3/member?currentMember=true&format=json&limit=${limit}&offset=${offset}`;
    const data = await getJson(url);
    const members = data.members ?? [];
    for (const m of members) if (m.bioguideId) bioguides.add(m.bioguideId);
    console.log(`  offset=${offset} page_size=${members.length}`);
    if (members.length < limit) break;
    offset += limit;
  }
  console.log(`Found ${bioguides.size} unique bioguides`);

  if (DRY_RUN) {
    console.log('Dry run: skipping /api/members/{id} warm hits.');
    return;
  }

  const ids = [...bioguides];
  let ok = 0, fail = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const id = ids.shift();
      if (!id) return;
      try {
        const res = await fetch(`${HOST}/api/members/${id}`, { headers: { Origin: ORIGIN } });
        if (res.ok) ok++;
        else { fail++; console.warn(`  !${id}: ${res.status}`); }
      } catch (e) {
        fail++;
        console.warn(`  !${id}: ${e.message}`);
      }
    }
  });
  await Promise.all(workers);
  console.log(`Warmed: ${ok} ok, ${fail} failed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
