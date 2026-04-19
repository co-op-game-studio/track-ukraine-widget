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
      voteScore: { score: 1, contributing: 3, total: 3, lowConfidence: false },
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
      voteScore: { score: 1, contributing: 1, total: 1, lowConfidence: false },
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
      voteScore: { score: -1, contributing: 3, total: 3, lowConfidence: false },
      obstructionCount: 0, primaryAbstentionCount: 0,
    };
    const { result } = renderHook(() => useUkraineScore(voting, null));
    expect(result.current!.score).toBeLessThan(0);
  });
});
