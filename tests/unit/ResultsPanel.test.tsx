/**
 * ResultsPanel \u2014 chip grid + detail slot for the address-lookup flow.
 * Traces to: US-1 AC-1.3, US-7/US-8 v2.2.0, T-020.
 *
 * RepDetail is stubbed because it fires network calls on mount.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../src/components/RepDetail', () => ({
  RepDetail: ({ representative, onClose }: { representative: { bioguideId: string }; onClose: () => void }) => (
    <div data-testid="rep-detail-stub">
      <span>detail:{representative.bioguideId}</span>
      <button type="button" onClick={onClose}>close-stub</button>
    </div>
  ),
}));

import { ResultsPanel } from '../../src/components/ResultsPanel';
import type { LookupResult, Representative } from '../../src/types/domain';

function senator(bioguideId: string, last: string): Representative {
  return {
    bioguideId, name: `${last}, First`,
    party: 'Democratic', partyAbbreviation: 'D',
    state: 'IL', district: null, chamber: 'senate',
    photoUrl: null, isNonVoting: false, officialWebsiteUrl: null,
  };
}
function house(bioguideId: string, district: number): Representative {
  return {
    bioguideId, name: `Rep${district}, First`,
    party: 'Democratic', partyAbbreviation: 'D',
    state: 'IL', district, chamber: 'house',
    photoUrl: null, isNonVoting: false, officialWebsiteUrl: null,
  };
}

function lookup(overrides: Partial<LookupResult> = {}): LookupResult {
  return {
    state: 'IL',
    district: 7,
    representatives: [senator('D000563', 'Durbin'), senator('D000622', 'Duckworth'), house('D000096', 7)],
    ...overrides,
  };
}

describe('ResultsPanel', () => {
  it('renders an empty-state message when no representatives resolve', () => {
    render(<ResultsPanel result={lookup({ representatives: [] })} apiBase="" />);
    expect(screen.getByRole('status')).toHaveTextContent(/No current federal representatives/i);
  });

  it('renders the state heading and the district line for district > 0', () => {
    const { container } = render(<ResultsPanel result={lookup()} apiBase="" />);
    // The state name also appears inside each MemberChip (AC-7.8 UAT), so
    // target the heading's own class to keep the assertion specific.
    expect(container.querySelector('.viw-results-heading-state')?.textContent)
      .toBe('Illinois');
    expect(screen.getByText(/Congressional District 7/)).toBeInTheDocument();
  });

  it('omits the district heading line when district is 0 (e.g., at-large/DC)', () => {
    render(<ResultsPanel result={lookup({ district: 0 })} apiBase="" />);
    expect(screen.queryByText(/Congressional District/)).toBeNull();
  });

  it('renders Senators column with each senator chip and sorts by name', () => {
    render(<ResultsPanel result={lookup()} apiBase="" />);
    // Senators should list Duckworth before Durbin (alphabetical by name \u2014
    // "Duckworth, First" < "Durbin, First").
    const chips = screen.getAllByRole('button');
    const senatorChips = chips.filter((c) => /Duckworth|Durbin/.test(c.textContent ?? ''));
    expect(senatorChips).toHaveLength(2);
    expect(senatorChips[0]?.textContent).toMatch(/Duckworth/);
    expect(senatorChips[1]?.textContent).toMatch(/Durbin/);
  });

  it('renders the Representative column with the house rep chip', () => {
    render(<ResultsPanel result={lookup()} apiBase="" />);
    expect(screen.getByText('Representative')).toBeInTheDocument();
    expect(screen.getByText(/Rep7/)).toBeInTheDocument();
  });

  it('shows "Seat vacant" placeholders when a column has no reps', () => {
    // Only the house rep \u2014 no senators.
    render(<ResultsPanel result={lookup({ representatives: [house('D000096', 7)] })} apiBase="" />);
    expect(screen.getByText(/Seat vacant/)).toBeInTheDocument();
  });

  it('clicking a chip opens the detail stub; clicking again closes it', () => {
    render(<ResultsPanel result={lookup()} apiBase="" />);
    expect(screen.queryByTestId('rep-detail-stub')).toBeNull();
    // Click Durbin
    const durbinChip = screen.getAllByRole('button').find((b) => /Durbin/.test(b.textContent ?? ''))!;
    fireEvent.click(durbinChip);
    expect(screen.getByTestId('rep-detail-stub')).toHaveTextContent('detail:D000563');
    fireEvent.click(durbinChip);
    expect(screen.queryByTestId('rep-detail-stub')).toBeNull();
  });

  it('clicking a different chip switches the open rep', () => {
    render(<ResultsPanel result={lookup()} apiBase="" />);
    const chips = screen.getAllByRole('button');
    const durbin = chips.find((b) => /Durbin/.test(b.textContent ?? ''))!;
    const house7 = chips.find((b) => /Rep7/.test(b.textContent ?? ''))!;
    fireEvent.click(durbin);
    expect(screen.getByTestId('rep-detail-stub')).toHaveTextContent('detail:D000563');
    fireEvent.click(house7);
    expect(screen.getByTestId('rep-detail-stub')).toHaveTextContent('detail:D000096');
  });

  it('RepDetail stub onClose fires setOpenId(null), collapsing the slot', () => {
    render(<ResultsPanel result={lookup()} apiBase="" />);
    const durbin = screen.getAllByRole('button').find((b) => /Durbin/.test(b.textContent ?? ''))!;
    fireEvent.click(durbin);
    expect(screen.getByTestId('rep-detail-stub')).toBeInTheDocument();
    fireEvent.click(screen.getByText('close-stub'));
    expect(screen.queryByTestId('rep-detail-stub')).toBeNull();
  });
});
