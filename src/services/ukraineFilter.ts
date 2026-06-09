/**
 * Ukraine Bill Filter
 *
 * Loads the curated Ukraine bill dataset (src/data/ukraineBills.json, built by
 * scripts/build-curated-bills.mjs) and exposes helpers for:
 *   - testing whether a (congress, type, number) tuple is in the curated set
 *   - looking up the curated entry by that tuple
 *   - listing all curated votes filtered by chamber
 *
 * Traces to: FR-11, FR-12, design.md §4.4b
 */
import ukraineBills from '../data/ukraineBills.json';
import type { VoteDirection } from './valence';

export type VoteKind =
  | 'passage'
  | 'concur'
  | 'amendment'
  | 'cloture'
  | 'motion-to-proceed'
  | 'motion-to-recommit'
  | 'waive-budget'
  | 'motion-to-table'
  | 'motion-to-reconsider'
  | 'other-procedural'
  | 'other';

export interface CuratedBillVote {
  chamber: 'House' | 'Senate';
  congress: number;
  session: number;
  rollCall: number;
  date: string;
  url: string;
  action: string;
  actionDate: string;
  /** Weight in [0, 1] — see design.md §4.7. 0 = excluded from scoring. */
  weight: number;
  /**
   * FR-63 — the vote's OWN Ukraine direction: "an Aye on this vote is
   * pro / anti / neutral toward Ukraine." Scoring reads this directly
   * (valenceForVote); it no longer derives valence from the bill direction.
   */
  direction: VoteDirection;
  /**
   * @deprecated FR-63 — legacy inversion multiplier, no longer read by scoring.
   * Retained for one release for rollback + so older tooling doesn't break.
   * +1 = aligned with bill, −1 = inverted, 0 = ambiguous. Use `direction`.
   */
  directionMultiplier: -1 | 0 | 1;
  kind: VoteKind;
}

export interface CuratedBillSummary {
  text: string;
  actionDate: string | null;
  actionDesc: string | null;
  updateDate: string | null;
}

export interface CuratedBill {
  congress: number;
  type: string;
  number: string;
  featured: boolean;
  label: string;
  title: string | null;
  latestAction: string | null;
  latestActionDate: string | null;
  becameLaw: boolean;
  congressGovUrl: string;
  /** pro-ukraine | anti-ukraine | neutral — see design.md §4.6. */
  direction: 'pro-ukraine' | 'anti-ukraine' | 'neutral';
  directionReason: string;
  summary: CuratedBillSummary | null;
  votes: CuratedBillVote[];
}

const CURATED: CuratedBill[] = ukraineBills as CuratedBill[];

/** O(1) lookup set keyed "congress|TYPE|number" */
const BILL_KEY_SET = new Set(
  CURATED.map((b) => `${b.congress}|${b.type.toUpperCase()}|${b.number}`),
);

const BILL_BY_KEY = new Map<string, CuratedBill>(
  CURATED.map((b) => [`${b.congress}|${b.type.toUpperCase()}|${b.number}`, b]),
);

function keyFor(congress: number, type: string, number: string): string {
  return `${congress}|${type.toUpperCase()}|${number}`;
}

/** All curated bills, ordered featured-first then by newest latestActionDate */
export function getCuratedBills(): CuratedBill[] {
  return [...CURATED].sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    const da = a.latestActionDate ?? '';
    const db = b.latestActionDate ?? '';
    return db.localeCompare(da);
  });
}

/** Is this bill in the curated set? */
export function isCuratedBill(
  congress: number,
  type: string,
  number: string,
): boolean {
  return BILL_KEY_SET.has(keyFor(congress, type, number));
}

/** Return the curated entry for this bill, or null. */
export function lookupCuratedBill(
  congress: number,
  type: string,
  number: string,
): CuratedBill | null {
  return BILL_BY_KEY.get(keyFor(congress, type, number)) ?? null;
}

/**
 * All curated roll-call votes from bills matching the given chamber, each
 * paired with the bill it came from (we need the bill context for display).
 * Ordered: featured bills first, then newest votes first within each bucket.
 */
export interface CuratedVoteWithBill {
  bill: CuratedBill;
  vote: CuratedBillVote;
}

export function getCuratedVotesForChamber(
  chamber: 'House' | 'Senate',
): CuratedVoteWithBill[] {
  const all: CuratedVoteWithBill[] = [];
  for (const bill of CURATED) {
    for (const vote of bill.votes) {
      if (vote.chamber === chamber) {
        all.push({ bill, vote });
      }
    }
  }
  return all.sort((a, b) => {
    if (a.bill.featured !== b.bill.featured) return a.bill.featured ? -1 : 1;
    return b.vote.date.localeCompare(a.vote.date);
  });
}
