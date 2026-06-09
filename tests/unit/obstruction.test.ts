/**
 * Obstruction predicate tests.
 */
import { describe, it, expect } from 'vitest';
import { isObstructionVote, isObstructionBill } from '../../src/services/obstruction';
import type { CuratedBill, CuratedBillVote, VoteKind } from '../../src/services/ukraineFilter';

function bill(dir: CuratedBill['direction']): CuratedBill {
  return {
    congress: 118, type: 'HR', number: '815', featured: true,
    label: 't', title: 't', latestAction: 'x', latestActionDate: '2024-04-24',
    becameLaw: true, congressGovUrl: '', direction: dir,
    directionReason: 'test', summary: null, votes: [],
  };
}

function vote(kind: VoteKind, weight = 0.45, dirMult: -1 | 0 | 1 = 1): CuratedBillVote {
  // FR-63: `direction` mirrors the legacy multiplier for these pro-bill
  // scenarios (dm=1→pro, −1→anti, 0→neutral). isObstructionVote is bill+valence
  // driven and doesn't read vote.direction, so this is just for the type.
  const direction = dirMult === 0 ? 'neutral' : dirMult === -1 ? 'anti' : 'pro';
  return {
    chamber: 'Senate', congress: 118, session: 2, rollCall: 1,
    date: '2024-01-01', url: '', action: 'x', actionDate: '2024-01-01',
    weight, direction, directionMultiplier: dirMult, kind,
  };
}

describe('isObstructionVote', () => {
  it('returns true: Nay on cloture for pro-UA bill is obstruction', () => {
    // Pro-UA bill + cloture + Nay → valence = voted-anti
    expect(isObstructionVote(bill('pro-ukraine'), vote('cloture'), 'Nay', 'voted-anti')).toBe(true);
  });

  it('returns true: Nay on motion-to-proceed for pro-UA is obstruction', () => {
    expect(isObstructionVote(bill('pro-ukraine'), vote('motion-to-proceed'), 'Nay', 'voted-anti')).toBe(true);
  });

  it('returns true: Aye on motion-to-recommit for pro-UA is obstruction', () => {
    // motion-to-recommit has directionMultiplier = -1, so Aye → voted-anti
    expect(isObstructionVote(bill('pro-ukraine'), vote('motion-to-recommit', 0.3, -1), 'Aye', 'voted-anti')).toBe(true);
  });

  it('returns true: Aye on anti-UA bill passage/amendment is obstruction', () => {
    // Non-procedural kind, bill is anti-UA, member voted Aye
    expect(isObstructionVote(bill('anti-ukraine'), vote('amendment', 0.7), 'Aye', 'voted-anti')).toBe(true);
  });

  it('returns false: Nay on passage is a direct opposition vote, not obstruction', () => {
    // We already score voted-anti for this; it's an on-the-record NO, not obstruction.
    expect(isObstructionVote(bill('pro-ukraine'), vote('passage', 1.0), 'Nay', 'voted-anti')).toBe(false);
  });

  it('returns false: Aye on pro-UA passage is pro-UA, not obstruction', () => {
    expect(isObstructionVote(bill('pro-ukraine'), vote('passage', 1.0), 'Aye', 'voted-pro')).toBe(false);
  });

  it('returns false: Aye on cloture for pro-UA is PRO-UA, not obstruction', () => {
    // valence would be voted-pro — the predicate requires voted-anti
    expect(isObstructionVote(bill('pro-ukraine'), vote('cloture'), 'Aye', 'voted-pro')).toBe(false);
  });

  it('returns false: Not Voting is unstated, not obstruction', () => {
    expect(isObstructionVote(bill('pro-ukraine'), vote('cloture'), 'Not Voting', 'unstated')).toBe(false);
  });
});

describe('isObstructionBill', () => {
  it('returns true for sponsoring an anti-UA bill', () => {
    expect(isObstructionBill('anti-ukraine', 'sponsored')).toBe(true);
  });

  it('returns true for cosponsoring an anti-UA bill', () => {
    expect(isObstructionBill('anti-ukraine', 'cosponsored')).toBe(true);
  });

  it('returns false for sponsoring a pro-UA bill', () => {
    expect(isObstructionBill('pro-ukraine', 'sponsored')).toBe(false);
  });

  it('returns false for neutral bills', () => {
    expect(isObstructionBill('neutral', 'sponsored')).toBe(false);
  });
});
