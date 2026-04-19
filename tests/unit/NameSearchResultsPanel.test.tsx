/**
 * NameSearchResultsPanel — tile grid + toggle for name-search matches.
 * Traces to: FR-31 (AC-31.1\u201331.12), FR-32 AC-32.4.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// RepDetail fires network requests on mount (useVotingRecord, useSponsoredBills).
// Replace it with an inert stub so the panel's behavior can be tested in isolation.
vi.mock('../../src/components/RepDetail', () => ({
  RepDetail: ({ representative }: { representative: { bioguideId: string } }) => (
    <div data-testid="rep-detail-stub">detail:{representative.bioguideId}</div>
  ),
}));

import { NameSearchResultsPanel } from '../../src/components/NameSearchResultsPanel';
import type { NameSearchResult } from '../../src/hooks/useNameSearch';

const jordan: NameSearchResult = {
  bioguideId: 'J000289',
  displayName: 'Jim Jordan',
  first: 'Jim',
  last: 'Jordan',
  state: 'OH',
  chamber: 'House',
  district: 4,
  party: 'R',
  photoUrl: null,
  searchKeys: ['jim', 'jordan'],
};

const durbin: NameSearchResult = {
  bioguideId: 'D000563',
  displayName: 'Richard Durbin',
  first: 'Richard',
  last: 'Durbin',
  state: 'IL',
  chamber: 'Senate',
  district: null,
  party: 'D',
  photoUrl: null,
  searchKeys: ['richard', 'durbin'],
};

function defaults() {
  return {
    query: 'jordan',
    results: [jordan],
    truncated: false,
    status: 'success' as const,
    error: null as string | null,
    apiBase: '',
  };
}

describe('NameSearchResultsPanel', () => {
  it('renders nothing when the trimmed query is under 2 characters', () => {
    const { container, rerender } = render(
      <NameSearchResultsPanel {...defaults()} query="" results={[]} />,
    );
    expect(container.firstChild).toBeNull();
    rerender(<NameSearchResultsPanel {...defaults()} query="  j  " results={[]} />);
    expect(container.firstChild).toBeNull();
    rerender(<NameSearchResultsPanel {...defaults()} query="jo" results={[]} />);
    // >= 2 chars \u2014 SHOULD render something
    expect(container.firstChild).not.toBeNull();
  });

  it('AC-31.9: renders the fallback hint on status="unavailable"', () => {
    render(
      <NameSearchResultsPanel
        {...defaults()}
        status="unavailable"
        results={[]}
        error={null}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      /Name search temporarily unavailable/i,
    );
  });

  it('AC-31.9: renders the server-provided error when unavailable and error is set', () => {
    render(
      <NameSearchResultsPanel
        {...defaults()}
        status="unavailable"
        results={[]}
        error="Name-index not ready yet."
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/Name-index not ready yet\./);
  });

  it('renders a "Search error" hint on status="error" with error text', () => {
    render(
      <NameSearchResultsPanel
        {...defaults()}
        status="error"
        results={[]}
        error="Boom."
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/Search error: Boom\./);
  });

  it('AC-31.10: renders the zero-match empty state on success + empty results', () => {
    render(<NameSearchResultsPanel {...defaults()} results={[]} />);
    expect(screen.getByRole('status')).toHaveTextContent(/No current members match/i);
    expect(screen.getByRole('status')).toHaveTextContent(/jordan/i);
  });

  it('AC-31.3/31.4: renders a chip per result with "Matches" column head on success', () => {
    render(<NameSearchResultsPanel {...defaults()} results={[jordan, durbin]} />);
    expect(screen.getByText('Matches')).toBeInTheDocument();
    // One chip per result (MemberChip renders a role=button).
    const chips = screen.getAllByRole('button');
    expect(chips).toHaveLength(2);
  });

  it('shows "Searching\u2026" when status is loading but results already exist', () => {
    render(
      <NameSearchResultsPanel {...defaults()} status="loading" results={[jordan]} />,
    );
    expect(screen.getByText(/Searching/)).toBeInTheDocument();
  });

  it('AC-31.8: surfaces the truncated hint when truncated=true', () => {
    render(<NameSearchResultsPanel {...defaults()} truncated results={[jordan]} />);
    expect(screen.getByText(/Showing top 10/i)).toBeInTheDocument();
  });

  it('toggles the detail panel on chip click and closes on re-click', () => {
    render(<NameSearchResultsPanel {...defaults()} results={[jordan, durbin]} />);
    // No detail rendered yet
    expect(screen.queryByTestId('rep-detail-stub')).toBeNull();
    // Click Jordan's chip
    const chips = screen.getAllByRole('button');
    fireEvent.click(chips[0]!);
    expect(screen.getByTestId('rep-detail-stub')).toHaveTextContent('detail:J000289');
    // Re-click same chip to close
    fireEvent.click(chips[0]!);
    expect(screen.queryByTestId('rep-detail-stub')).toBeNull();
  });

  it('switches open rep when a different chip is clicked', () => {
    render(<NameSearchResultsPanel {...defaults()} results={[jordan, durbin]} />);
    const chips = screen.getAllByRole('button');
    fireEvent.click(chips[0]!); // Jordan
    expect(screen.getByTestId('rep-detail-stub')).toHaveTextContent('detail:J000289');
    fireEvent.click(chips[1]!); // Durbin
    expect(screen.getByTestId('rep-detail-stub')).toHaveTextContent('detail:D000563');
  });
});
