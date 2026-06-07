/**
 * VoteList \u2014 cluster render + loading/error/empty + procedural toggle +
 * obstruction tagging. Traces to: FR-21, AC-21.3, AC-34.3.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
    weight, direction: 'pro', directionMultiplier: 1, kind,
  };
}

/** Like vote(), but lets a test set the raw `date` (UTC timestamp) and the
 *  legislative `actionDate` independently — used for AC-21.6. */
function voteWithDates(date: string, actionDate: string): CuratedBillVote {
  return {
    chamber: 'House', congress: 117, session: 2, rollCall: 65,
    date, url: '', action: 'passage', actionDate,
    weight: 1.0, direction: 'pro', directionMultiplier: 1, kind: 'passage',
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

describe('VoteList states', () => {
  it('renders a loading placeholder when loading=true and clusters are empty', () => {
    const { container } = render(<VoteList clusters={[]} loading />);
    expect(container.querySelector('.viw-votelist-empty')).not.toBeNull();
    expect(container.textContent).toMatch(/Loading/);
  });

  it('renders role=alert with the error message when error is set', () => {
    render(<VoteList clusters={[]} error="Vote feed is down." />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Vote feed is down\./);
  });

  it('renders an empty-state message when no clusters and no error', () => {
    render(<VoteList clusters={[]} />);
    expect(screen.getByText(/No Ukraine-related votes/i)).toBeInTheDocument();
  });
});

describe('VoteList — vote date (AC-21.6)', () => {
  it('shows the legislative actionDate, not the UTC-day slice of `date`', () => {
    // 2022-03-10T02:49:07Z is the evening of March 9 in Washington (EST).
    // actionDate carries the correct legislative date: 2022-03-09.
    const cluster: ClusteredMemberVoteWithValence = {
      primary: row(voteWithDates('2022-03-10T02:49:07Z', '2022-03-09'), 'Aye', 'voted-pro', false),
      procedural: [],
    };
    const { container } = render(<VoteList clusters={[cluster]} />);
    const cell = container.querySelector('.viw-votelist-date')!;
    // Must render Mar 9, 2022 — NOT Mar 10.
    expect(cell.textContent).toMatch(/Mar 9, 2022/);
    expect(cell.textContent).not.toMatch(/Mar 10/);
  });

  it('falls back to the date slice when actionDate is empty', () => {
    const cluster: ClusteredMemberVoteWithValence = {
      primary: row(voteWithDates('2024-04-20T17:52:33Z', ''), 'Aye', 'voted-pro', false),
      procedural: [],
    };
    const { container } = render(<VoteList clusters={[cluster]} />);
    const cell = container.querySelector('.viw-votelist-date')!;
    expect(cell.textContent).toMatch(/Apr 20, 2024/);
  });
});

describe('VoteList — procedural toggle', () => {
  it('Show N procedural vote(s) toggle expands, then collapses on re-click', () => {
    const cluster: ClusteredMemberVoteWithValence = {
      primary: row(vote(48, 'passage', 1.0), 'Aye', 'voted-pro', false),
      procedural: [row(vote(47, 'cloture', 0.45), 'Aye', 'voted-pro', false)],
    };
    render(<VoteList clusters={[cluster]} />);
    const toggle = screen.getByRole('button', { name: /Show 1 procedural vote/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toMatch(/Hide/);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('VoteList \u2014 obstruction + procedural tagging', () => {
  it('renders the OBSTRUCTION tag on rows flagged as obstruction events', () => {
    const cluster: ClusteredMemberVoteWithValence = {
      primary: row(vote(48, 'passage', 1.0), 'Nay', 'voted-anti', true),
      procedural: [],
    };
    render(<VoteList clusters={[cluster]} />);
    expect(screen.getByText('OBSTRUCTION')).toBeInTheDocument();
  });

  it('renders the procedural tag for low-weight procedural rows (weight in (0, 0.5))', () => {
    const cluster: ClusteredMemberVoteWithValence = {
      primary: row(vote(48, 'passage', 1.0), 'Aye', 'voted-pro', false),
      procedural: [row(vote(47, 'cloture', 0.3), 'Aye', 'voted-pro', false)],
    };
    const { container } = render(<VoteList clusters={[cluster]} />);
    fireEvent.click(screen.getByRole('button', { name: /Show 1 procedural vote/i }));
    // The low-weight row carries the "procedural" tag. Scope to the tag
    // span so we don't collide with the toggle button text ("1 procedural
    // vote").
    const tag = container.querySelector('.viw-vote-weight-tag');
    expect(tag?.textContent).toMatch(/procedural/i);
  });

  it('renders the bill number on the primary row', () => {
    const cluster: ClusteredMemberVoteWithValence = {
      primary: row(vote(48, 'passage', 1.0), 'Aye', 'voted-pro', false),
      procedural: [],
    };
    const { container } = render(<VoteList clusters={[cluster]} />);
    // Slug uses the unified formatBillSlug helper: "HR 815" (no period
    // after House types). Matches About panel + score-breakdown panel.
    const slug = container.querySelector('.viw-votelist-billslug')?.textContent;
    expect(slug).toBe('HR 815');
  });
});
