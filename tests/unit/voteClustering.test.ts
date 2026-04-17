/**
 * Vote clustering tests (FR-17, design.md §4.8)
 */
import { describe, it, expect } from 'vitest';
import { clusterMemberVotes } from '../../src/services/voteClustering';
import type { CuratedBill } from '../../src/services/ukraineFilter';

function bill(overrides: Partial<CuratedBill> = {}): CuratedBill {
  return {
    congress: 118,
    type: 'HR',
    number: '815',
    featured: true,
    label: 'Test bill',
    title: 'Test',
    latestAction: 'Became law',
    latestActionDate: '2024-04-24',
    becameLaw: true,
    congressGovUrl: '',
    direction: 'pro-ukraine',
    directionReason: 'test',
    summary: null,
    votes: [],
    ...overrides,
  };
}

function vote(chamber: 'House' | 'Senate', rollCall: number, weight: number, date: string, action = '') {
  return {
    chamber, congress: 118, session: 2, rollCall, date, url: '', action, actionDate: date,
    weight,
    directionMultiplier: 1 as const,
    kind: 'passage' as const,
  };
}

describe('clusterMemberVotes', () => {
  it('groups votes by (bill, chamber) and picks the highest-weight primary', () => {
    const b = bill();
    const input = [
      { bill: b, vote: vote('Senate', 48, 1.0, '2024-02-13'), memberVote: 'Aye' as const },
      { bill: b, vote: vote('Senate', 47, 0.15, '2024-02-08'), memberVote: 'Aye' as const },
      { bill: b, vote: vote('Senate', 42, 0.15, '2024-02-07'), memberVote: 'Aye' as const },
    ];
    const clusters = clusterMemberVotes(input);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.primary.vote.rollCall).toBe(48);
    expect(clusters[0]!.procedural).toHaveLength(2);
    expect(clusters[0]!.procedural.map((p) => p.vote.rollCall).sort()).toEqual([42, 47]);
  });

  it('separates House and Senate clusters even for the same bill', () => {
    const b = bill();
    const input = [
      { bill: b, vote: vote('Senate', 48, 1.0, '2024-02-13'), memberVote: 'Aye' as const },
      { bill: b, vote: vote('House', 151, 1.0, '2024-04-20'), memberVote: 'Aye' as const },
    ];
    const clusters = clusterMemberVotes(input);
    expect(clusters).toHaveLength(2);
    const chambers = clusters.map((c) => c.primary.vote.chamber).sort();
    expect(chambers).toEqual(['House', 'Senate']);
  });

  it('handles a single vote with no procedurals', () => {
    const b = bill();
    const input = [
      { bill: b, vote: vote('House', 141, 1.0, '2022-04-28'), memberVote: 'Aye' as const },
    ];
    const clusters = clusterMemberVotes(input);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.procedural).toHaveLength(0);
  });

  it('breaks weight ties by latest date', () => {
    const b = bill();
    const input = [
      { bill: b, vote: vote('Senate', 100, 0.9, '2024-03-01'), memberVote: 'Aye' as const },
      { bill: b, vote: vote('Senate', 101, 0.9, '2024-04-01'), memberVote: 'Aye' as const }, // newer
      { bill: b, vote: vote('Senate', 99, 0.9, '2024-02-01'), memberVote: 'Aye' as const },
    ];
    const clusters = clusterMemberVotes(input);
    expect(clusters[0]!.primary.vote.rollCall).toBe(101);
  });

  it('orders clusters: featured first, then newest primary date', () => {
    const featured = bill({ featured: true, number: '815', latestActionDate: '2024-04-24' });
    const other = bill({ featured: false, number: '6833', latestActionDate: '2022-09-30' });
    const input = [
      { bill: other, vote: vote('Senate', 351, 1.0, '2022-09-29'), memberVote: 'Aye' as const },
      { bill: featured, vote: vote('Senate', 48, 1.0, '2024-02-13'), memberVote: 'Aye' as const },
    ];
    const clusters = clusterMemberVotes(input);
    expect(clusters[0]!.primary.bill.featured).toBe(true);
    expect(clusters[1]!.primary.bill.featured).toBe(false);
  });
});
