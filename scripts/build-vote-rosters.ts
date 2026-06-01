#!/usr/bin/env tsx
/**
 * Build src/data/ukraineVotes.json — the per-vote member rosters.
 *
 * Reads `src/data/ukraineBills.json` (output of build-curated-bills.ts),
 * iterates every curated vote, and fetches:
 *   - House votes: `api.congress.gov/v3/house-vote/{c}/{s}/{rc}/members`
 *   - Senate votes: Senate.gov LIS XML rosters
 *
 * For each vote we store a roster indexed by a stable lookup key so the
 * widget can look up a member's cast in O(1) without hitting the network.
 * See spec FR-24.
 *
 * Output shape:
 *   {
 *     "generatedAt": "2026-04-17T...",
 *     "rosters": {
 *       "House|119|1|240": {
 *         "B001315": { "cast": "Yea", "party": "D", "state": "IL", "first": "Nikki", "last": "Budzinski" },
 *         ...
 *       },
 *       "Senate|118|2|154": {
 *         // Senate XML doesn't have bioguide; we key on "last|state" for senators
 *         "Durbin|IL": { "cast": "Yea", "party": "D", "first": "Richard" },
 *         ...
 *       }
 *     }
 *   }
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { DOMParser } from 'linkedom';
import { rosterKey } from './lib/roster-key';

const KEY: string =
  process.env.CONGRESS_API_KEY ||
  (readFileSync('.env', 'utf8').match(/VITE_CONGRESS_API_KEY=(\S+)/)?.[1] ?? '');

if (!KEY) {
  console.error('No Congress.gov API key in env or .env');
  process.exit(1);
}

// ─── Types mirrored from build-curated-bills ───

interface CuratedVote {
  chamber: 'House' | 'Senate';
  congress: number;
  session: number;
  rollCall: number;
  date: string;
  weight: number;
}

interface CuratedBillFile {
  congress: number;
  type: string;
  number: string;
  votes: CuratedVote[];
}

// ─── Roster output shapes ───

interface HouseRosterEntry {
  cast: string;   // "Yea" | "Nay" | "Present" | "Not Voting"
  party: string;  // "D" | "R" | "I"
  state: string;  // "IL"
  first: string;
  last: string;
}

interface SenateRosterEntry {
  cast: string;
  party: string;
  first: string;
}

type Roster = Record<string, HouseRosterEntry | SenateRosterEntry>;

interface VoteRostersFile {
  generatedAt: string;
  rosters: Record<string, Roster>;
}

// ─── Fetchers ───

async function fetchHouseRoster(
  congress: number,
  session: number,
  rollCall: number,
): Promise<Roster | null> {
  const url = `https://api.congress.gov/v3/house-vote/${congress}/${session}/${rollCall}/members?format=json&limit=500&api_key=${KEY}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`House roster fetch ${res.status} for ${congress}/${session}/${rollCall}`);
  const data = (await res.json()) as {
    houseRollCallVoteMemberVotes?: {
      results?: Array<{
        bioguideID: string;
        firstName: string;
        lastName: string;
        voteCast: string;
        voteParty: string;
        voteState: string;
      }>;
    };
  };
  const results = data.houseRollCallVoteMemberVotes?.results ?? [];
  const roster: Roster = {};
  for (const r of results) {
    roster[r.bioguideID] = {
      cast: r.voteCast,
      party: r.voteParty,
      state: r.voteState,
      first: r.firstName,
      last: r.lastName,
    };
  }
  return roster;
}

async function fetchSenateRoster(
  congress: number,
  session: number,
  rollCall: number,
): Promise<Roster | null> {
  const padded = String(rollCall).padStart(5, '0');
  const url = `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${padded}.xml`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Senate XML ${res.status} for ${congress}/${session}/${rollCall}`);
  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, 'text/xml') as unknown as Document;
  const members = Array.from(doc.getElementsByTagName('member'));
  const roster: Roster = {};
  for (const m of members) {
    const last = m.getElementsByTagName('last_name')[0]?.textContent?.trim() ?? '';
    const first = m.getElementsByTagName('first_name')[0]?.textContent?.trim() ?? '';
    const state = m.getElementsByTagName('state')[0]?.textContent?.trim() ?? '';
    const party = m.getElementsByTagName('party')[0]?.textContent?.trim() ?? '';
    const cast = m.getElementsByTagName('vote_cast')[0]?.textContent?.trim() ?? '';
    if (!last || !state) continue;
    roster[`${last}|${state}`] = { cast, party, first } as SenateRosterEntry;
  }
  return roster;
}

// ─── Concurrency limiter ───

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

// ─── Main ───

async function main(): Promise<void> {
  const bills = JSON.parse(readFileSync('src/data/ukraineBills.json', 'utf8')) as CuratedBillFile[];

  // Flatten all votes into a single work queue, deduped by (chamber, congress, session, rollCall).
  // Multiple curated bills can reference the same vote, and we want to fetch each roster once.
  const seen = new Set<string>();
  const workQueue: CuratedVote[] = [];
  for (const bill of bills) {
    for (const v of bill.votes) {
      const key = rosterKey(v.chamber, v.congress, v.session, v.rollCall);
      if (seen.has(key)) continue;
      seen.add(key);
      workQueue.push(v);
    }
  }

  console.log(`Building rosters for ${workQueue.length} unique votes...`);
  const t0 = Date.now();

  const results = await mapWithConcurrency(workQueue, 8, async (v) => {
    try {
      const roster =
        v.chamber === 'House'
          ? await fetchHouseRoster(v.congress, v.session, v.rollCall)
          : await fetchSenateRoster(v.congress, v.session, v.rollCall);
      return { vote: v, roster, error: null as string | null };
    } catch (err) {
      return { vote: v, roster: null, error: (err as Error).message };
    }
  });

  const out: VoteRostersFile = { generatedAt: new Date().toISOString(), rosters: {} };
  let ok = 0;
  let empty = 0;
  let failed = 0;
  for (const r of results) {
    const key = rosterKey(r.vote.chamber, r.vote.congress, r.vote.session, r.vote.rollCall);
    if (r.error) {
      failed++;
      console.warn(`  FAIL ${key}: ${r.error}`);
      continue;
    }
    if (!r.roster || Object.keys(r.roster).length === 0) {
      empty++;
      console.warn(`  EMPTY ${key} (0 members in roster)`);
      continue;
    }
    out.rosters[key] = r.roster;
    ok++;
  }

  writeFileSync('src/data/ukraineVotes.json', JSON.stringify(out));
  const sizeKb = Math.round(statSync('src/data/ukraineVotes.json').size / 1024);
  console.log(
    `\nWrote src/data/ukraineVotes.json (${sizeKb} KB)` +
      `\n  ${ok} rosters written, ${empty} empty, ${failed} failed` +
      `\n  Total time: ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
