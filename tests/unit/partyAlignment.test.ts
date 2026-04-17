/**
 * Party Alignment Calculator Tests
 * Traces to: FR-8, design.md §4.5, US-5 (AC-5.1 through AC-5.4)
 * Tests the calculation of party alignment scores from voting data
 */
import { describe, it, expect } from 'vitest';
import { calculatePartyAlignment } from '../../src/services/partyAlignment';
import type { VoteWithPartyData } from '../../src/types/domain';

describe('calculatePartyAlignment', () => {
  it('returns 100% when member always votes with party on party-line votes', () => {
    const votes: VoteWithPartyData[] = [
      // Party-line vote: Dems=Aye, Reps=Nay. Dem member votes Aye.
      { memberVote: 'Aye', democratYeas: 200, democratNays: 10, republicanYeas: 5, republicanNays: 210 },
      { memberVote: 'Aye', democratYeas: 190, democratNays: 15, republicanYeas: 10, republicanNays: 200 },
      { memberVote: 'Nay', democratYeas: 10, democratNays: 195, republicanYeas: 200, republicanNays: 12 },
    ];

    const result = calculatePartyAlignment(votes, 'Democratic');
    expect(result.score).toBe(100);
    expect(result.totalPartyLineVotes).toBe(3);
    expect(result.votesWithParty).toBe(3);
  });

  it('returns 0% when member always votes against party on party-line votes', () => {
    const votes: VoteWithPartyData[] = [
      // Party-line: Dems=Aye, Reps=Nay. Dem member votes Nay (against party).
      { memberVote: 'Nay', democratYeas: 200, democratNays: 10, republicanYeas: 5, republicanNays: 210 },
      { memberVote: 'Nay', democratYeas: 190, democratNays: 15, republicanYeas: 10, republicanNays: 200 },
    ];

    const result = calculatePartyAlignment(votes, 'Democratic');
    expect(result.score).toBe(0);
    expect(result.totalPartyLineVotes).toBe(2);
    expect(result.votesWithParty).toBe(0);
  });

  it('returns 50% for a mix of with-party and against-party votes', () => {
    const votes: VoteWithPartyData[] = [
      // With party
      { memberVote: 'Aye', democratYeas: 200, democratNays: 10, republicanYeas: 5, republicanNays: 210 },
      // Against party
      { memberVote: 'Nay', democratYeas: 200, democratNays: 10, republicanYeas: 5, republicanNays: 210 },
    ];

    const result = calculatePartyAlignment(votes, 'Democratic');
    expect(result.score).toBe(50);
    expect(result.totalPartyLineVotes).toBe(2);
    expect(result.votesWithParty).toBe(1);
  });

  it('excludes non-party-line votes (where both parties voted same way)', () => {
    const votes: VoteWithPartyData[] = [
      // Party-line vote
      { memberVote: 'Aye', democratYeas: 200, democratNays: 10, republicanYeas: 5, republicanNays: 210 },
      // NOT party-line: both parties voted Aye
      { memberVote: 'Aye', democratYeas: 200, democratNays: 10, republicanYeas: 200, republicanNays: 15 },
    ];

    const result = calculatePartyAlignment(votes, 'Democratic');
    expect(result.totalPartyLineVotes).toBe(1);
    expect(result.score).toBe(100);
  });

  it('excludes votes where member was Present or Not Voting', () => {
    const votes: VoteWithPartyData[] = [
      // Member voted Aye — counts
      { memberVote: 'Aye', democratYeas: 200, democratNays: 10, republicanYeas: 5, republicanNays: 210 },
      // Member was "Present" — skip
      { memberVote: 'Present', democratYeas: 200, democratNays: 10, republicanYeas: 5, republicanNays: 210 },
      // Member "Not Voting" — skip
      { memberVote: 'Not Voting', democratYeas: 200, democratNays: 10, republicanYeas: 5, republicanNays: 210 },
    ];

    const result = calculatePartyAlignment(votes, 'Democratic');
    expect(result.totalPartyLineVotes).toBe(1);
    expect(result.score).toBe(100);
  });

  it('returns null score when there are no party-line votes', () => {
    const votes: VoteWithPartyData[] = [
      // Both parties voted Aye — not party-line
      { memberVote: 'Aye', democratYeas: 200, democratNays: 10, republicanYeas: 200, republicanNays: 15 },
    ];

    const result = calculatePartyAlignment(votes, 'Republican');
    expect(result.score).toBeNull();
    expect(result.totalPartyLineVotes).toBe(0);
  });

  it('returns null score when votes array is empty', () => {
    const result = calculatePartyAlignment([], 'Democratic');
    expect(result.score).toBeNull();
    expect(result.totalPartyLineVotes).toBe(0);
    expect(result.votesWithParty).toBe(0);
  });

  it('works correctly for Republican members', () => {
    const votes: VoteWithPartyData[] = [
      // Party-line: Dems=Aye, Reps=Nay. Rep member votes Nay (with party).
      { memberVote: 'Nay', democratYeas: 200, democratNays: 10, republicanYeas: 5, republicanNays: 210 },
    ];

    const result = calculatePartyAlignment(votes, 'Republican');
    expect(result.score).toBe(100);
    expect(result.votesWithParty).toBe(1);
  });

  it('handles Independent members by returning null score', () => {
    const votes: VoteWithPartyData[] = [
      { memberVote: 'Aye', democratYeas: 200, democratNays: 10, republicanYeas: 5, republicanNays: 210 },
    ];

    const result = calculatePartyAlignment(votes, 'Independent');
    expect(result.score).toBeNull();
  });
});
