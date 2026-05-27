/**
 * useUkraineScore \u2014 pure composition hook.
 * Traces to: FR-16.
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useUkraineScore } from '../../src/hooks/useUkraineScore';
import type { VotingRecordData, MemberVoteRow } from '../../src/hooks/useVotingRecord';
import type { SponsoredBillsData, UkraineBill } from '../../src/hooks/useSponsoredBills';

function voteRow(valence: MemberVoteRow['valence'], weight: number): MemberVoteRow {
  return {
    bill: {
      congress: 118, type: 'HR', number: '815',
      direction: 'pro-ukraine', directionReason: 'manual override',
      featured: true,
      title: 't', label: 'l',
      latestAction: 'a', latestActionDate: '2024-04-24',
      becameLaw: true, congressGovUrl: 'https://congress.gov/...',
      summary: null, votes: [],
    },
    vote: {
      chamber: 'Senate', congress: 118, session: 2, rollCall: 154,
      date: '2024', url: '', action: 'Passed', actionDate: '2024',
      weight, directionMultiplier: 1, kind: 'passage',
    },
    memberVote: 'Aye',
    valence,
    isObstruction: false,
  };
}

function ukraineBill(valence: UkraineBill['valence']): UkraineBill {
  return {
    number: 'H.R. 7691',
    title: 'Ukraine Supp.',
    dateIntroduced: '2022-05-10',
    latestAction: 'Became law',
    congressGovUrl: 'https://congress.gov/...',
    relationship: 'sponsored',
    featured: true,
    direction: 'pro-ukraine',
    valence,
    summary: null,
    curated: {
      congress: 117, type: 'HR', number: '7691',
      direction: 'pro-ukraine', directionReason: 'manual override',
      featured: true,
      title: 't', label: 'l',
      latestAction: 'a', latestActionDate: '2022-05-21',
      becameLaw: true, congressGovUrl: 'https://congress.gov/...',
      summary: null, votes: [],
    },
  };
}

describe('useUkraineScore', () => {
  it('returns null when both inputs are null', () => {
    const { result } = renderHook(() => useUkraineScore(null, null));
    expect(result.current).toBeNull();
  });

  it('returns a score from voting rows only (bills null)', () => {
    const voting: VotingRecordData = {
      clusters: [], flat: [voteRow('voted-pro', 1), voteRow('voted-pro', 1), voteRow('voted-pro', 1)],
      voteScore: { score: 1, rawScore: 1, contributing: 3, total: 3, lowConfidence: false, confidence: 0.375, confidenceTier: 'moderate' },
      obstructionCount: 0, primaryAbstentionCount: 0,
    };
    const { result } = renderHook(() => useUkraineScore(voting, null));
    expect(result.current).not.toBeNull();
    expect(result.current!.score).toBeGreaterThan(0);
    expect(result.current!.contributing).toBe(3);
  });

  it('returns a score from bills only (voting null)', () => {
    const bills: SponsoredBillsData = {
      sponsored: [ukraineBill('sponsor-pro'), ukraineBill('sponsor-pro')],
      cosponsored: [ukraineBill('sponsor-pro')],
    };
    const { result } = renderHook(() => useUkraineScore(null, bills));
    expect(result.current).not.toBeNull();
    expect(result.current!.contributing).toBe(3);
    expect(result.current!.score).toBeGreaterThan(0);
  });

  it('composes voting + sponsored + cosponsored into a single action list', () => {
    const voting: VotingRecordData = {
      clusters: [], flat: [voteRow('voted-pro', 1)],
      voteScore: { score: 1, rawScore: 1, contributing: 1, total: 1, lowConfidence: true, confidence: 0.125, confidenceTier: 'low' },
      obstructionCount: 0, primaryAbstentionCount: 0,
    };
    const bills: SponsoredBillsData = {
      sponsored: [ukraineBill('sponsor-pro')],
      cosponsored: [ukraineBill('sponsor-pro'), ukraineBill('sponsor-pro')],
    };
    const { result } = renderHook(() => useUkraineScore(voting, bills));
    // 1 vote + 1 sponsored + 2 cosponsored = 4 contributing actions
    expect(result.current!.contributing).toBe(4);
  });

  it('anti-Ukraine votes pull the score negative', () => {
    const voting: VotingRecordData = {
      clusters: [],
      flat: [
        voteRow('voted-anti', 1),
        voteRow('voted-anti', 1),
        voteRow('voted-anti', 1),
      ],
      voteScore: { score: -1, rawScore: -1, contributing: 3, total: 3, lowConfidence: false, confidence: 0.375, confidenceTier: 'moderate' },
      obstructionCount: 0, primaryAbstentionCount: 0,
    };
    const { result } = renderHook(() => useUkraineScore(voting, null));
    expect(result.current!.score).toBeLessThan(0);
  });

  // AC-52.44 — researcher-curated extras (comments / posts / quotes) feed the score.
  describe('extras (AC-52.44)', () => {
    function extra(direction: number, weight: number) {
      return {
        id: 'x', bodyMarkdown: '', authorEmail: 'a', createdAt: '', updatedAt: '',
        weight, direction, attachedToRollCallId: null,
      };
    }

    it('returns null when only voting/bills are null AND extras are empty', () => {
      const { result } = renderHook(() =>
        useUkraineScore(null, null, undefined, { comments: [], posts: [], quotes: [] }),
      );
      expect(result.current).toBeNull();
    });

    it('extras-only path: pro-direction extras produce a positive raw score', () => {
      // Need >= NEW_REP_THRESHOLD (2) contributing actions to get non-null score.
      const comments = [extra(1, 1), extra(1, 1), extra(1, 1)] as never;
      const { result } = renderHook(() => useUkraineScore(null, null, undefined, { comments }));
      expect(result.current).not.toBeNull();
      expect(result.current!.contributing).toBe(3);
      expect(result.current!.score).toBeGreaterThan(0);
    });

    it('extras-only path: anti-direction posts produce a negative raw score', () => {
      const posts = [extra(-1, 1), extra(-1, 1), extra(-1, 1)] as never;
      const { result } = renderHook(() => useUkraineScore(null, null, undefined, { posts }));
      expect(result.current!.rawScore).toBeLessThan(0);
    });

    it('zero-direction extras (direction=0) are filtered by directionToValence (line 29)', () => {
      // With only zero-direction quotes + no votes/bills, the extras.length check
      // still returns true (length>0), so the hook computes — but every action is
      // filtered out, leaving contributing=0 / total=0 → confidenceTier=insufficient.
      const quotes = [extra(0, 1), extra(0, 1)] as never;
      const { result } = renderHook(() => useUkraineScore(null, null, undefined, { quotes }));
      expect(result.current).not.toBeNull();
      expect(result.current!.contributing).toBe(0);
      expect(result.current!.score).toBeNull();
      expect(result.current!.confidenceTier).toBe('insufficient');
    });

    it('zero-weight extras are skipped before reaching directionToValence', () => {
      const comments = [extra(1, 0), extra(-1, 0)] as never;
      const { result } = renderHook(() => useUkraineScore(null, null, undefined, { comments }));
      expect(result.current!.contributing).toBe(0);
    });

    it('mixes voting + bills + extras into a single composed score', () => {
      const voting: VotingRecordData = {
        clusters: [], flat: [voteRow('voted-pro', 1)],
        voteScore: { score: 1, rawScore: 1, contributing: 1, total: 1, lowConfidence: true, confidence: 0.125, confidenceTier: 'low' },
        obstructionCount: 0, primaryAbstentionCount: 0,
      };
      const bills: SponsoredBillsData = { sponsored: [ukraineBill('sponsor-pro')], cosponsored: [] };
      const comments = [extra(1, 1)] as never;
      const posts = [extra(1, 1)] as never;
      const quotes = [extra(-1, 1)] as never;
      const { result } = renderHook(() =>
        useUkraineScore(voting, bills, undefined, { comments, posts, quotes }),
      );
      // 1 vote + 1 sponsored + 1 comment + 1 post + 1 quote = 5 contributing
      expect(result.current!.contributing).toBe(5);
    });
  });

  // FR-55 — Bayesian shrink toward party prior.
  it('priors.partyPrior shrinks the score toward the prior', () => {
    // Need >= NEW_REP_THRESHOLD votes to escape `score:null`.
    const voting: VotingRecordData = {
      clusters: [],
      flat: [voteRow('voted-pro', 1), voteRow('voted-pro', 1), voteRow('voted-pro', 1)],
      voteScore: { score: 1, rawScore: 1, contributing: 3, total: 3, lowConfidence: false, confidence: 0.375, confidenceTier: 'moderate' },
      obstructionCount: 0, primaryAbstentionCount: 0,
    };
    const noPrior = renderHook(() => useUkraineScore(voting, null));
    const withPrior = renderHook(() => useUkraineScore(voting, null, { partyPrior: -0.5 }));
    // With prior pulling toward -0.5, score should be lower than without prior.
    expect(withPrior.result.current!.score).not.toBeNull();
    expect(noPrior.result.current!.score).not.toBeNull();
    expect(withPrior.result.current!.score!).toBeLessThan(noPrior.result.current!.score!);
  });
});
