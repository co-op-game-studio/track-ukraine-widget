#!/usr/bin/env tsx
/**
 * Publish the lightweight curator output to KV.
 *
 * Writes three prefix families:
 *   bill:v1:{billId}                        — curated bill metadata
 *   roll-call:v1:{chamber}:{c}:{s}:{rc}     — immutable roll-call metadata
 *   name-index:v1:{letter}                  — derived name-search shards
 *   name-index:v1:meta                      — readiness sentinel
 *
 * Does NOT write member:v1:* records. Those are filled by the Worker on
 * cache miss via a read-through (ADR-011, revised v2.5.1).
 *
 * Usage:
 *   tsx scripts/publish-to-kv.ts --env <dev|uat|stg|prod> [--dry-run]
 *
 * Auth: relies on wrangler (CLOUDFLARE_API_TOKEN env or `wrangler login` OAuth).
 *
 * Traces: FR-24 (revised), FR-31, FR-32, ADR-011.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

// ─── CLI flags ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const getArg = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const ENV = getArg('--env');
const DRY_RUN = argv.includes('--dry-run');

if (!ENV || !['dev', 'uat', 'stg', 'prod'].includes(ENV)) {
  console.error('Usage: tsx scripts/publish-to-kv.ts --env <dev|uat|stg|prod> [--dry-run]');
  process.exit(2);
}

// Per-env KV namespace IDs — must match wrangler.toml.
const NAMESPACE_IDS: Record<string, string> = {
  dev: '743b2feda53648cd8242d3b89538bfac',
  uat: '3756142363984d218d5f489151716b30',
  stg: '4ff9a8e54b82489fb9a300466bd68686',
  prod: '72d3dbce1a1d4ea4aec74b305d7995e6',
};

const namespaceId = NAMESPACE_IDS[ENV]!;

// ─── Shared helpers ─────────────────────────────────────────────────────────
function normalizeSearchKey(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Congress.gov API key from env or .env.
const CONGRESS_API_KEY: string =
  process.env.CONGRESS_API_KEY ??
  (() => {
    try {
      const env = readFileSync(resolve('.env'), 'utf8');
      return env.match(/VITE_CONGRESS_API_KEY=(\S+)/)?.[1] ?? env.match(/CONGRESS_API_KEY=(\S+)/)?.[1] ?? '';
    } catch {
      return '';
    }
  })();

if (!CONGRESS_API_KEY) {
  console.error('CONGRESS_API_KEY required (env or .env)');
  process.exit(2);
}

// ─── Types ──────────────────────────────────────────────────────────────────
interface CongressMemberListEntry {
  bioguideId: string;
  name: string;
  partyName: string;
  state: string;
  district?: number;
  terms: {
    item: {
      chamber: 'House of Representatives' | 'Senate';
      startYear: number;
      endYear?: number;
      stateCode?: string;
    }[];
  };
  depiction?: { imageUrl?: string };
}

// Fallback state-name → state-code map (used when Congress.gov doesn't
// emit stateCode on the terms item — rare but happens).
const STATE_NAME_TO_CODE: Record<string, string> = {
  'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR',
  'California': 'CA', 'Colorado': 'CO', 'Connecticut': 'CT', 'Delaware': 'DE',
  'District of Columbia': 'DC', 'Florida': 'FL', 'Georgia': 'GA', 'Hawaii': 'HI',
  'Idaho': 'ID', 'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA',
  'Kansas': 'KS', 'Kentucky': 'KY', 'Louisiana': 'LA', 'Maine': 'ME',
  'Maryland': 'MD', 'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN',
  'Mississippi': 'MS', 'Missouri': 'MO', 'Montana': 'MT', 'Nebraska': 'NE',
  'Nevada': 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM',
  'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', 'Ohio': 'OH',
  'Oklahoma': 'OK', 'Oregon': 'OR', 'Pennsylvania': 'PA', 'Rhode Island': 'RI',
  'South Carolina': 'SC', 'South Dakota': 'SD', 'Tennessee': 'TN', 'Texas': 'TX',
  'Utah': 'UT', 'Vermont': 'VT', 'Virginia': 'VA', 'Washington': 'WA',
  'West Virginia': 'WV', 'Wisconsin': 'WI', 'Wyoming': 'WY',
  'American Samoa': 'AS', 'Guam': 'GU', 'Northern Mariana Islands': 'MP',
  'Puerto Rico': 'PR', 'Virgin Islands': 'VI',
};

interface CuratedVote {
  chamber: 'House' | 'Senate';
  congress: number;
  session: number;
  rollCall: number;
  date: string;
  action?: string;
  weight: number;
  kind?: string;
}

interface CuratedBill {
  congress: number;
  type: string;
  number: string;
  title: string;
  label?: string;
  latestAction?: string;
  latestActionDate?: string;
  becameLaw?: boolean;
  congressGovUrl?: string;
  direction: string;
  summary?: { text?: string; actionDate?: string; actionDesc?: string; updateDate?: string };
  votes?: CuratedVote[];
}

interface NameIndexEntry {
  bioguideId: string;
  displayName: string;
  first: string;
  last: string;
  state: string;
  chamber: 'Senate' | 'House';
  party: string;
  photoUrl: string | null;
  searchKeys: string[];
}

// ─── Fetch current-Congress members from Congress.gov ────────────────────────
async function fetchAllCurrentMembers(): Promise<CongressMemberListEntry[]> {
  const PAGE = 250;
  const out: CongressMemberListEntry[] = [];
  let offset = 0;
  while (true) {
    const url = `https://api.congress.gov/v3/member?currentMember=true&limit=${PAGE}&offset=${offset}&format=json&api_key=${CONGRESS_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Congress.gov member list ${res.status} @ offset=${offset}`);
    const data = (await res.json()) as { members: CongressMemberListEntry[] };
    out.push(...(data.members ?? []));
    if (!data.members || data.members.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}

function partyLetter(partyName: string): string {
  const p = partyName.toLowerCase();
  if (p.startsWith('democrat')) return 'D';
  if (p.startsWith('republican')) return 'R';
  if (p.startsWith('independent')) return 'I';
  if (p.startsWith('libertarian')) return 'L';
  if (p.startsWith('green')) return 'G';
  return partyName.charAt(0).toUpperCase();
}

function splitName(full: string): { first: string; last: string } {
  // Congress.gov formats as "Last, First" — e.g., "Durbin, Richard J."
  const [last = '', rest = ''] = full.split(',').map((s) => s.trim());
  // first name = first word of the rest segment
  const first = rest.split(' ')[0] ?? '';
  return { first, last };
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`Env: ${ENV}    Namespace: ${namespaceId}`);

  // 1. Curated bills (from file — curated manually, rarely changes)
  const bills: CuratedBill[] = JSON.parse(
    readFileSync(resolve('src/data/ukraineBills.json'), 'utf8'),
  );
  console.log(`Loaded ${bills.length} curated bills`);

  // 2. Fetch live member directory — source of truth for canonical bioguides
  console.log('Fetching current-Congress member directory...');
  const members = await fetchAllCurrentMembers();
  console.log(`Fetched ${members.length} current members`);

  // ─── Build record collections ─────────────────────────────────────────────

  const billRecords = new Map<string, unknown>();
  const rollCallRecords = new Map<string, unknown>();
  const nameIndexShards = new Map<string, NameIndexEntry[]>();

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
    for (const v of b.votes ?? []) {
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

  // Build name-index from the live member list (canonical bioguides).
  for (const m of members) {
    const termItems = m.terms?.item ?? [];
    const latestTerm = termItems[termItems.length - 1];
    if (!latestTerm) continue;
    const chamber = latestTerm.chamber === 'Senate' ? ('Senate' as const) : ('House' as const);
    const { first, last } = splitName(m.name);
    if (!first || !last) continue;

    const firstKey = normalizeSearchKey(first);
    const lastKey = normalizeSearchKey(last);
    const searchKeys = [firstKey, lastKey].filter(Boolean);
    // Prefer the term's stateCode when present; fall back to mapping the
    // full state name via STATE_NAME_TO_CODE.
    const stateCode =
      latestTerm?.stateCode ??
      STATE_NAME_TO_CODE[m.state] ??
      m.state;
    const entry: NameIndexEntry = {
      bioguideId: m.bioguideId,
      displayName: `${first} ${last}`,
      first,
      last,
      state: stateCode,
      chamber,
      party: partyLetter(m.partyName),
      photoUrl: m.depiction?.imageUrl ?? null,
      searchKeys,
    };

    const letters = new Set<string>();
    for (const k of searchKeys) {
      const c = k[0];
      if (c) letters.add(c);
    }
    for (const letter of letters) {
      if (!nameIndexShards.has(letter)) nameIndexShards.set(letter, []);
      nameIndexShards.get(letter)!.push(entry);
    }
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log(`Records to write:`);
  console.log(`  bill:v1:*          ${billRecords.size}`);
  console.log(`  roll-call:v1:*     ${rollCallRecords.size}`);
  console.log(`  name-index:v1:*    ${nameIndexShards.size} shards + 1 meta`);

  // ─── Assemble pairs (meta LAST per ADR-011) ──────────────────────────────
  const pairs: { key: string; value: string }[] = [];
  for (const [id, rec] of billRecords) pairs.push({ key: `bill:v1:${id}`, value: JSON.stringify(rec) });
  for (const [id, rec] of rollCallRecords) pairs.push({ key: `roll-call:v1:${id}`, value: JSON.stringify(rec) });
  for (const [letter, entries] of nameIndexShards) {
    pairs.push({
      key: `name-index:v1:${letter}`,
      value: JSON.stringify({
        letter,
        generatedAt: new Date().toISOString(),
        entries,
      }),
    });
  }
  pairs.push({
    key: 'name-index:v1:meta',
    value: JSON.stringify({
      generatedAt: new Date().toISOString(),
      shardLetters: [...nameIndexShards.keys()].sort(),
      totalMembers: members.length,
    }),
  });

  console.log(`Total KV records: ${pairs.length}`);

  if (DRY_RUN) {
    console.log('--dry-run: no writes performed');
    return;
  }

  // ─── Write via wrangler kv bulk put ──────────────────────────────────────
  const dir = mkdtempSync(join(tmpdir(), 'kvbulk-'));
  const payloadPath = join(dir, 'bulk.json');
  writeFileSync(payloadPath, JSON.stringify(pairs), 'utf8');

  const wranglerEnvFlag = ENV === 'prod' ? '' : `--env ${ENV}`;
  const cmd = `npx wrangler kv bulk put --binding KV_VOTER_INFO ${wranglerEnvFlag} --remote ${payloadPath}`.trim();
  console.log(`Running: ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
  console.log(`\n✓ Wrote ${pairs.length} KV records to ${ENV} namespace.`);
})().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
