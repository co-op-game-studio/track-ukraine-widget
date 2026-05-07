/**
 * BillSponsorshipSection + BillActionsSection tests.
 *
 * Traces:
 *   AC-52.58 — sponsor + cosponsors panel with original-cosponsor marker
 *   AC-52.59 — actions list with Congressional Record links
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  BillSponsorshipSection,
  BillActionsSection,
} from '../../src/admin/components/BillSponsorshipSections';
import type { BillRow, BillCosponsorRow, BillActionRow } from '../../src/admin/types';

function installFetch(opts: { cosponsors?: BillCosponsorRow[]; actions?: BillActionRow[] } = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/api/admin/cosponsors')) {
      return new Response(JSON.stringify({ items: opts.cosponsors ?? [] }), { status: 200 });
    }
    if (url.includes('/api/admin/actions')) {
      return new Response(JSON.stringify({ items: opts.actions ?? [] }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

const SAMPLE_BILL: Partial<BillRow> = {
  bill_id: '119-HR-1601',
  sponsor_full_name: 'Rep. Fitzpatrick, Brian K.',
  sponsor_party: 'R',
  sponsor_state: 'PA',
  introduced_date: '2025-03-18',
};

const COSPONSORS: BillCosponsorRow[] = [
  {
    id: 'c1',
    bill_id: '119-HR-1601',
    bioguide_id: 'C001078',
    full_name: 'Rep. Connolly, Gerald E.',
    party: 'D',
    state: 'VA',
    district: '11',
    is_original_cosponsor: 1,
    sponsorship_date: '2025-03-18',
    sponsorship_withdrawn_date: null,
    congress_update_date: '2025-04-23',
    created_at: '2025-04-23T00:00:00Z',
    updated_at: '2025-04-23T00:00:00Z',
  },
  {
    id: 'c2',
    bill_id: '119-HR-1601',
    bioguide_id: 'V000133',
    full_name: 'Rep. Vasquez, Gabe',
    party: 'D',
    state: 'NM',
    district: '2',
    is_original_cosponsor: 0,
    sponsorship_date: '2025-12-17',
    sponsorship_withdrawn_date: null,
    congress_update_date: '2025-12-17',
    created_at: '2025-12-17T00:00:00Z',
    updated_at: '2025-12-17T00:00:00Z',
  },
];

const ACTIONS: BillActionRow[] = [
  {
    id: 'a1',
    bill_id: '119-HR-1601',
    action_date: '2025-04-23',
    action_text: 'Referred to the Committee on Foreign Affairs.',
    action_code: 'H11100',
    source_system: 'House floor actions',
    congressional_record_url: null,
    congressional_record_citation: null,
    recorded_chamber: null,
    recorded_roll_call: null,
    congress_update_date: '2025-04-23',
    created_at: '2025-04-23T00:00:00Z',
    updated_at: '2025-04-23T00:00:00Z',
  },
  {
    id: 'a2',
    bill_id: '119-HR-1601',
    action_date: '2025-04-20',
    action_text: 'On agreeing to the amendment',
    action_code: null,
    source_system: 'Library of Congress',
    congressional_record_url: 'https://www.congress.gov/congressional-record/volume-170/issue-70/house-section/article/H2593-1',
    congressional_record_citation: 'H2593-H2594',
    recorded_chamber: 'House',
    recorded_roll_call: 148,
    congress_update_date: '2025-04-23',
    created_at: '2025-04-23T00:00:00Z',
    updated_at: '2025-04-23T00:00:00Z',
  },
];

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('BillSponsorshipSection (AC-52.58)', () => {
  it('count badge reflects cosponsor count + original count', async () => {
    installFetch({ cosponsors: COSPONSORS });
    render(<BillSponsorshipSection billId="119-HR-1601" bill={SAMPLE_BILL} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Sponsorship \(2 cosponsors, 1 original\)/i })).toBeInTheDocument(),
    );
  });

  it('handles 0 cosponsors with grammatical "0 cosponsors"', async () => {
    installFetch({ cosponsors: [] });
    render(<BillSponsorshipSection billId="119-HR-1601" bill={SAMPLE_BILL} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Sponsorship \(0 cosponsors, 0 original\)/i })).toBeInTheDocument(),
    );
  });

  it('expanded panel shows sponsor with party/state and intro date', async () => {
    installFetch({ cosponsors: COSPONSORS });
    render(<BillSponsorshipSection billId="119-HR-1601" bill={SAMPLE_BILL} />);
    await waitFor(() => screen.getByRole('button', { name: /Sponsorship/i }));
    fireEvent.click(screen.getByRole('button', { name: /Sponsorship/i }));
    expect(screen.getByText(/Rep. Fitzpatrick, Brian K\./)).toBeInTheDocument();
    expect(screen.getByText(/\(R-PA\)/)).toBeInTheDocument();
    expect(screen.getByText(/introduced 2025-03-18/i)).toBeInTheDocument();
  });

  it('marks original cosponsor with ★ badge', async () => {
    installFetch({ cosponsors: COSPONSORS });
    render(<BillSponsorshipSection billId="119-HR-1601" bill={SAMPLE_BILL} />);
    await waitFor(() => screen.getByRole('button', { name: /Sponsorship/i }));
    fireEvent.click(screen.getByRole('button', { name: /Sponsorship/i }));
    // Connolly is original (★); Vasquez is not.
    const connolly = screen.getByText(/Rep. Connolly, Gerald E\./i);
    const connollyLi = connolly.closest('li');
    expect(connollyLi?.querySelector('[title="Original cosponsor"]')).toBeTruthy();

    const vasquez = screen.getByText(/Rep. Vasquez, Gabe/i);
    const vasquezLi = vasquez.closest('li');
    expect(vasquezLi?.querySelector('[title="Original cosponsor"]')).toBeNull();
  });
});

describe('BillActionsSection (AC-52.59)', () => {
  it('count badge shows total + CR-ref count', async () => {
    installFetch({ actions: ACTIONS });
    render(<BillActionsSection billId="119-HR-1601" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Action history \(2, 1 CR refs\)/i })).toBeInTheDocument(),
    );
  });

  it('count badge omits CR suffix when no Congressional Record refs', async () => {
    installFetch({ actions: [ACTIONS[0]!] });
    render(<BillActionsSection billId="119-HR-1601" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Action history \(1\)/i })).toBeInTheDocument(),
    );
  });

  it('renders Congressional Record link as ↗ external link with citation', async () => {
    installFetch({ actions: ACTIONS });
    render(<BillActionsSection billId="119-HR-1601" />);
    await waitFor(() => screen.getByRole('button', { name: /Action history/i }));
    fireEvent.click(screen.getByRole('button', { name: /Action history/i }));
    const crLink = screen.getByRole('link', { name: /↗ Congressional Record \(H2593-H2594\)/i });
    expect(crLink).toHaveAttribute('href', 'https://www.congress.gov/congressional-record/volume-170/issue-70/house-section/article/H2593-1');
    expect(crLink).toHaveAttribute('target', '_blank');
    expect(crLink.getAttribute('rel')).toMatch(/noopener/);
  });

  it('surfaces recorded vote linkage as inline tag', async () => {
    installFetch({ actions: ACTIONS });
    render(<BillActionsSection billId="119-HR-1601" />);
    await waitFor(() => screen.getByRole('button', { name: /Action history/i }));
    fireEvent.click(screen.getByRole('button', { name: /Action history/i }));
    expect(screen.getByText(/recorded vote: house roll 148/i)).toBeInTheDocument();
  });

  it('graceful empty state when no actions', async () => {
    installFetch({ actions: [] });
    render(<BillActionsSection billId="119-HR-1601" />);
    await waitFor(() => screen.getByRole('button', { name: /Action history \(0\)/i }));
    fireEvent.click(screen.getByRole('button', { name: /Action history/i }));
    expect(screen.getByText(/no actions recorded yet/i)).toBeInTheDocument();
  });

  it('renders Congressional Record link without citation when none provided', async () => {
    const actionNoCitation: BillActionRow = {
      ...ACTIONS[1]!,
      id: 'a3',
      congressional_record_citation: null,
    };
    installFetch({ actions: [actionNoCitation] });
    render(<BillActionsSection billId="119-HR-1601" />);
    await waitFor(() => screen.getByRole('button', { name: /Action history/i }));
    fireEvent.click(screen.getByRole('button', { name: /Action history/i }));
    // Link still renders; "↗ Congressional Record" with no parens suffix.
    const crLink = screen.getByRole('link', { name: /↗ Congressional Record/i });
    expect(crLink.textContent?.trim()).toBe('↗ Congressional Record');
    expect(crLink.textContent).not.toMatch(/\(/);
  });
});

describe('BillActionsSection — error + null-field branches', () => {
  it('shows error banner when /api/admin/actions fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/api/admin/actions')) {
        return new Response(JSON.stringify({ error: 'db_down', detail: 'D1 timeout' }), { status: 500 });
      }
      return new Response('not found', { status: 404 });
    });
    render(<BillActionsSection billId="119-HR-1601" />);
    // Header still renders even on error.
    await waitFor(
      () => screen.getByRole('button', { name: /Action history/i }),
      { timeout: 3000 },
    );
    fireEvent.click(screen.getByRole('button', { name: /Action history/i }));
    await waitFor(
      () => expect(screen.getByText(/Error loading actions:/i)).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it('handles null action_date / action_text with em-dash + "(no text)" placeholders', async () => {
    const minimalAction: BillActionRow = {
      ...ACTIONS[0]!,
      id: 'a-min',
      action_date: null,
      action_text: null,
      source_system: null,
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/api/admin/actions')) {
        return new Response(JSON.stringify({ items: [minimalAction] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    render(<BillActionsSection billId="119-HR-1601" />);
    await waitFor(
      () => screen.getByRole('button', { name: /Action history \(1\)/i }),
      { timeout: 3000 },
    );
    fireEvent.click(screen.getByRole('button', { name: /Action history/i }));
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText(/\(no text\)/)).toBeInTheDocument();
  });
});

describe('BillSponsorshipSection — error path', () => {
  it('captures error from /api/admin/cosponsors and renders banner when expanded', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/api/admin/cosponsors')) {
        return new Response(JSON.stringify({ error: 'unauthorized', detail: 'CF Access required' }), { status: 401 });
      }
      return new Response('not found', { status: 404 });
    });
    render(<BillSponsorshipSection billId="119-HR-1601" bill={SAMPLE_BILL} />);
    await waitFor(
      () => screen.getByRole('button', { name: /Sponsorship/i }),
      { timeout: 3000 },
    );
    fireEvent.click(screen.getByRole('button', { name: /Sponsorship/i }));
    await waitFor(
      () => expect(screen.getByText(/Error loading cosponsors/i)).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });
});

describe('BillSponsorshipSection — expanded empty state', () => {
  it('shows "(no cosponsors recorded)" when expanded with empty cosponsor list', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/api/admin/cosponsors')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    render(<BillSponsorshipSection billId="119-HR-1601" bill={SAMPLE_BILL} />);
    await waitFor(
      () => screen.getByRole('button', { name: /Sponsorship \(0 cosponsors, 0 original\)/i }),
      { timeout: 3000 },
    );
    fireEvent.click(screen.getByRole('button', { name: /Sponsorship/i }));
    expect(screen.getByText(/no cosponsors recorded/i)).toBeInTheDocument();
  });
});
