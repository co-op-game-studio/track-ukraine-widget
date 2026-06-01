#!/usr/bin/env tsx
/**
 * Compute per-party Ukraine-score priors AND augment stats:v1:summary with
 * the score-derived fields the spec calls for.
 *
 * Two outputs in one script (they share the same expensive per-rep score
 * walk, so it's silly to do them in two passes):
 *
 * 1. **scores:v1:party-priors** (FR-55 / ADR-018 §6) — per-party mean of
 *    full-confidence rep scores. Read by Worker member-profile read-through
 *    to stamp `partyPrior` on each MemberProfile. The shrink branch in
 *    `useUkraineScore` reads it for under-confident reps.
 *
 * 2. **stats:v1:summary** (FR-56 AC-56.1) — read-modify-write: the
 *    `publish-d1-to-kv` script writes `perBill` + `commentsTimeseries`
 *    (D1-derived). This script overlays `perRepHistogram`,
 *    `topAntiUkraine`, and `partyPriors` (curated-bill-+-roster-derived).
 *    Write order in the publish workflow: publish-d1-to-kv first (writes
 *    base record), then this script (overlays the score fields).
 *
 * Pipeline:
 *   1. Read curated bills (`src/data/ukraineBills.json`) → directional valence
 *      per roll-call vote.
 *   2. Read pre-fetched rosters (`src/data/ukraineVotes.json`) → every rep's
 *      cast on every curated vote.
 *   3. For each rep: collect their actions, run `computeUkraineScore` (no
 *      shrink — we're computing the prior itself, recursion would be silly).
 *   4. Per-party means filter to reps with `confidenceTier === 'full'` so
 *      the prior isn't biased by under-evidenced reps.
 *   5. perRepHistogram + topAntiUkraine: HOUSE only. Senate rosters key by
 *      `lastName|state` (no bioguide), so we can't safely surface them in
 *      a top-N list keyed by bioguide. Documented limitation.
 *
 * Usage:
 *   tsx scripts/compute-party-priors.ts --env <dev|uat|stg|prod> [--dry-run]
 *
 * Auth: relies on wrangler.
 *
 * Traces: ADR-018 §6, FR-51 AC-51.x, FR-55 AC-55.6, FR-56 AC-56.1.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  computeUkraineScore,
  type ScoreInput,
} from '../src/services/ukraineScore';
import type { Valence } from '../src/services/valence';
import { rosterKey } from './lib/roster-key';

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
  /** House rosters carry first+last+state. Senate rosters carry first+state
   *  but key by `lastName|state` (no bioguide). Both fields optional so
   *  the type accommodates both shapes. */
  first?: string;
  last?: string;
  state?: string;
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

/* Roll-call key shared with the producer (build-vote-rosters.ts) via
 * scripts/lib/roster-key.ts so the two cannot drift — see AC-32.45. */

/* ─── Main ──────────────────────────────────────────────────────────────── */

function main(): void {
  console.log(`[party-priors] env=${ENV} dry-run=${DRY_RUN}`);

  const billsPath = join(process.cwd(), 'src/data/ukraineBills.json');
  const rostersPath = join(process.cwd(), 'src/data/ukraineVotes.json');
  const bills = JSON.parse(readFileSync(billsPath, 'utf8')) as CuratedBill[];
  const rosterFile = JSON.parse(readFileSync(rostersPath, 'utf8')) as VoteRostersFile;
  const rosters = rosterFile.rosters;

  // Per-rep accumulator. Tracks chamber so the histogram + topAntiUkraine
  // walk can scope to House (where keys are real bioguide IDs).
  interface RepSlot {
    party: string;
    actions: ScoreInput[];
    chamber: 'House' | 'Senate';
    /** Display name from House rosters; '' for Senate (we don't have bioguide
     *  IDs for senators in the rosters anyway, so they're excluded from
     *  topAntiUkraine and only contribute to the per-party means). */
    displayName: string;
    /** Total weighted anti-Ukraine action mass — used for topAntiUkraine ranking. */
    weightedAntiActions: number;
  }
  const byRep = new Map<string, RepSlot>();

  for (const bill of bills) {
    if (!bill.votes || bill.votes.length === 0) continue;
    if (bill.direction !== 'pro-ukraine' && bill.direction !== 'anti-ukraine') continue;
    for (const v of bill.votes) {
      const key = rosterKey(v.chamber, v.congress, v.session, v.rollCall);
      const roster = rosters[key];
      if (!roster) continue;
      for (const [repKey, entry] of Object.entries(roster)) {
        const valence = deriveValence(entry.cast, bill.direction);
        if (!valence) continue;
        const slot = byRep.get(repKey) ?? {
          party: entry.party,
          actions: [],
          chamber: v.chamber,
          displayName: [entry.first, entry.last].filter(Boolean).join(' '),
          weightedAntiActions: 0,
        };
        slot.actions.push({ valence, weight: v.weight });
        if (valence === 'voted-anti') slot.weightedAntiActions += v.weight;
        byRep.set(repKey, slot);
      }
    }
  }

  // Compute every rep's score (no shrink — we're producing the prior itself).
  interface ScoredRep { repKey: string; party: string; chamber: 'House' | 'Senate'; displayName: string; score: number; weightedAntiActions: number; tier: string; contributing: number }
  const allScored: ScoredRep[] = [];
  for (const [repKey, slot] of byRep) {
    const result = computeUkraineScore(slot.actions);
    if (result.score === null) continue;
    allScored.push({
      repKey,
      party: slot.party,
      chamber: slot.chamber,
      displayName: slot.displayName,
      score: result.score,
      weightedAntiActions: slot.weightedAntiActions,
      tier: result.confidenceTier,
      contributing: result.contributing,
    });
  }

  // ── Per-party means (priors) — full-confidence only ──
  const fullConfidenceByParty = new Map<string, number[]>();
  for (const r of allScored) {
    if (r.tier !== 'full') continue;
    const list = fullConfidenceByParty.get(r.party) ?? [];
    list.push(r.score);
    fullConfidenceByParty.set(r.party, list);
  }
  const priors: Record<string, number | null> = {};
  for (const [party, scores] of fullConfidenceByParty) {
    if (scores.length < 5) {
      // Fewer than 5 full-confidence reps → degenerate population
      // (ADR-018 fallback: `partyPrior === null` → no shrink).
      priors[party] = null;
      continue;
    }
    priors[party] = scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  // ── perRepHistogram (FR-56 AC-56.1) — 21 buckets, [-1.0, +1.0] step 0.1 ──
  // Spec spells out 21 buckets edge-to-edge. Bucket i covers
  // [-1.0 + i*0.1, -1.0 + (i+1)*0.1). The +1.0 score is folded into the
  // last bucket so we don't need 22 buckets for one edge case.
  const histogramBuckets: number[] = Array.from({ length: 21 }, (_, i) => -1.0 + i * 0.1);
  const histogramCounts: number[] = new Array(21).fill(0);
  for (const r of allScored) {
    let idx = Math.floor((r.score + 1.0) * 10);
    if (idx >= 21) idx = 20;
    if (idx < 0) idx = 0;
    histogramCounts[idx] = (histogramCounts[idx] ?? 0) + 1;
  }

  // ── topAntiUkraine (FR-56 AC-56.1) — top 25 by weightedAntiActions ──
  // House-only because Senate roster keys aren't real bioguide IDs.
  const topAntiUkraine = allScored
    .filter((r) => r.chamber === 'House' && r.weightedAntiActions > 0)
    .sort((a, b) => b.weightedAntiActions - a.weightedAntiActions)
    .slice(0, 25)
    .map((r) => ({
      bioguideId: r.repKey,
      displayName: r.displayName,
      score: Number(r.score.toFixed(4)),
      weightedAntiActions: Number(r.weightedAntiActions.toFixed(4)),
    }));

  console.log(`[party-priors] reps_seen=${byRep.size} scored=${allScored.length}`);
  for (const [party, scores] of fullConfidenceByParty) {
    const prior = priors[party] ?? null;
    const display = prior === null ? 'null (cold-start)' : prior.toFixed(4);
    console.log(`[party-priors]   party=${party}  full_n=${scores.length}  prior=${display}`);
  }
  console.log(`[party-priors]   histogram_total=${histogramCounts.reduce((a, b) => a + b, 0)}`);
  console.log(`[party-priors]   topAntiUkraine_count=${topAntiUkraine.length}`);

  // ── KV writes ──
  const generatedAt = new Date().toISOString();
  const priorsRecord = { generatedAt, schemaVersion: 1, priors };

  if (DRY_RUN) {
    console.log('[party-priors] --dry-run: skipping KV writes');
    console.log('[party-priors] PRIORS:', JSON.stringify(priorsRecord, null, 2));
    console.log('[party-priors] HISTOGRAM:', JSON.stringify({ buckets: histogramBuckets, counts: histogramCounts }, null, 2));
    console.log('[party-priors] TOP ANTI:', JSON.stringify(topAntiUkraine, null, 2));
    return;
  }

  const tmp = mkdtempSync(join(tmpdir(), 'party-priors-'));

  // 1. Write the priors record (consumed by the Worker member read-through).
  const priorsPath = join(tmp, 'priors.json');
  writeFileSync(priorsPath, JSON.stringify(priorsRecord));
  console.log(`[party-priors] writing scores:v1:party-priors to KV namespace ${namespaceId}…`);
  execSync(
    `npx wrangler kv key put --namespace-id ${namespaceId} "scores:v1:party-priors" --path "${priorsPath}" --remote`,
    { stdio: 'inherit' },
  );

  // 2. Read-modify-write stats:v1:summary to overlay the score-derived
  //    fields onto whatever publish-d1-to-kv wrote (perBill + commentsTimeseries).
  //    The publish workflow runs publish-d1-to-kv FIRST so the base record
  //    exists by the time we get here. If somehow it's missing we fall back
  //    to writing a minimal record with just the score fields.
  const statsCmd = `npx wrangler kv key get --namespace-id ${namespaceId} "stats:v1:summary" --remote`;
  let baseStats: Record<string, unknown> = { generatedAt, schemaVersion: 1, perBill: [], commentsTimeseries: [] };
  try {
    const raw = execSync(statsCmd, { stdio: ['pipe', 'pipe', 'ignore'] }).toString('utf8');
    if (raw.trim().length > 0) {
      baseStats = JSON.parse(raw) as Record<string, unknown>;
    }
  } catch {
    console.warn('[party-priors] stats:v1:summary not yet present — overlay will be the entire record.');
  }

  const augmented = {
    ...baseStats,
    generatedAt,
    schemaVersion: 1,
    perRepHistogram: { buckets: histogramBuckets, counts: histogramCounts },
    topAntiUkraine,
    partyPriors: priors,
  };
  const statsPath = join(tmp, 'stats.json');
  writeFileSync(statsPath, JSON.stringify(augmented));
  console.log(`[party-priors] writing stats:v1:summary (overlaid) to KV namespace ${namespaceId}…`);
  execSync(
    `npx wrangler kv key put --namespace-id ${namespaceId} "stats:v1:summary" --path "${statsPath}" --remote`,
    { stdio: 'inherit' },
  );
  console.log('[party-priors] done.');
}

main();
