/**
 * PartyAlignmentBadge Component Tests
 * Traces to: US-5, T-018
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PartyAlignmentBadge } from '../../src/components/PartyAlignmentBadge';

describe('PartyAlignmentBadge', () => {
  it('renders percentage and progressbar for a numeric score', () => {
    render(
      <PartyAlignmentBadge
        alignment={{ score: 85, totalPartyLineVotes: 20, votesWithParty: 17 }}
        party="Democratic"
      />,
    );
    expect(screen.getByText('85%')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '85');
  });

  it('renders N/A when score is null', () => {
    render(
      <PartyAlignmentBadge
        alignment={{ score: null, totalPartyLineVotes: 0, votesWithParty: 0 }}
        party="Democratic"
      />,
    );
    expect(screen.getByText('N/A')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('uses singular "vote"/"time" when counts are 1', () => {
    render(
      <PartyAlignmentBadge
        alignment={{ score: 100, totalPartyLineVotes: 1, votesWithParty: 1 }}
        party="Republican"
      />,
    );
    expect(screen.getByText(/1 party-line vote\b/)).toBeInTheDocument();
    expect(screen.getByText(/1 time\b/)).toBeInTheDocument();
  });
});
