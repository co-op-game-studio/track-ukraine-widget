/**
 * Obstruction detection — identifies anti-advancement actions in a member's
 * voting record so the UI can tag them for the voter.
 *
 * An obstruction event is any action whose effect is to block, delay, or kill
 * a pro-Ukraine bill WITHOUT showing up as a direct Nay on passage. We derive
 * this from data the curator already classified (kind, directionMultiplier,
 * bill direction, member vote). No new classification logic.
 *
 * See: spec.md §FR-21, design.md §4.11.
 */
import type { CuratedBill, CuratedBillVote, VoteKind } from './ukraineFilter';
import type { Valence } from './valence';

/** Procedural vote kinds. Same list as used elsewhere, kept local for clarity. */
const PROCEDURAL_KINDS: ReadonlySet<VoteKind> = new Set<VoteKind>([
  'cloture',
  'motion-to-proceed',
  'motion-to-recommit',
  'waive-budget',
  'motion-to-table',
  'motion-to-reconsider',
  'other-procedural',
]);

/** Vote cast normalized to our domain form. */
type MemberCast = 'Aye' | 'Nay' | 'Present' | 'Not Voting';

/**
 * Returns true if the given (bill, vote, memberVote, valence) constitutes an
 * obstruction event.
 *
 * Rule (simple, auditable):
 *   - valence must be 'voted-anti' AND the vote is procedural  → blocking move
 *   - OR bill.direction === 'anti-ukraine' AND the member voted Aye
 *     on a non-procedural vote  → supporting an anti-UA amendment/bill
 *
 * Sponsorship obstruction (sponsor-anti) is handled separately in
 * `isObstructionBill` — we don't have a "vote" object there.
 */
export function isObstructionVote(
  bill: CuratedBill,
  vote: CuratedBillVote,
  memberVote: MemberCast,
  valence: Valence,
): boolean {
  const isProcedural = PROCEDURAL_KINDS.has(vote.kind);

  // Case 1: any procedural move that scored as voted-anti is obstruction
  if (isProcedural && valence === 'voted-anti') return true;

  // Case 2: a non-procedural Aye vote on an anti-Ukraine bill/amendment
  if (!isProcedural && bill.direction === 'anti-ukraine' && memberVote === 'Aye') {
    return true;
  }

  return false;
}

/** Cosponsoring an anti-UA bill = strongest obstruction signal. */
export function isObstructionBill(direction: CuratedBill['direction'], relationship: 'sponsored' | 'cosponsored'): boolean {
  return direction === 'anti-ukraine' && (relationship === 'sponsored' || relationship === 'cosponsored');
}
