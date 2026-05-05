/**
 * BillStatePills + BillTextDisclosure + cleanSummaryText helper tests.
 *
 * Traces:
 *   AC-52.33 — collapsible bill text & summary
 *   AC-52.66 — derived legislative state pills (Introduced + only-prove-from-data)
 *   AC-52.67 — summary scroll-box collapsed-by-default + cleaned text
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  BillStatePills,
  BillLastActionInline,
  BillSummaryDisclosure,
} from '../../src/admin/components/BillContextSections';
import type { BillRow } from '../../src/admin/types';

const SAMPLE_BILL: Partial<BillRow> = {
  bill_id: '119-HR-1601',
  congress: 119,
  type: 'HR',
  number: '1601',
  title: "Defending Ukraine's Territorial Integrity Act",
  latest_action: 'Referred to the Committee on Foreign Affairs',
  latest_action_date: '2025-04-23',
  became_law: 0,
  congress_gov_url: 'https://www.congress.gov/bill/119th-congress/house-bill/1601',
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('BillStatePills (AC-52.66 — derived legislative state)', () => {
  it('renders Introduced for any bill in the system', () => {
    render(<BillStatePills bill={SAMPLE_BILL} />);
    expect(screen.getByText('Introduced')).toBeInTheDocument();
  });

  it('does NOT render "In progress" — only states proven from the data', () => {
    render(<BillStatePills bill={SAMPLE_BILL} />);
    expect(screen.queryByText(/In progress/i)).toBeNull();
  });

  it('renders Passed House when latest_action mentions house passage', () => {
    render(<BillStatePills bill={{ ...SAMPLE_BILL, latest_action: 'On passage Passed by recorded vote' }} />);
    expect(screen.getByText('Passed House')).toBeInTheDocument();
  });

  it('renders Signed into law when became_law=1', () => {
    render(<BillStatePills bill={{ ...SAMPLE_BILL, became_law: 1 }} />);
    expect(screen.getByText('Signed into law')).toBeInTheDocument();
  });

  it('renders Signed into law when latest_action says "became Public Law"', () => {
    render(<BillStatePills bill={{ ...SAMPLE_BILL, became_law: 0, latest_action: 'Became Public Law No: 119-12.' }} />);
    expect(screen.getByText('Signed into law')).toBeInTheDocument();
  });
});

describe('BillLastActionInline', () => {
  it('renders the date in YYYY-MM-DD form', () => {
    render(<BillLastActionInline bill={SAMPLE_BILL} />);
    expect(screen.getByText(/2025-04-23/)).toBeInTheDocument();
  });

  it('handles ISO timestamps by truncating to the date', () => {
    render(<BillLastActionInline bill={{ ...SAMPLE_BILL, latest_action_date: '2025-04-23T16:38:41Z' }} />);
    expect(screen.getByText(/2025-04-23/)).toBeInTheDocument();
  });

  it('renders nothing when no date is set', () => {
    const { container } = render(<BillLastActionInline bill={{ ...SAMPLE_BILL, latest_action_date: null }} />);
    expect(container.firstChild).toBeNull();
  });

  it('rejects malformed dates (no fragments leaked)', () => {
    const { container } = render(<BillLastActionInline bill={{ ...SAMPLE_BILL, latest_action_date: 'soon' }} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('BillSummaryDisclosure (AC-52.33 + AC-52.67 collapsed scroll-box)', () => {
  function installFetch(bodies: Record<string, unknown>) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      for (const [pat, body] of Object.entries(bodies)) {
        if (url.includes(pat)) {
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      return new Response('{}', { status: 404 });
    });
  }

  it('collapsed by default — text is not visible until disclosure opens', async () => {
    installFetch({
      '/text': { textVersions: [] },
      '/summaries': { summaries: [{ actionDesc: 'Introduced', text: 'Original summary text', updateDate: '2025-04-23' }] },
    });
    render(
      <BillSummaryDisclosure
        congress={119}
        type="HR"
        number="1601"
        congressGovUrl="https://www.congress.gov/bill/119th-congress/house-bill/1601"
      />,
    );
    // Open the outer "Bill text & summary" disclosure
    fireEvent.click(screen.getByRole('button', { name: /Bill text & summary/i }));
    // Wait for the summary fetch to land + the inner <details> to render.
    await waitFor(() => expect(screen.getByText('Introduced')).toBeInTheDocument());
    // The inner details is closed by default — text content should NOT be visible.
    // (jsdom doesn't honor <details>'s native hide; check the open attribute.)
    const innerDetails = screen.getByText('Introduced').closest('details') as HTMLDetailsElement;
    expect(innerDetails).toBeTruthy();
    expect(innerDetails.open).toBe(false);
  });

  it('AC-52.67: summary scroll-box has bounded maxHeight + overflow', async () => {
    installFetch({
      '/text': { textVersions: [] },
      '/summaries': { summaries: [{ actionDesc: 'Reported', text: 'Long body of text', updateDate: '2025-04-23' }] },
    });
    render(
      <BillSummaryDisclosure
        congress={119}
        type="HR"
        number="1601"
        congressGovUrl={null}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Bill text & summary/i }));
    await waitFor(() => expect(screen.getByText('Reported')).toBeInTheDocument());
    // Force the inner details open so we can read the scroll-box style.
    const innerDetails = screen.getByText('Reported').closest('details') as HTMLDetailsElement;
    innerDetails.open = true;
    // Re-query for the scroll region after opening.
    const region = screen.getByRole('region', { name: /Bill summary text/i });
    expect(region.style.maxHeight).toMatch(/240/);
    expect(region.style.overflowY).toBe('auto');
  });

  it('AC-52.67: cleans markdown-ish asterisks out of the summary body', async () => {
    installFetch({
      '/text': { textVersions: [] },
      '/summaries': { summaries: [{ actionDesc: 'Reported', text: '**Sanctioning Russia Act of 2025** This bill imposes * penalties on certain persons.', updateDate: '2025-04-23' }] },
    });
    render(
      <BillSummaryDisclosure
        congress={119}
        type="HR"
        number="1601"
        congressGovUrl={null}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Bill text & summary/i }));
    await waitFor(() => expect(screen.getByText('Reported')).toBeInTheDocument());
    const innerDetails = screen.getByText('Reported').closest('details') as HTMLDetailsElement;
    innerDetails.open = true;
    const region = screen.getByRole('region', { name: /Bill summary text/i });
    expect(region.textContent).toContain('Sanctioning Russia Act of 2025');
    expect(region.textContent).not.toMatch(/\*\*/);
    // Leading "* " bullet should be stripped to a space.
    expect(region.textContent).toMatch(/imposes\s+penalties/);
  });
});
