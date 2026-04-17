/**
 * Party Alignment Calculator
 * See: docs/design.md §4.5
 * Traces to: FR-8
 */
import type { VoteWithPartyData, PartyAlignment } from '../types/domain';

export function calculatePartyAlignment(
  votes: VoteWithPartyData[],
  memberParty: string,
): PartyAlignment {
  // Independents have no party to align with
  const isDem = memberParty.startsWith('D');
  const isRep = memberParty.startsWith('R');
  if (!isDem && !isRep) {
    return { score: null, totalPartyLineVotes: 0, votesWithParty: 0 };
  }

  let partyLineVotes = 0;
  let votesWithParty = 0;

  for (const vote of votes) {
    // Skip if member didn't cast a substantive vote
    if (vote.memberVote === 'Present' || vote.memberVote === 'Not Voting') {
      continue;
    }

    // Determine each party's majority position
    const demMajority = vote.democratYeas > vote.democratNays ? 'Aye' : 'Nay';
    const repMajority = vote.republicanYeas > vote.republicanNays ? 'Aye' : 'Nay';

    // Skip non-party-line votes (both parties voted the same way)
    if (demMajority === repMajority) {
      continue;
    }

    partyLineVotes++;

    const ownPartyMajority = isDem ? demMajority : repMajority;
    if (vote.memberVote === ownPartyMajority) {
      votesWithParty++;
    }
  }

  const score = partyLineVotes > 0
    ? (votesWithParty / partyLineVotes) * 100
    : null;

  return { score, totalPartyLineVotes: partyLineVotes, votesWithParty };
}
