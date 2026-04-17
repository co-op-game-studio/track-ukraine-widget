/**
 * useUkraineScore — combined score over votes + sponsorships.
 * Traces to: FR-16.
 *
 * Takes the outputs of useVotingRecord + useSponsoredBills and produces a
 * single UkraineScore. Pure composition — safe to call every render.
 */
import { useMemo } from 'react';
import type { VotingRecordData } from './useVotingRecord';
import type { SponsoredBillsData } from './useSponsoredBills';
import { computeUkraineScore, type UkraineScore } from '../services/ukraineScore';

export function useUkraineScore(
  voting: VotingRecordData | null,
  bills: SponsoredBillsData | null,
): UkraineScore | null {
  return useMemo(() => {
    if (!voting && !bills) return null;
    const actions: Array<{ valence: import('../services/valence').Valence; weight: number }> = [];

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

    return computeUkraineScore(actions);
  }, [voting, bills]);
}
