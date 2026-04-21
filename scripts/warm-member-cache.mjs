#!/usr/bin/env node
/**
 * Prewarm the Worker KV + edge cache for every current-Congress member
 * AND for every curated Ukraine-vote roll-call roster. This is what the
 * widget fetches per visitor; paying the cost once across all visitors
 * moves cold-start latency off the visitor path.
 *
 * Three warming phases (each paced to respect the per-IP rate limit):
 *   1. /api/members/{bioguideId} — Worker read-through fills KV
 *      member:v1:{id} (30-day TTL) and edge-caches the response.
 *   2. /api/roll-call-rosters/house/{c}/{s}/{rc}
 *      — one per House curated roll-call. KV-backed via
 *      roll-call-roster:v1:* (AC-32.15). Immutable 1y cache.
 *   3. /api/roll-call-rosters/senate/{c}/{s}/{rc}
 *      — one per Senate curated roll-call. KV-backed via
 *      roll-call-roster:v1:* (AC-32.15). Immutable 1y cache.
 *
 * v2.5.2: the prior legacy routes (/api/congress/v3/house-vote/...,
 * /api/senate/legislative/LIS/...) are no longer called by the widget,
 * so the warmer no longer targets them. See FR-35 AC-35.3 and ADR-012.
 *
 * Usage:
 *   node scripts/warm-member-cache.mjs --host <https://env.vote.cogs.it.com> \
 *                                      [--concurrency 4] [--delay-ms 250] \
 *                                      [--access-id <id>] [--access-secret <sec>] \
 *                                      [--skip-members] [--skip-votes] [--dry-run]
 *
 * Environment variables (override CLI):
 *   CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET — for dev/uat/stg Access gates.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
function arg(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
}
const HOST = arg('--host', 'https://vote.cogs.it.com').replace(/\/$/, '');
const CONCURRENCY = Number(arg('--concurrency', '4'));
const DELAY_MS = Number(arg('--delay-ms', '250'));
const DRY_RUN = args.includes('--dry-run');
const SKIP_MEMBERS = args.includes('--skip-members');
const SKIP_VOTES = args.includes('--skip-votes');
const ORIGIN = 'https://trackukraine.com';

const ACCESS_ID = process.env.CF_ACCESS_CLIENT_ID ?? arg('--access-id', '');
const ACCESS_SECRET = process.env.CF_ACCESS_CLIENT_SECRET ?? arg('--access-secret', '');

const baseHeaders = { Origin: ORIGIN };
if (ACCESS_ID) baseHeaders['CF-Access-Client-Id'] = ACCESS_ID;
if (ACCESS_SECRET) baseHeaders['CF-Access-Client-Secret'] = ACCESS_SECRET;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { headers: baseHeaders });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function warmUrl(url) {
  const res = await fetch(url, { headers: baseHeaders });
  return res.status;
}

/**
 * Run `work` items through a bounded pool, pacing each completed hit by
 * DELAY_MS / CONCURRENCY so that steady-state throughput stays below the
 * per-IP rate limit. Returns { ok, failures:[{key,status}] }.
 */
async function pacedPool(work, describe) {
  const queue = [...work];
  const total = queue.length;
  let ok = 0;
  const failures = [];
  let done = 0;
  const perWorkerPause = Math.max(0, DELAY_MS);
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const item = queue.shift();
      if (!item) return;
      try {
        const status = await warmUrl(item.url);
        if (status >= 200 && status < 300) ok++;
        else failures.push({ key: item.key, status });
      } catch (e) {
        failures.push({ key: item.key, status: e.message });
      }
      done++;
      if (done % 25 === 0) {
        console.log(`  ${describe}: ${done}/${total} (${ok} ok, ${failures.length} failed)`);
      }
      if (perWorkerPause > 0) await sleep(perWorkerPause);
    }
  });
  await Promise.all(workers);
  console.log(`  ${describe}: done — ${ok} ok, ${failures.length} failed`);
  if (failures.length) {
    const sample = failures.slice(0, 10).map((f) => `${f.key}:${f.status}`).join(', ');
    console.log(`    sample failures: ${sample}${failures.length > 10 ? ` …+${failures.length - 10}` : ''}`);
  }
  return { ok, failures };
}

async function collectBioguides() {
  const bioguides = new Set();
  let offset = 0;
  const limit = 250;
  console.log(`Collecting bioguides from /api/congress/v3/member…`);
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
  return [...bioguides];
}

function collectCuratedVotes() {
  // ukraineBills.json is the curator's source of truth for Ukraine roll-calls.
  const p = resolve(__dirname, '..', 'src', 'data', 'ukraineBills.json');
  const bills = JSON.parse(readFileSync(p, 'utf8'));
  const house = [];
  const senate = [];
  for (const b of bills) {
    for (const v of b.votes ?? []) {
      if (v.chamber === 'House') {
        house.push({ congress: v.congress, session: v.session, rollCall: v.rollCall });
      } else if (v.chamber === 'Senate') {
        senate.push({ congress: v.congress, session: v.session, rollCall: v.rollCall });
      }
    }
  }
  return { house, senate };
}

// v2.5.2: roll-call roster URLs per AC-32.15 / api-contracts.md §5.5.
// These routes are KV-backed and immutable-cached; the warmer populates
// the edge cache so the first visitor to open a rep detail pays ~10 ms
// per roster read instead of waiting on a KV lookup.
function houseVoteUrl({ congress, session, rollCall }) {
  return `${HOST}/api/roll-call-rosters/house/${congress}/${session}/${rollCall}`;
}
function senateVoteUrl({ congress, session, rollCall }) {
  return `${HOST}/api/roll-call-rosters/senate/${congress}/${session}/${rollCall}`;
}

async function main() {
  console.log(`=== Warming cache against ${HOST} ===`);
  console.log(`    concurrency=${CONCURRENCY} delay-ms=${DELAY_MS}${ACCESS_ID ? ' (Access headers present)' : ''}${DRY_RUN ? ' DRY RUN' : ''}`);

  const tasks = [];
  if (!SKIP_MEMBERS) {
    const ids = await collectBioguides();
    tasks.push({
      label: '/api/members',
      items: ids.map((id) => ({ key: id, url: `${HOST}/api/members/${id}` })),
    });
  }
  if (!SKIP_VOTES) {
    const { house, senate } = collectCuratedVotes();
    console.log(`Curated votes: ${house.length} house, ${senate.length} senate`);
    tasks.push({
      label: '/api/roll-call-rosters/house/*',
      items: house.map((v) => ({ key: `h:${v.congress}:${v.session}:${v.rollCall}`, url: houseVoteUrl(v) })),
    });
    tasks.push({
      label: '/api/roll-call-rosters/senate/*',
      items: senate.map((v) => ({ key: `s:${v.congress}:${v.session}:${v.rollCall}`, url: senateVoteUrl(v) })),
    });
  }

  if (DRY_RUN) {
    for (const t of tasks) console.log(`DRY: ${t.label} (${t.items.length} items)`);
    return;
  }

  for (const t of tasks) {
    console.log(`\n--- ${t.label} (${t.items.length} items) ---`);
    await pacedPool(t.items, t.label);
  }
  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
