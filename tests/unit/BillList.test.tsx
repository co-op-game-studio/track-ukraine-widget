/**
 * BillList — smart default tab selection + pagination + expand/collapse +
 * loading/error/empty states + obstruction row styling.
 * Traces to: US-4 AC-4.1\u20134.6, AC-34.4.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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

describe('BillList loading / error / empty states', () => {
  it('renders loading placeholder when loading=true and both lists empty', () => {
    const { container } = render(
      <BillList sponsored={[]} cosponsored={[]} loading />,
    );
    expect(container.querySelector('.viw-billlist-empty')).not.toBeNull();
    expect(container.textContent).toMatch(/Loading/);
  });

  it('renders an alert with the error message when error is set', () => {
    render(
      <BillList
        sponsored={[]}
        cosponsored={[]}
        error="Congress is down."
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Congress is down/);
  });

  it('renders an empty-state message when the active tab has no entries', () => {
    render(<BillList sponsored={[]} cosponsored={[]} />);
    // Default tab is Sponsored \u2014 empty state copy mentions "sponsored".
    expect(screen.getByText(/not sponsored any curated Ukraine-related/i)).toBeInTheDocument();
  });
});

describe('BillList pagination (AC-4.5 \u2014 5 per page)', () => {
  function nBills(n: number): UkraineBill[] {
    return Array.from({ length: n }, (_, i) =>
      makeBill('sponsored', { number: `H.R. ${100 + i}`, title: `Bill ${i}` }),
    );
  }

  it('does NOT render pagination when \u2264 5 bills', () => {
    render(<BillList sponsored={nBills(3)} cosponsored={[]} />);
    expect(screen.queryByRole('navigation', { name: /Pagination/i })).toBeNull();
  });

  it('renders pagination navigation when bills exceed page size', () => {
    render(<BillList sponsored={nBills(12)} cosponsored={[]} />);
    const nav = screen.getByRole('navigation', { name: /Pagination/i });
    expect(nav).toBeInTheDocument();
    expect(within(nav).getByText(/Page 1 of 3/)).toBeInTheDocument();
  });

  it('Next advances to page 2; Prev returns to page 1; Prev on page 1 is disabled', () => {
    render(<BillList sponsored={nBills(12)} cosponsored={[]} />);
    const prevBtn = screen.getByRole('button', { name: /Prev/i }) as HTMLButtonElement;
    const nextBtn = screen.getByRole('button', { name: /Next/i }) as HTMLButtonElement;

    expect(prevBtn.disabled).toBe(true);
    expect(nextBtn.disabled).toBe(false);

    fireEvent.click(nextBtn);
    expect(screen.getByText(/Page 2 of 3/)).toBeInTheDocument();
    expect(prevBtn.disabled).toBe(false);

    fireEvent.click(prevBtn);
    expect(screen.getByText(/Page 1 of 3/)).toBeInTheDocument();
  });

  it('Next on the final page is disabled', () => {
    render(<BillList sponsored={nBills(7)} cosponsored={[]} />);
    const nextBtn = screen.getByRole('button', { name: /Next/i }) as HTMLButtonElement;
    fireEvent.click(nextBtn);
    expect(screen.getByText(/Page 2 of 2/)).toBeInTheDocument();
    expect(nextBtn.disabled).toBe(true);
  });
});

describe('BillList row click / expand / BillSummary', () => {
  it('clicking a row expands it and renders the BillSummary child row', () => {
    render(
      <BillList
        sponsored={[makeBill('sponsored', {
          summary: {
            text: 'First paragraph.\n\nSecond paragraph.',
            actionDate: '2022-05-21',
            actionDesc: 'Public Law',
            updateDate: null,
          },
        })]}
        cosponsored={[]}
      />,
    );
    // Click the row \u2014 the summary row SHALL appear.
    const row = screen.getByText('$40B Ukraine Supplemental').closest('tr')!;
    fireEvent.click(row);
    expect(screen.getByText(/First paragraph/)).toBeInTheDocument();
    expect(screen.getByText(/Second paragraph/)).toBeInTheDocument();
    // "Public Law" also appears in latestAction; scope to the summary area.
    const summaryMeta = document.querySelector('.viw-billlist-summary-meta');
    expect(summaryMeta?.textContent).toMatch(/Public Law/);
  });

  it('re-clicking the expanded row collapses it', () => {
    render(
      <BillList
        sponsored={[makeBill('sponsored', {
          summary: {
            text: 'Only para.',
            actionDate: null,
            actionDesc: null,
            updateDate: null,
          },
        })]}
        cosponsored={[]}
      />,
    );
    const row = screen.getByText('$40B Ukraine Supplemental').closest('tr')!;
    fireEvent.click(row);
    expect(screen.getByText(/Only para/)).toBeInTheDocument();
    fireEvent.click(row);
    expect(screen.queryByText(/Only para/)).toBeNull();
  });

  it('BillSummary falls back to "No summary is available" when summary is null', () => {
    render(
      <BillList
        sponsored={[makeBill('sponsored', {
          summary: null,
          congressGovUrl: 'https://congress.gov/bill/117/hr/7691',
        })]}
        cosponsored={[]}
      />,
    );
    const row = screen.getByText('$40B Ukraine Supplemental').closest('tr')!;
    fireEvent.click(row);
    expect(screen.getByText(/No summary is available/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /congress\.gov/i });
    expect(link.getAttribute('href')).toBe('https://congress.gov/bill/117/hr/7691');
  });
});

describe('BillList obstruction labeling (FR-21)', () => {
  it('marks sponsor-anti rows with an OBSTRUCTION tag', () => {
    render(
      <BillList
        sponsored={[makeBill('sponsored', {
          valence: 'sponsor-anti',
          direction: 'anti-ukraine',
        })]}
        cosponsored={[]}
      />,
    );
    expect(screen.getByText('OBSTRUCTION')).toBeInTheDocument();
  });
});

describe('BillList tab switching', () => {
  it('switches the visible list when the user clicks the alternate tab', () => {
    render(
      <BillList
        sponsored={[makeBill('sponsored', { title: 'SponsoredBill' })]}
        cosponsored={[makeBill('cosponsored', { title: 'CosponsoredBill' })]}
      />,
    );
    expect(screen.getByText('SponsoredBill')).toBeInTheDocument();
    expect(screen.queryByText('CosponsoredBill')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /Cosponsored/ }));
    expect(screen.getByText('CosponsoredBill')).toBeInTheDocument();
    expect(screen.queryByText('SponsoredBill')).toBeNull();
  });
});
