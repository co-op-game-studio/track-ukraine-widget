#!/usr/bin/env tsx
/**
 * Compute per-party Ukraine-score priors and write to KV.
 *
 * Implements ADR-018 §6: "Party prior is computed at publish time (FR-51), not
 * render time. It is carried in `member:v1:{bioguideId}` as `partyPrior`."
 *
 * Pipeline:
 *   1. Read curated bills (`src/data/ukraineBills.json`) → directional valence
 *      per roll-call vote.
 *   2. Read pre-fetched rosters (`src/data/ukraineVotes.json`) → every rep's
 *      cast on every curated vote.
 *   3. For each rep: collect their actions, run `computeUkraineScore` (no
 *      shrink — we're computing the prior itself, recursion would be silly).
 *   4. Filter to reps with `confidenceTier === 'full'` so we don't pollute
 *      the prior with under-evidenced reps.
 *   5. Group by `party`, take the arithmetic mean of `score`. Write the
 *      result to KV at `scores:v1:party-priors`.
 *
 * The Worker's read-through fill for `member:v1:{bioguide}` reads this key
 * and stamps `partyPrior` onto each cached MemberProfile. Frontend reads it
 * and feeds into `computeUkraineScore` for shrink (FR-55, ADR-018 §1-5).
 *
 * Usage:
 *   tsx scripts/compute-party-priors.ts --env <dev|uat|stg|prod> [--dry-run]
 *
 * Auth: relies on wrangler.
 *
 * Traces: ADR-018 §6, FR-51, FR-55.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  computeUkraineScore,
  MODERATE_CONFIDENCE_THRESHOLD,
  type ScoreInput,
} from '../src/services/ukraineScore';
import type { Valence } from '../src/services/valence';

/* ─── CLI ───────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const getArg = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const ENV = getArg('--env');
const DRY_RUN = argv.includes('--dry-run');

if (!ENV || !['dev', 'uat', 'stg', 'prod'].includes(ENV)) {
  console.error('Usage: tsx scripts/compute-party-priors.ts --env <dev|uat|stg|prod> [--dry-run]');
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

/* ─── Curated source types ──────────────────────────────────────────────── */

interface CuratedVote {
  chamber: 'House' | 'Senate';
  congress: number;
  session: number;
  rollCall: number;
  weight: number;
}

interface CuratedBill {
  congress: number;
  type: string;
  number: string;
  /** "pro-ukraine" | "anti-ukraine" | "ambiguous". The bill's editorial
   *  direction — combined with the rep's vote to derive valence. */
  direction: 'pro-ukraine' | 'anti-ukraine' | 'ambiguous';
  votes?: CuratedVote[];
}

interface RosterEntry {
  cast: string;     // "Yea" | "Nay" | "Aye" | "No" | "Present" | "Not Voting"
  party: string;    // "D" | "R" | "I"
}

type Roster = Record<string, RosterEntry>;

interface VoteRostersFile {
  generatedAt: string;
  rosters: Record<string, Roster>;
}

/* ─── Valence derivation ────────────────────────────────────────────────── */

/**
 * Derive a rep's valence on a single roll-call vote.
 *
 * Pro-Ukraine bill + Yea = voted-pro
 * Pro-Ukraine bill + Nay = voted-anti
 * Anti-Ukraine bill + Yea = voted-anti
 * Anti-Ukraine bill + Nay = voted-pro
 * Ambiguous bill        = unstated (no signal in either direction)
 * Not Voting / Present  = unstated
 */
function deriveValence(
  cast: string,
  billDirection: CuratedBill['direction'],
): Valence | null {
  const c = cast.toLowerCase();
  if (c !== 'yea' && c !== 'aye' && c !== 'nay' && c !== 'no') return null;
  if (billDirection === 'ambiguous') return null;
  const isYea = c === 'yea' || c === 'aye';
  const isPro = billDirection === 'pro-ukraine';
  // Yea on a pro bill = pro action; Nay on a pro bill = anti action; etc.
  return (isYea === isPro) ? 'voted-pro' : 'voted-anti';
}

/** Roll-call key as produced by build-vote-rosters.ts — must match exactly. */
function rosterKey(chamber: 'House' | 'Senate', c: number, s: number, rc: number): string {
  return `${chamber === 'House' ? 'h' : 's'}/${c}/${s}/${rc}`;
}

/* ─── Main ──────────────────────────────────────────────────────────────── */

function main(): void {
  console.log(`[party-priors] env=${ENV} dry-run=${DRY_RUN}`);

  const billsPath = join(process.cwd(), 'src/data/ukraineBills.json');
  const rostersPath = join(process.cwd(), 'src/data/ukraineVotes.json');
  const bills = JSON.parse(readFileSync(billsPath, 'utf8')) as CuratedBill[];
  const rosterFile = JSON.parse(readFileSync(rostersPath, 'utf8')) as VoteRostersFile;
  const rosters = rosterFile.rosters;

  // Per-rep accumulator: { bioguideId → { party, actions[] } }
  const byRep = new Map<string, { party: string; actions: ScoreInput[] }>();

  for (const bill of bills) {
    if (!bill.votes || bill.votes.length === 0) continue;
    if (bill.direction !== 'pro-ukraine' && bill.direction !== 'anti-ukraine') continue;
    for (const v of bill.votes) {
      const key = rosterKey(v.chamber, v.congress, v.session, v.rollCall);
      const roster = rosters[key];
      if (!roster) continue; // roster fetch may have failed; skip silently
      for (const [bioguideId, entry] of Object.entries(roster)) {
        const valence = deriveValence(entry.cast, bill.direction);
        if (!valence) continue;
        const slot = byRep.get(bioguideId) ?? { party: entry.party, actions: [] };
        slot.actions.push({ valence, weight: v.weight });
        byRep.set(bioguideId, slot);
      }
    }
  }

  // Compute per-rep scores. Filter to reps at full confidence so the prior
  // isn't biased by under-evidenced reps (which is exactly the scenario the
  // prior is meant to correct in the first place).
  const fullConfidenceReps: Array<{ party: string; score: number }> = [];
  let underconfident = 0;
  for (const [, slot] of byRep) {
    if (slot.actions.length < MODERATE_CONFIDENCE_THRESHOLD) {
      underconfident++;
      continue;
    }
    // Compute WITHOUT priors so we get the raw rep-truth score, not a
    // self-referential shrink-of-shrunken-scores. (We ARE the prior.)
    const result = computeUkraineScore(slot.actions);
    if (result.score === null) continue;
    if (result.confidenceTier !== 'full') continue;
    fullConfidenceReps.push({ party: slot.party, score: result.score });
  }

  // Group by party + arithmetic mean.
  const byParty = new Map<string, number[]>();
  for (const r of fullConfidenceReps) {
    const list = byParty.get(r.party) ?? [];
    list.push(r.score);
    byParty.set(r.party, list);
  }

  const priors: Record<string, number | null> = {};
  for (const [party, scores] of byParty) {
    if (scores.length < 5) {
      // Fewer than 5 reps in a party at full confidence → degenerate-population
      // fallback. ADR-018: `partyPrior === null` → no shrink, raw score wins.
      priors[party] = null;
      continue;
    }
    const sum = scores.reduce((a, b) => a + b, 0);
    priors[party] = sum / scores.length;
  }

  console.log(`[party-priors] reps_seen=${byRep.size} full_confidence=${fullConfidenceReps.length} underconfident=${underconfident}`);
  for (const [party, scores] of byParty) {
    const prior = priors[party] ?? null;
    const display = prior === null ? 'null (cold-start)' : prior.toFixed(4);
    console.log(`[party-priors]   party=${party}  n=${scores.length}  prior=${display}`);
  }

  const record = {
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    priors,
  };

  if (DRY_RUN) {
    console.log('[party-priors] --dry-run: skipping KV write');
    console.log(JSON.stringify(record, null, 2));
    return;
  }

  // Write to KV via wrangler (avoids needing an API token in this script;
  // matches the auth posture of publish-to-kv.ts).
  const tmp = mkdtempSync(join(tmpdir(), 'party-priors-'));
  const outPath = join(tmp, 'priors.json');
  writeFileSync(outPath, JSON.stringify(record));
  const cmd = `npx wrangler kv key put --namespace-id ${namespaceId} "scores:v1:party-priors" --path "${outPath}" --remote`;
  console.log(`[party-priors] writing to KV namespace ${namespaceId}…`);
  execSync(cmd, { stdio: 'inherit' });
  console.log('[party-priors] done.');
}

main();
