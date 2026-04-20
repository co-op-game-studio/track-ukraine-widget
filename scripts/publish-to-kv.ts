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
import { DOMParser } from 'linkedom';

// ─── CLI flags ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const getArg = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const ENV = getArg('--env');
const DRY_RUN = argv.includes('--dry-run');
// Phase-skip flags (useful for incremental runs / debugging).
const SKIP_ROSTERS = argv.includes('--skip-rosters');
const SKIP_STATE_MEMBERS = argv.includes('--skip-state-members');

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

interface MemberSocials {
  twitter?: string;
  facebook?: string;
  youtube?: string;
  instagram?: string;
}

interface NameIndexEntry {
  bioguideId: string;
  displayName: string;
  first: string;
  last: string;
  state: string;
  chamber: 'Senate' | 'House';
  /** House district number. Null for Senators and non-voting delegates
   *  (Congress.gov omits `district` for those). */
  district: number | null;
  party: string;
  photoUrl: string | null;
  searchKeys: string[];
  /** Earliest term start year — populated via the per-member detail
   *  endpoint during the curator build. Matches state-members:v1:*
   *  so every chip (address-lookup AND name-search origin) renders
   *  "Since YYYY" from the initial shard payload. Optional on older
   *  shards; the widget treats missing as "don't render the row." */
  yearEntered?: number;
  /** Social-media handles (FR-48) — sourced from
   *  unitedstates/congress-legislators. */
  socials?: MemberSocials;
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

/**
 * FR-48 — fetch social-media handles from the
 * unitedstates/congress-legislators dataset. One HTTP request, joined by
 * bioguide id. Transient failures are logged but do not fail the curator
 * run (per AC-48.1).
 */
async function fetchSocialsMap(): Promise<Map<string, MemberSocials>> {
  const result = new Map<string, MemberSocials>();
  const url = 'https://unitedstates.github.io/congress-legislators/legislators-social-media.json';
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`  FR-48 socials fetch: ${res.status} — continuing with empty map`);
      return result;
    }
    const body = (await res.json()) as Array<{
      id?: { bioguide?: string };
      social?: Record<string, unknown>;
    }>;
    for (const entry of body) {
      const bid = entry.id?.bioguide;
      if (!bid || !entry.social) continue;
      const s: MemberSocials = {};
      if (typeof entry.social.twitter === 'string')   s.twitter = entry.social.twitter;
      if (typeof entry.social.facebook === 'string')  s.facebook = entry.social.facebook;
      if (typeof entry.social.youtube === 'string')   s.youtube = entry.social.youtube;
      if (typeof entry.social.instagram === 'string') s.instagram = entry.social.instagram;
      if (Object.keys(s).length > 0) result.set(bid, s);
    }
  } catch (err) {
    console.warn(`  FR-48 socials fetch threw: ${(err as Error).message} — continuing with empty map`);
  }
  return result;
}

/**
 * Per-member detail fetch — the list endpoint's `terms.item.startYear`
 * is only populated for the CURRENT term (confirmed empirically
 * 2026-04-19), so to get a member's earliest term-start-year we have
 * to hit `/v3/member/{bioguideId}` which returns the full `terms`
 * array. Batched with bounded concurrency so we respect the 5000/hr
 * rate limit.
 */
async function fetchYearEnteredMap(members: CongressMemberListEntry[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const CONCURRENCY = 8;
  let idx = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = idx++;
      if (i >= members.length) return;
      const bid = members[i]!.bioguideId;
      try {
        const url = `https://api.congress.gov/v3/member/${bid}?format=json&api_key=${CONGRESS_API_KEY}`;
        const res = await fetch(url);
        if (!res.ok) continue; // skip silently — chip falls back to no "since" row
        const body = (await res.json()) as {
          member?: { terms?: { item?: { startYear?: number }[] } | { startYear?: number }[] };
        };
        const rawTerms = body.member?.terms;
        const terms = Array.isArray(rawTerms) ? rawTerms : (rawTerms?.item ?? []);
        let earliest: number | undefined;
        for (const t of terms) {
          if (typeof t.startYear === 'number') {
            if (earliest === undefined || t.startYear < earliest) earliest = t.startYear;
          }
        }
        if (earliest !== undefined) result.set(bid, earliest);
      } catch {
        /* skip on transient failure */
      }
    }
  }
  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);
  return result;
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

// ─── Roll-call roster fetchers (T-036 / AC-32.15) ────────────────────────────
//
// One pair of functions per chamber. Each returns the casts field of the
// roll-call-roster:v1:* record — the caller wraps with the envelope
// (rollCallId, chamber, congress, session, rollCall, generatedAt,
// schemaVersion) before writing.

interface HouseRosterCasts {
  [bioguideId: string]: string; // "Yea" | "Nay" | "Present" | "Not Voting"
}

interface SenateRosterCast {
  lastName: string;
  state: string;
  cast: string;
  firstName?: string;
  party?: string;
}

async function fetchHouseRosterCasts(
  congress: number,
  session: number,
  rollCall: number,
): Promise<HouseRosterCasts | null> {
  const url = `https://api.congress.gov/v3/house-vote/${congress}/${session}/${rollCall}/members?format=json&limit=500&api_key=${CONGRESS_API_KEY}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`House roster ${res.status} for ${congress}/${session}/${rollCall}`);
  }
  const data = (await res.json()) as {
    houseRollCallVoteMemberVotes?: {
      results?: Array<{ bioguideID: string; voteCast: string }>;
    };
  };
  const results = data.houseRollCallVoteMemberVotes?.results ?? [];
  const casts: HouseRosterCasts = {};
  for (const r of results) {
    if (!r.bioguideID) continue;
    casts[r.bioguideID] = r.voteCast;
  }
  return casts;
}

async function fetchSenateRosterCasts(
  congress: number,
  session: number,
  rollCall: number,
): Promise<SenateRosterCast[] | null> {
  const padded = String(rollCall).padStart(5, '0');
  const url = `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${padded}.xml`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Senate XML ${res.status} for ${congress}/${session}/${rollCall}`);
  }
  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, 'text/xml') as unknown as Document;
  const members = Array.from(doc.getElementsByTagName('member'));
  const casts: SenateRosterCast[] = [];
  for (const m of members) {
    const lastName = m.getElementsByTagName('last_name')[0]?.textContent?.trim() ?? '';
    const firstName = m.getElementsByTagName('first_name')[0]?.textContent?.trim() ?? '';
    const state = m.getElementsByTagName('state')[0]?.textContent?.trim() ?? '';
    const party = m.getElementsByTagName('party')[0]?.textContent?.trim() ?? '';
    const cast = m.getElementsByTagName('vote_cast')[0]?.textContent?.trim() ?? '';
    if (!lastName || !state) continue;
    casts.push({ lastName, state, cast, firstName, party });
  }
  return casts;
}

/** Bounded-concurrency map — duplicated from scripts/build-vote-rosters.ts;
 *  kept local to avoid cross-script imports in a tsx context. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
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

  // 2b. Fetch per-member earliest-term year. The list endpoint only
  // returns the current term's startYear, so we need the detail endpoint
  // to compute "serving since YYYY" for each member. Feeds BOTH the
  // name-index and the state-members shards so every chip (address-
  // lookup AND name-search origin) has the field. Bounded concurrency.
  console.log('Fetching per-member term histories for yearEntered...');
  const t0 = Date.now();
  const yearEnteredMap = await fetchYearEnteredMap(members);
  console.log(`  got yearEntered for ${yearEnteredMap.size}/${members.length} members in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // FR-48 — social handles from the unitedstates/congress-legislators
  // dataset. Joined by bioguide id so we can stamp into member-profile,
  // state-members, and name-index shards in the same trip.
  console.log('Fetching social-media handles (unitedstates/congress-legislators)...');
  const socialsMap = await fetchSocialsMap();
  console.log(`  got socials for ${socialsMap.size} members`);

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
      district: chamber === 'House' ? (m.district ?? null) : null,
      party: partyLetter(m.partyName),
      photoUrl: m.depiction?.imageUrl ?? null,
      searchKeys,
      yearEntered: yearEnteredMap.get(m.bioguideId),
      socials: socialsMap.get(m.bioguideId),
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

  // ─── T-036 / AC-32.15: Build roll-call-roster:v1:* records ──────────────
  //
  // Iterate every unique curated vote and fetch its upstream roster.
  // Skipped when --skip-rosters is passed. The curator fails the run on any
  // fetch error — no silent partial write per ADR-012.

  const rollCallRosterRecords = new Map<string, unknown>();
  if (!SKIP_ROSTERS) {
    const seenVotes = new Set<string>();
    const voteQueue: Array<{
      chamber: 'House' | 'Senate';
      congress: number;
      session: number;
      rollCall: number;
    }> = [];
    for (const b of bills) {
      for (const v of b.votes ?? []) {
        const k = `${v.chamber}|${v.congress}|${v.session}|${v.rollCall}`;
        if (seenVotes.has(k)) continue;
        seenVotes.add(k);
        voteQueue.push({ chamber: v.chamber, congress: v.congress, session: v.session, rollCall: v.rollCall });
      }
    }
    console.log(`Fetching rosters for ${voteQueue.length} unique curated votes...`);
    const t0 = Date.now();
    let fetchErrors = 0;
    const generatedAt = new Date().toISOString();
    await mapWithConcurrency(voteQueue, 6, async (v) => {
      const keyTail = `${v.chamber.toLowerCase()}:${v.congress}:${v.session}:${v.rollCall}`;
      try {
        if (v.chamber === 'House') {
          const casts = await fetchHouseRosterCasts(v.congress, v.session, v.rollCall);
          if (!casts) {
            console.warn(`  404 ${keyTail} — skipping`);
            return;
          }
          rollCallRosterRecords.set(keyTail, {
            rollCallId: keyTail,
            chamber: 'house',
            congress: v.congress,
            session: v.session,
            rollCall: v.rollCall,
            casts,
            generatedAt,
            schemaVersion: 1,
          });
        } else {
          const casts = await fetchSenateRosterCasts(v.congress, v.session, v.rollCall);
          if (!casts) {
            console.warn(`  404 ${keyTail} — skipping`);
            return;
          }
          rollCallRosterRecords.set(keyTail, {
            rollCallId: keyTail,
            chamber: 'senate',
            congress: v.congress,
            session: v.session,
            rollCall: v.rollCall,
            casts,
            generatedAt,
            schemaVersion: 1,
          });
        }
      } catch (err) {
        fetchErrors++;
        console.warn(`  FAIL ${keyTail} — ${(err as Error).message}`);
      }
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  ${rollCallRosterRecords.size} rosters fetched in ${secs}s (${fetchErrors} errors)`);
    if (fetchErrors > 0) {
      throw new Error(`roll-call-roster fetch had ${fetchErrors} errors — aborting to avoid partial KV write`);
    }
  }

  // ─── T-038 / AC-32.16: Build state-members:v1:* records ──────────────────
  //
  // Pre-group the current-Congress member directory by two-letter stateCode.
  // Uses the same `members` collection already fetched for the name-index.
  // Senators first (district=null), House sorted by district ascending.

  const stateMembersRecords = new Map<string, unknown>();
  if (!SKIP_STATE_MEMBERS) {
    interface MemberSummary {
      bioguideId: string;
      first: string;
      last: string;
      officialName: string;
      state: string;
      district: number | null;
      chamber: 'Senate' | 'House';
      party: string;
      photoUrl: string | null;
      website: string | null;
      isNonVoting?: boolean;
      yearEntered?: number;
      socials?: MemberSocials;
    }
    const grouped = new Map<string, { senators: MemberSummary[]; house: MemberSummary[] }>();
    for (const m of members) {
      const termItems = m.terms?.item ?? [];
      const latestTerm = termItems[termItems.length - 1];
      if (!latestTerm) continue;
      const chamber: 'Senate' | 'House' = latestTerm.chamber === 'Senate' ? 'Senate' : 'House';
      const { first, last } = splitName(m.name);
      if (!first || !last) continue;
      const stateCode = latestTerm?.stateCode ?? STATE_NAME_TO_CODE[m.state] ?? m.state;
      if (!/^[A-Z]{2}$/.test(stateCode)) continue; // skip junk states
      // Earliest term start year. The list-endpoint's termItems only
      // include the CURRENT term's startYear, so prefer the per-member-
      // detail-endpoint-computed map when available; fall back to the
      // list-scoped local scan otherwise.
      let yearEntered: number | undefined = yearEnteredMap.get(m.bioguideId);
      if (yearEntered === undefined) {
        for (const t of termItems) {
          if (typeof t.startYear === 'number') {
            if (yearEntered === undefined || t.startYear < yearEntered) {
              yearEntered = t.startYear;
            }
          }
        }
      }
      const summary: MemberSummary = {
        bioguideId: m.bioguideId,
        first,
        last,
        officialName: `${first} ${last}`,
        state: stateCode,
        district: chamber === 'House' ? (m.district ?? null) : null,
        chamber,
        party: partyLetter(m.partyName),
        photoUrl: m.depiction?.imageUrl ?? null,
        website: null, // Not in the member-list response; would require per-member detail fetch.
        yearEntered,
        socials: socialsMap.get(m.bioguideId),
      };
      // Detect non-voting delegates: territories (AS/GU/MP/PR/VI) + DC are
      // House delegates but do not cast floor votes.
      if (chamber === 'House' && ['AS', 'DC', 'GU', 'MP', 'PR', 'VI'].includes(stateCode)) {
        summary.isNonVoting = true;
      }
      let bucket = grouped.get(stateCode);
      if (!bucket) {
        bucket = { senators: [], house: [] };
        grouped.set(stateCode, bucket);
      }
      if (chamber === 'Senate') bucket.senators.push(summary);
      else bucket.house.push(summary);
    }
    const stateGeneratedAt = new Date().toISOString();
    for (const [stateCode, { senators, house }] of grouped) {
      senators.sort((a, b) => a.last.localeCompare(b.last));
      house.sort((a, b) => (a.district ?? 0) - (b.district ?? 0));
      stateMembersRecords.set(stateCode, {
        stateCode,
        senators,
        house,
        generatedAt: stateGeneratedAt,
        schemaVersion: 1,
      });
    }
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log(`Records to write:`);
  console.log(`  bill:v1:*                ${billRecords.size}`);
  console.log(`  roll-call:v1:*           ${rollCallRecords.size}`);
  console.log(`  roll-call-roster:v1:*    ${rollCallRosterRecords.size}${SKIP_ROSTERS ? ' (--skip-rosters)' : ''}`);
  console.log(`  state-members:v1:*       ${stateMembersRecords.size}${SKIP_STATE_MEMBERS ? ' (--skip-state-members)' : ''}`);
  console.log(`  name-index:v1:*          ${nameIndexShards.size} shards + 1 meta`);

  // ─── Assemble pairs (meta LAST per ADR-011) ──────────────────────────────
  const pairs: { key: string; value: string }[] = [];
  for (const [id, rec] of billRecords) pairs.push({ key: `bill:v1:${id}`, value: JSON.stringify(rec) });
  for (const [id, rec] of rollCallRecords) pairs.push({ key: `roll-call:v1:${id}`, value: JSON.stringify(rec) });
  for (const [id, rec] of rollCallRosterRecords) pairs.push({ key: `roll-call-roster:v1:${id}`, value: JSON.stringify(rec) });
  for (const [stateCode, rec] of stateMembersRecords) pairs.push({ key: `state-members:v1:${stateCode}`, value: JSON.stringify(rec) });
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

  // Target by explicit namespace-id so wrangler doesn't try to resolve a
  // binding from an upstream wrangler config (which can accidentally be
  // picked up from a parent directory).
  const cmd = `npx wrangler kv bulk put --namespace-id ${namespaceId} --remote ${payloadPath}`;
  console.log(`Running: ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
  console.log(`\n✓ Wrote ${pairs.length} KV records to ${ENV} namespace.`);
})().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
