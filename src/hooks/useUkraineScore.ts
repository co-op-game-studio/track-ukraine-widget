/**
 * useUkraineScore — combined score over votes + sponsorships + curated
 * comments / posts / quotes (per AC-52.44).
 *
 * Pre-V4 the latter three were stored and displayed but never entered the
 * score formula (AC-52.45 spec-as-truth correction). They now contribute as
 * synthetic actions with the same `weight × direction × valence_sign` shape
 * as a vote.
 *
 * Traces to: FR-16, AC-52.44, AC-52.45.
 */
import { useMemo } from 'react';
import type { VotingRecordData } from './useVotingRecord';
import type { SponsoredBillsData } from './useSponsoredBills';
import type { ResearcherComment } from './useRepComments';
import type { SocialPost } from './useRepStatements';
import type { RepQuote } from './useRepQuotes';
import {
  computeUkraineScore,
  type UkraineScore,
  type ScorePriors,
} from '../services/ukraineScore';
import type { Valence } from '../services/valence';

/** AC-52.44 — map a comment/post/quote `direction` to a synthetic Valence. */
function directionToValence(direction: number): Valence | null {
  if (direction === 1) return 'voted-pro';
  if (direction === -1) return 'voted-anti';
  return null; // 0 → contributes nothing
}

/**
 * @param voting   voting record (or null)
 * @param bills    sponsored / cosponsored bills (or null)
 * @param priors   FR-55 — optional `{ partyPrior }` for Bayesian shrink.
 *                 Comes from `member:v1:{bioguide}.partyPrior` (FR-51 AC-55.6).
 *                 Pass `undefined` (or omit) to skip shrink.
 * @param extra    AC-52.44 — optional researcher-curated comments/posts/quotes.
 *                 Each row with `direction !== 0 && weight > 0` enters as a
 *                 synthetic action.
 */
export function useUkraineScore(
  voting: VotingRecordData | null,
  bills: SponsoredBillsData | null,
  priors?: ScorePriors,
  extra?: {
    comments?: readonly ResearcherComment[];
    posts?: readonly SocialPost[];
    quotes?: readonly RepQuote[];
  },
): UkraineScore | null {
  return useMemo(() => {
    if (!voting && !bills && !extra?.comments?.length && !extra?.posts?.length && !extra?.quotes?.length) {
      return null;
    }
    const actions: Array<{ valence: Valence; weight: number }> = [];

    for (const v of voting?.flat ?? []) {
      actions.push({ valence: v.valence, weight: v.vote.weight });
    }

    // Sponsorships have weight 1.0 (they represent the strongest possible action).
    for (const b of bills?.sponsored ?? []) {
      actions.push({ valence: b.valence, weight: 1.0 });
    }
    for (const b of bills?.cosponsored ?? []) {
      actions.push({ valence: b.valence, weight: 1.0 });
    }

    // AC-52.44 — synthetic actions for comments / posts / quotes.
    const pushExtra = (rows: readonly { weight: number; direction: number }[] | undefined) => {
      if (!rows) return;
      for (const r of rows) {
        if (r.weight <= 0) continue;
        const valence = directionToValence(r.direction);
        if (!valence) continue;
        actions.push({ valence, weight: r.weight });
      }
    };
    pushExtra(extra?.comments);
    pushExtra(extra?.posts);
    pushExtra(extra?.quotes);

    return computeUkraineScore(actions, priors);
  }, [voting, bills, priors?.partyPrior, extra?.comments, extra?.posts, extra?.quotes]);
}
