#!/usr/bin/env node
/**
 * Publish curator output to KV as atomic first-class records.
 *
 * Usage:
 *   node scripts/publish-to-kv.mjs --env <dev|uat|stg|prod> [--dry-run]
 *
 * Env required:
 *   CLOUDFLARE_API_TOKEN   — token with Workers KV:Edit scope
 *   CLOUDFLARE_ACCOUNT_ID  — account ID
 *
 * Reads:
 *   src/data/ukraineBills.json   (curated bills + votes)
 *   src/data/ukraineVotes.json   (per-roll-call member casts)
 *   [optionally] src/data/members.json — member directory (name, state, chamber, party, bioguideId)
 *                                         If absent, the script derives members
 *                                         from the vote rosters (enough for search + rendering).
 *
 * Writes (KV):
 *   bill:v1:{billId}
 *   roll-call:v1:{chamber}:{congress}:{session}:{rollCall}
 *   member:v1:{bioguideId}
 *   name-index:v1:{letter}
 *   name-index:v1:meta
 *
 * Traces to: FR-24 (revised), FR-31, FR-32, ADR-011.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const getArg = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const hasFlag = (flag) => argv.includes(flag);

const ENV = getArg('--env');
const DRY_RUN = hasFlag('--dry-run');

if (!ENV) {
  console.error('Usage: publish-to-kv.mjs --env <dev|uat|stg|prod> [--dry-run]');
  process.exit(2);
}

// Per-env KV namespace IDs — must match wrangler.toml
const NAMESPACE_IDS = {
  dev: '743b2feda53648cd8242d3b89538bfac',
  uat: '3756142363984d218d5f489151716b30',
  stg: '4ff9a8e54b82489fb9a300466bd68686',
  prod: '72d3dbce1a1d4ea4aec74b305d7995e6',
};

const namespaceId = NAMESPACE_IDS[ENV];
if (!namespaceId) {
  console.error(`Unknown env "${ENV}". Valid: dev|uat|stg|prod`);
  process.exit(2);
}

// Wrangler handles auth (CLOUDFLARE_API_TOKEN env var or OAuth from `wrangler login`).

// ─── Normalize helper mirrors proxy/lib.ts normalizeSearchKey ──────────────
function normalizeSearchKey(s) {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Load curator output ───────────────────────────────────────────────────
const bills = JSON.parse(
  readFileSync(resolve('src/data/ukraineBills.json'), 'utf8'),
);
const votesFile = JSON.parse(
  readFileSync(resolve('src/data/ukraineVotes.json'), 'utf8'),
);
const rosters = votesFile.rosters || {};

// ─── Build record collections ──────────────────────────────────────────────

/** @type {Map<string, object>} */
const billRecords = new Map();
/** @type {Map<string, object>} */
const rollCallRecords = new Map();
/** @type {Map<string, object>} */
const memberRecords = new Map();
/** @type {Map<string, Array<object>>} letter -> entries */
const nameIndexShards = new Map();

for (const b of bills) {
  const billId = `${b.type}${b.number}`;
  billRecords.set(billId, {
    billId,
    type: b.type,
    number: b.number,
    congress: b.congress,
    title: b.title,
    label: b.label,
    latestAction: b.latestAction,
    latestActionDate: b.latestActionDate,
    becameLaw: b.becameLaw,
    direction: b.direction,
    summary: b.summary,
    votes: b.votes,
    congressGovUrl: b.congressGovUrl,
  });

  for (const v of b.votes || []) {
    const rollCallId = `${v.chamber.toLowerCase()}:${v.congress}:${v.session}:${v.rollCall}`;
    rollCallRecords.set(rollCallId, {
      rollCallId,
      chamber: v.chamber,
      congress: v.congress,
      session: v.session,
      rollCall: v.rollCall,
      date: v.date,
      action: v.action,
      weight: v.weight,
      billId,
      billTitle: b.title,
    });
  }
}

// Build member records. Members are discovered across all rosters.
// House entries are keyed by bioguideId. Senate entries are keyed by "last|state" — no bioguide in the source XML.
// We'll synthesize a pseudo-bioguide for senators as SENATE|{last}|{state} until a proper
// member directory is wired in (follow-up).
for (const [rollCallKey, roster] of Object.entries(rosters)) {
  const [chamber, congress, session, rollCall] = rollCallKey.split('|');
  const rollCallId = `${chamber.toLowerCase()}:${congress}:${session}:${rollCall}`;
  const rcMeta = rollCallRecords.get(rollCallId);

  for (const [memberKey, entry] of Object.entries(roster)) {
    // House memberKey is bioguideId. Senate memberKey is "last|state".
    let bioguideId;
    let last;
    let state;
    if (chamber === 'House') {
      bioguideId = memberKey;
      last = entry.last ?? '';
      state = entry.state ?? '';
    } else {
      const [senLast, senState] = memberKey.split('|');
      last = entry.last ?? senLast ?? '';
      state = entry.state ?? senState ?? '';
      bioguideId = `S|${last}|${state}`;
    }
    let m = memberRecords.get(bioguideId);
    if (!m) {
      m = {
        bioguideId,
        first: entry.first ?? '',
        last,
        officialName: `${entry.first ?? ''} ${last}`.trim(),
        state,
        district: chamber === 'House' ? null : null, // House district not in roster; out of scope for v1 cutover
        chamber,
        party: entry.party ?? '',
        photoUrl: null,
        website: null,
        searchKey: normalizeSearchKey(`${entry.first ?? ''} ${entry.last ?? ''}`),
        ukraineVotes: [],
        ukraineScore: null, // filled below (placeholder until score pipeline integrated)
        sponsored: [],
        cosponsored: [],
        generatedAt: new Date().toISOString(),
        schemaVersion: 1,
      };
      memberRecords.set(bioguideId, m);
    }
    if (rcMeta) {
      m.ukraineVotes.push({
        rollCallId,
        cast: entry.cast,
        date: rcMeta.date,
        billId: rcMeta.billId,
        question: rcMeta.action ?? '',
        weight: rcMeta.weight,
        billTitle: rcMeta.billTitle,
      });
    }
  }
}

// Build name index shards — one entry per member per searchKey initial letter.
for (const m of memberRecords.values()) {
  const firstKey = normalizeSearchKey(m.first);
  const lastKey = normalizeSearchKey(m.last);
  const searchKeys = [firstKey, lastKey].filter((k) => k.length > 0);
  const displayName = `${m.first} ${m.last}`.trim();
  const entry = {
    bioguideId: m.bioguideId,
    displayName,
    first: m.first,
    last: m.last,
    state: m.state,
    chamber: m.chamber,
    party: m.party,
    searchKeys,
  };
  const letters = new Set();
  for (const k of searchKeys) {
    if (k[0]) letters.add(k[0]);
  }
  for (const letter of letters) {
    if (!nameIndexShards.has(letter)) nameIndexShards.set(letter, []);
    nameIndexShards.get(letter).push(entry);
  }
}

// ─── Summary + dry-run output ──────────────────────────────────────────────
const totalRecords =
  billRecords.size + rollCallRecords.size + memberRecords.size + nameIndexShards.size + 1; // +1 for meta

console.log(`Env: ${ENV}`);
console.log(`Namespace: ${namespaceId}`);
console.log(`Records to write:`);
console.log(`  bill:v1:*          ${billRecords.size}`);
console.log(`  roll-call:v1:*     ${rollCallRecords.size}`);
console.log(`  member:v1:*        ${memberRecords.size}`);
console.log(`  name-index:v1:*    ${nameIndexShards.size} shards + 1 meta`);
console.log(`  ---------`);
console.log(`  total              ${totalRecords}`);

if (DRY_RUN) {
  console.log('\n--dry-run: no KV writes performed');
  process.exit(0);
}

// ─── Write via wrangler kv bulk put ────────────────────────────────────────
// Assemble pairs; roll-calls/bills/members/shards first, meta LAST.
const allPairs = [];
for (const [id, rec] of billRecords) allPairs.push({ key: `bill:v1:${id}`, value: JSON.stringify(rec) });
for (const [id, rec] of rollCallRecords) allPairs.push({ key: `roll-call:v1:${id}`, value: JSON.stringify(rec) });
for (const [id, rec] of memberRecords) allPairs.push({ key: `member:v1:${id}`, value: JSON.stringify(rec) });
for (const [letter, entries] of nameIndexShards) {
  allPairs.push({
    key: `name-index:v1:${letter}`,
    value: JSON.stringify({
      letter,
      generatedAt: new Date().toISOString(),
      entries,
    }),
  });
}
allPairs.push({
  key: 'name-index:v1:meta',
  value: JSON.stringify({
    generatedAt: new Date().toISOString(),
    shardLetters: [...nameIndexShards.keys()].sort(),
    totalMembers: memberRecords.size,
  }),
});

// Write pairs to a temp file, then invoke wrangler (uses OAuth/API token seamlessly).
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'kvbulk-'));
const payloadPath = join(dir, 'bulk.json');
writeFileSync(payloadPath, JSON.stringify(allPairs), 'utf8');

const wranglerEnvFlag = ENV === 'prod' ? '' : `--env ${ENV}`;
const cmd = `npx wrangler kv bulk put --binding KV_VOTER_INFO ${wranglerEnvFlag} --remote ${payloadPath}`.trim();
console.log(`\nRunning: ${cmd}`);
try {
  execSync(cmd, { stdio: 'inherit' });
  console.log(`\n✓ Wrote ${allPairs.length} KV records to ${ENV} namespace.`);
} catch (err) {
  console.error('Bulk put failed:', err.message);
  process.exit(1);
}
