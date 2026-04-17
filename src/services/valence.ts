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
  if (direction === 'neutral') return 'unstated';

  const sponsored = action === 'sponsored' || action === 'cosponsored';
  const isPro = direction === 'pro-ukraine';

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
