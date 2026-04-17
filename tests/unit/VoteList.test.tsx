/**
 * VoteList — cluster auto-expand behavior (FR-21 AC-21.3).
 *
 * A cluster that contains an obstruction event must render its procedural
 * children visible by default, so the OBSTRUCTION tags in the callout count
 * always match what the voter can see.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VoteList } from '../../src/components/VoteList';
import type { ClusteredMemberVoteWithValence, MemberVoteRow } from '../../src/hooks/useVotingRecord';
import type { CuratedBill, CuratedBillVote, VoteKind } from '../../src/services/ukraineFilter';

function bill(dir: CuratedBill['direction'] = 'pro-ukraine'): CuratedBill {
  return {
    congress: 118, type: 'HR', number: '815', featured: true,
    label: '$95B Ukraine supplemental', title: 't',
    latestAction: 'Became law', latestActionDate: '2024-04-24',
    becameLaw: true, congressGovUrl: '',
    direction: dir, directionReason: 't', summary: null, votes: [],
  };
}

function vote(rollCall: number, kind: VoteKind, weight: number): CuratedBillVote {
  return {
    chamber: 'Senate', congress: 118, session: 2, rollCall,
    date: '2024-02-13', url: '', action: kind, actionDate: '2024-02-13',
    weight, directionMultiplier: 1, kind,
  };
}

function row(
  vote: CuratedBillVote,
  memberVote: MemberVoteRow['memberVote'],
  valence: MemberVoteRow['valence'],
  isObstruction: boolean,
): MemberVoteRow {
  return { bill: bill(), vote, memberVote, valence, isObstruction };
}

describe('VoteList auto-expand', () => {
  it('does NOT auto-expand when no obstruction in the cluster', () => {
    const cluster: ClusteredMemberVoteWithValence = {
      primary: row(vote(48, 'passage', 1.0), 'Aye', 'voted-pro', false),
      procedural: [
        row(vote(47, 'cloture', 0.45), 'Aye', 'voted-pro', false),
        row(vote(42, 'motion-to-proceed', 0.3), 'Aye', 'voted-pro', false),
      ],
    };
    render(<VoteList clusters={[cluster]} />);
    // Procedural rows should NOT be visible by default
    expect(screen.queryByText(/cloture/)).toBeNull();
    expect(screen.queryByText(/motion-to-proceed/)).toBeNull();
    // The "Show N procedural votes" toggle is present
    expect(screen.getByText(/Show 2 procedural votes/)).toBeInTheDocument();
  });

  it('stays collapsed by default even when the cluster contains an obstruction event', () => {
    const obstructionRow = row(vote(47, 'cloture', 0.45), 'Nay', 'voted-anti', true);
    const cluster: ClusteredMemberVoteWithValence = {
      primary: row(vote(48, 'passage', 1.0), 'Nay', 'voted-anti', false),
      procedural: [
        obstructionRow,
        row(vote(42, 'motion-to-proceed', 0.3), 'Nay', 'voted-anti', false),
      ],
    };
    render(<VoteList clusters={[cluster]} />);
    // Procedural rows are hidden by default — user must opt in to see them.
    expect(screen.queryByText(/motion-to-proceed/)).toBeNull();
    expect(screen.getByText(/Show 2 procedural votes/)).toBeInTheDocument();
  });

  it('stays collapsed when only a procedural is obstruction', () => {
    const cluster: ClusteredMemberVoteWithValence = {
      primary: row(vote(48, 'passage', 1.0), 'Aye', 'voted-pro', false),
      procedural: [row(vote(47, 'cloture', 0.45), 'Nay', 'voted-anti', true)],
    };
    render(<VoteList clusters={[cluster]} />);
    expect(screen.getByText(/Show 1 procedural vote/)).toBeInTheDocument();
  });
});
