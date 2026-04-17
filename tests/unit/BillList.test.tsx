/**
 * BillList — smart default tab selection.
 * Traces to: US-4 AC-4.6 (v2.2.1).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BillList } from '../../src/components/BillList';
import type { UkraineBill } from '../../src/hooks/useSponsoredBills';

function makeBill(
  relationship: 'sponsored' | 'cosponsored',
  overrides: Partial<UkraineBill> = {},
): UkraineBill {
  return {
    number: 'H.R. 7691',
    title: '$40B Ukraine Supplemental',
    dateIntroduced: '2022-05-10',
    latestAction: 'Became Public Law 117-128',
    congressGovUrl: '',
    relationship,
    featured: true,
    direction: 'pro-ukraine',
    valence: relationship === 'sponsored' ? 'sponsor-pro' : 'sponsor-pro',
    summary: null,
    // The `curated` field is just re-exposed for debugging; tests don't need it.
    curated: {
      congress: 117, type: 'HR', number: '7691',
      featured: true, label: '', title: null,
      latestAction: null, latestActionDate: null,
      becameLaw: true, congressGovUrl: '',
      direction: 'pro-ukraine', directionReason: 'manual',
      summary: null, votes: [],
    },
    ...overrides,
  };
}

describe('BillList default tab selection (AC-4.6)', () => {
  it('defaults to Sponsored when both lists have entries', () => {
    render(
      <BillList
        sponsored={[makeBill('sponsored')]}
        cosponsored={[makeBill('cosponsored')]}
      />,
    );
    const sponsoredTab = screen.getByRole('tab', { name: /Sponsored/ });
    expect(sponsoredTab.getAttribute('aria-selected')).toBe('true');
  });

  it('defaults to Cosponsored when Sponsored is empty but Cosponsored has entries', () => {
    render(
      <BillList
        sponsored={[]}
        cosponsored={[makeBill('cosponsored')]}
      />,
    );
    const cosponsoredTab = screen.getByRole('tab', { name: /Cosponsored/ });
    expect(cosponsoredTab.getAttribute('aria-selected')).toBe('true');
    // And the sponsored tab is NOT selected
    const sponsoredTab = screen.getByRole('tab', { name: /Sponsored/ });
    expect(sponsoredTab.getAttribute('aria-selected')).toBe('false');
  });

  it('defaults to Sponsored when both are empty (stable fallback)', () => {
    render(<BillList sponsored={[]} cosponsored={[]} />);
    const sponsoredTab = screen.getByRole('tab', { name: /Sponsored/ });
    expect(sponsoredTab.getAttribute('aria-selected')).toBe('true');
  });

  it('defaults to Sponsored when Cosponsored is empty but Sponsored has entries', () => {
    render(
      <BillList
        sponsored={[makeBill('sponsored')]}
        cosponsored={[]}
      />,
    );
    const sponsoredTab = screen.getByRole('tab', { name: /Sponsored/ });
    expect(sponsoredTab.getAttribute('aria-selected')).toBe('true');
  });
});
