/**
 * Valence — maps (bill-direction, member-action) to a 5-level visual/moral tag.
 * See docs/design.md §4.9.
 * Traces to: FR-15
 *
 * v2.1.2: procedural votes can have a directionMultiplier that inverts the
 * valence (motion-to-recommit: Aye = anti-bill). This is passed through to
 * computeValence as an optional third argument.
 */

export type BillDirection = 'pro-ukraine' | 'anti-ukraine' | 'neutral';

export type MemberAction =
  | 'sponsored'
  | 'cosponsored'
  | 'voted-aye'
  | 'voted-nay'
  | 'voted-present'
  | 'not-voted';

export type Valence =
  | 'sponsor-pro'
  | 'voted-pro'
  | 'unstated'
  | 'voted-anti'
  | 'sponsor-anti';

/**
 * Compute the valence for a single member-action on a single bill.
 *
 * directionMultiplier: +1 (default) = vote direction matches bill direction;
 *                      -1            = vote direction inverts (e.g., motion-to-recommit);
 *                       0            = ambiguous — returns 'unstated'.
 */
export function computeValence(
  direction: BillDirection,
  action: MemberAction,
  directionMultiplier: -1 | 0 | 1 = 1,
): Valence {
  if (directionMultiplier === 0) return 'unstated';
  if (action === 'not-voted' || action === 'voted-present') return 'unstated';
  // Neutral host bills: only score the specific votes the curator annotated
  // with an explicit directionMultiplier (-1 flips to anti, +1 would stay
  // pro but on a neutral bill that's meaningless). We only accept -1 here
  // because +1 on a neutral bill has no reference direction to follow.
  if (direction === 'neutral') {
    if (directionMultiplier !== -1) return 'unstated';
    // Treat as though this vote is against a pro-UA reference.
  }

  const sponsored = action === 'sponsored' || action === 'cosponsored';
  // For neutral bills with directionMultiplier=-1, treat reference as pro-UA
  // so the flip yields anti-UA for an Aye vote.
  const isPro = direction === 'neutral' ? true : direction === 'pro-ukraine';

  // Effective vote direction after the multiplier.
  // directionMultiplier === -1 flips: an Aye on a motion-to-recommit for a
  // pro-UA bill is effectively an anti-UA action.
  const effectivePro = directionMultiplier === +1 ? isPro : !isPro;

  if (effectivePro) {
    if (sponsored) return 'sponsor-pro';
    if (action === 'voted-aye') return 'voted-pro';
    if (action === 'voted-nay') return 'voted-anti';
  } else {
    if (sponsored) return 'sponsor-anti';
    if (action === 'voted-aye') return 'voted-anti';
    if (action === 'voted-nay') return 'voted-pro';
  }
  return 'unstated';
}

/* -------------------------------------------------------------------------- */
/*            FR-63 — explicit per-vote direction (replaces inversion)         */
/* -------------------------------------------------------------------------- */

/** A vote's own Ukraine direction: "an Aye on this vote is …". */
export type VoteDirection = 'pro' | 'anti' | 'neutral';

/** Member's recorded position on a roll call, normalized to Aye/Nay. */
export type VoteCast = 'voted-aye' | 'voted-nay' | 'voted-present' | 'not-voted';

/**
 * FR-63 AC-63.1 — score-preserving conversion from the legacy
 * `(bill.direction, direction_multiplier)` model to an explicit per-vote
 * direction. This reproduces the effective "what does an Aye mean" that
 * `computeValence` used to derive, so backfilled scores are unchanged
 * (proven by the AC-63.4 equivalence test).
 */
export function directionFromLegacy(
  billDirection: BillDirection,
  directionMultiplier: -1 | 0 | 1,
): VoteDirection {
  if (directionMultiplier === 0) return 'neutral';
  // Legacy neutral bills only scored votes flagged dm=-1, treated as a flip of a
  // pro reference → anti. dm=+1 on a neutral bill was a no-op (unstated) → neutral.
  if (billDirection === 'neutral') return directionMultiplier === -1 ? 'anti' : 'neutral';
  const billIsPro = billDirection === 'pro-ukraine';
  const effectivePro = directionMultiplier === 1 ? billIsPro : !billIsPro;
  return effectivePro ? 'pro' : 'anti';
}

/**
 * FR-63 AC-63.3 — valence for a vote from its OWN explicit direction + the
 * member's cast. No bill-direction, no multiplier. Sponsorship valence still
 * uses `computeValence` (bills.direction); this is votes only.
 *
 *   pro  + Aye → voted-pro    pro  + Nay → voted-anti
 *   anti + Aye → voted-anti   anti + Nay → voted-pro
 *   neutral / present / not-voted → unstated
 */
export function valenceForVote(direction: VoteDirection, cast: VoteCast): Valence {
  if (cast === 'voted-present' || cast === 'not-voted') return 'unstated';
  if (direction === 'neutral') return 'unstated';
  const proStance = direction === 'pro';
  if (cast === 'voted-aye') return proStance ? 'voted-pro' : 'voted-anti';
  // voted-nay
  return proStance ? 'voted-anti' : 'voted-pro';
}

export const VALENCE_LABEL: Record<Valence, string> = {
  'sponsor-pro': 'Sponsored pro-Ukraine',
  'voted-pro': 'Voted pro-Ukraine',
  unstated: 'Unstated',
  'voted-anti': 'Voted anti-Ukraine',
  'sponsor-anti': 'Sponsored anti-Ukraine',
};

export const VALENCE_SIGN: Record<Valence, number> = {
  'sponsor-pro': +1,
  'voted-pro': +1,
  unstated: 0,
  'voted-anti': -1,
  'sponsor-anti': -1,
};

export const VALENCE_AMPLIFIER: Record<Valence, number> = {
  'sponsor-pro': 1.5,
  'sponsor-anti': 1.5,
  'voted-pro': 1.0,
  'voted-anti': 1.0,
  unstated: 0,
};
