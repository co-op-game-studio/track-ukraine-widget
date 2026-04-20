/**
 * RepDetail \u2014 full-width member detail panel.
 * Traces to: US-2, US-3, US-4, US-5, US-7, US-8, FR-16, FR-32 AC-32.1.
 *
 * Hooks (useVotingRecord, useSponsoredBills, useUkraineScore) are mocked so
 * the component can be rendered in isolation; child lists (VoteList,
 * BillList, UkraineScoreBadge) render against the stubbed hook outputs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { UkraineBill } from '../../src/hooks/useSponsoredBills';

// Stub the three hooks. Each test can override the return value via the
// exported setters below before render.
let votingRecordMock = {
  status: 'success',
  data: {
    clusters: [],
    flat: [],
    voteScore: { score: 0, contributing: 0, total: 0, lowConfidence: false },
    obstructionCount: 0,
    primaryAbstentionCount: 0,
  },
  error: null as Error | null,
  load: vi.fn(),
  reset: vi.fn(),
};
let billsMock: {
  status: string;
  data: { sponsored: UkraineBill[]; cosponsored: UkraineBill[] };
  error: Error | null;
  load: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
} = {
  status: 'success',
  data: { sponsored: [], cosponsored: [] },
  error: null,
  load: vi.fn(),
  reset: vi.fn(),
};
let scoreMock: { score: number | null; contributing: number; total: number; lowConfidence: boolean } | null = {
  score: 0.5,
  contributing: 10,
  total: 10,
  lowConfidence: false,
};

vi.mock('../../src/hooks/useVotingRecord', () => ({
  useVotingRecord: () => votingRecordMock,
}));
vi.mock('../../src/hooks/useSponsoredBills', () => ({
  useSponsoredBills: () => billsMock,
}));
vi.mock('../../src/hooks/useUkraineScore', () => ({
  useUkraineScore: () => scoreMock,
}));

import { RepDetail } from '../../src/components/RepDetail';
import type { Representative } from '../../src/types/domain';

const durbin: Representative = {
  bioguideId: 'D000563',
  name: 'Durbin, Richard J.',
  party: 'Democratic',
  partyAbbreviation: 'D',
  state: 'IL',
  district: null,
  chamber: 'senate',
  photoUrl: 'https://www.congress.gov/img/member/d000563_200.jpg',
  isNonVoting: false,
  officialWebsiteUrl: 'https://www.durbin.senate.gov',
};

const jordan: Representative = {
  bioguideId: 'J000289',
  name: 'Jordan, Jim',
  party: 'Republican',
  partyAbbreviation: 'R',
  state: 'OH',
  district: 4,
  chamber: 'house',
  photoUrl: null,
  isNonVoting: false,
  officialWebsiteUrl: null,
};

const dcDelegate: Representative = {
  bioguideId: 'N000147',
  name: 'Norton, Eleanor',
  party: 'Democratic',
  partyAbbreviation: 'D',
  state: 'DC',
  district: 0,
  chamber: 'house',
  photoUrl: null,
  isNonVoting: true,
  officialWebsiteUrl: null,
};

beforeEach(() => {
  // Every useEffect hits /api/members/{id} for enrichment \u2014 mock it to 200
  // with null fields so nothing changes.
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({
      photoUrl: null,
      website: null,
      district: null,
      officialName: null,
    }), { status: 200 }),
  );
  // Reset mocks to defaults between tests.
  votingRecordMock = {
    status: 'success',
    data: {
      clusters: [],
      flat: [],
      voteScore: { score: 0, contributing: 0, total: 0, lowConfidence: false },
      obstructionCount: 0,
      primaryAbstentionCount: 0,
    },
    error: null,
    load: vi.fn(),
    reset: vi.fn(),
  };
  billsMock = {
    status: 'success',
    data: { sponsored: [], cosponsored: [] },
    error: null,
    load: vi.fn(),
    reset: vi.fn(),
  };
  scoreMock = { score: 0.5, contributing: 10, total: 10, lowConfidence: false };
});
afterEach(() => vi.restoreAllMocks());

describe('RepDetail', () => {
  it('renders the member name, state, party, and senator chamber label', () => {
    render(<RepDetail representative={durbin} apiBase="" onClose={() => {}} />);
    expect(screen.getByText('Durbin, Richard J.')).toBeInTheDocument();
    expect(screen.getByText(/Illinois/)).toBeInTheDocument();
    expect(screen.getByText(/U\.S\. Senator/)).toBeInTheDocument();
    expect(screen.getByText('DEMOCRATIC')).toBeInTheDocument();
  });

  it('renders "U.S. Representative \u00b7 District N" for House members with a district', () => {
    render(<RepDetail representative={jordan} apiBase="" onClose={() => {}} />);
    expect(screen.getByText(/U\.S\. Representative/)).toBeInTheDocument();
    expect(screen.getByText(/District 4/)).toBeInTheDocument();
  });

  it('renders "U.S. Representative" with no district suffix when district is null', () => {
    const noDistrict: Representative = { ...jordan, district: null };
    const { container } = render(
      <RepDetail representative={noDistrict} apiBase="" onClose={() => {}} />,
    );
    expect(screen.getByText('U.S. Representative')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/District\s+null/i);
  });

  it('renders "Delegate (non-voting)" for non-voting delegates and disables Votes tab', () => {
    render(<RepDetail representative={dcDelegate} apiBase="" onClose={() => {}} />);
    expect(screen.getByText(/Delegate \(non-voting\)/)).toBeInTheDocument();
    // Votes tab SHALL be disabled for non-voting house delegates.
    const votesTab = screen.getByRole('tab', { name: /Ukraine Votes/i }) as HTMLButtonElement;
    expect(votesTab.disabled).toBe(true);
  });

  it('shows the "Official website" link when URL is present and sanitizes http(s) only', () => {
    render(<RepDetail representative={durbin} apiBase="" onClose={() => {}} />);
    const link = screen.getByRole('link', { name: /Official website/i });
    expect(link.getAttribute('href')).toBe('https://www.durbin.senate.gov');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
  });

  it('AC-31.1: rejects a javascript: officialWebsiteUrl and hides the link', () => {
    const spoofed: Representative = {
      ...durbin,
      officialWebsiteUrl: 'javascript:alert(1)',
    };
    render(<RepDetail representative={spoofed} apiBase="" onClose={() => {}} />);
    expect(screen.queryByRole('link', { name: /Official website/i })).toBeNull();
  });

  it('renders a photo when photoUrl is an http(s) URL, placeholder otherwise', () => {
    const { container, rerender } = render(
      <RepDetail representative={durbin} apiBase="" onClose={() => {}} />,
    );
    expect(container.querySelector('.viw-detail-photo')).not.toBeNull();
    expect(container.querySelector('img.viw-detail-photo')).not.toBeNull();

    rerender(
      <RepDetail
        representative={{ ...durbin, photoUrl: null }}
        apiBase=""
        onClose={() => {}}
      />,
    );
    expect(container.querySelector('.viw-detail-photo-placeholder')).not.toBeNull();
  });

  it('Close button fires onClose', () => {
    const onClose = vi.fn();
    render(<RepDetail representative={durbin} apiBase="" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /Close detail panel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders UkraineScoreBadge for voting members and hides it for non-voting delegates', () => {
    const { container, rerender } = render(
      <RepDetail representative={durbin} apiBase="" onClose={() => {}} />,
    );
    expect(container.querySelector('.viw-score')).not.toBeNull();

    rerender(<RepDetail representative={dcDelegate} apiBase="" onClose={() => {}} />);
    expect(container.querySelector('.viw-score')).toBeNull();
  });

  it('switches tabs between Votes and Legislation', () => {
    render(<RepDetail representative={durbin} apiBase="" onClose={() => {}} />);
    const billsTab = screen.getByRole('tab', { name: /Ukraine Legislation/i });
    fireEvent.click(billsTab);
    expect(billsTab.getAttribute('aria-selected')).toBe('true');
    const votesTab = screen.getByRole('tab', { name: /Ukraine Votes/i });
    expect(votesTab.getAttribute('aria-selected')).toBe('false');
  });

  it('renders the non-voting delegate hint in the body when delegate selects Votes', () => {
    render(<RepDetail representative={dcDelegate} apiBase="" onClose={() => {}} />);
    // Votes tab is disabled \u2014 default tab still Votes \u2014 body should show the hint.
    expect(screen.getByText(/Non-voting delegate \u2014 no floor vote record/i)).toBeInTheDocument();
  });

  it('enriches the rep with /api/members/{id} photoUrl when the base rep has none', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        photoUrl: 'https://example.com/p.jpg',
        website: null,
        district: null,
        officialName: null,
      }), { status: 200 }),
    );
    const { container } = render(
      <RepDetail
        representative={{ ...durbin, photoUrl: null }}
        apiBase=""
        onClose={() => {}}
      />,
    );
    await waitFor(() => {
      const img = container.querySelector('img.viw-detail-photo') as HTMLImageElement | null;
      expect(img?.src).toBe('https://example.com/p.jpg');
    });
  });

  it('enrichment swallows fetch rejection and keeps the base representative', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    render(<RepDetail representative={durbin} apiBase="" onClose={() => {}} />);
    // No throw, photo still rendered from base rep.
    expect(screen.getByText('Durbin, Richard J.')).toBeInTheDocument();
  });

  it('aggregates obstruction count from voting + anti-UA sponsorships + anti-UA cosponsorships', () => {
    votingRecordMock.data = {
      ...votingRecordMock.data,
      obstructionCount: 2,
    };
    billsMock.data = {
      sponsored: [
        {
          number: 'H.R. 1', title: 't', dateIntroduced: '', latestAction: '',
          congressGovUrl: '', relationship: 'sponsored', featured: false,
          direction: 'anti-ukraine', valence: 'sponsor-anti', summary: null,
          curated: {
            congress: 118, type: 'HR', number: '1',
            direction: 'anti-ukraine', directionReason: 'manual',
            featured: false, title: 't', label: 'l',
            latestAction: '', latestActionDate: '', becameLaw: false,
            congressGovUrl: '', summary: null, votes: [],
          },
        },
      ],
      cosponsored: [],
    };
    // Score must be set so the badge renders (otherwise N/A bypasses the note).
    scoreMock = { score: 0.1, contributing: 5, total: 5, lowConfidence: false };
    render(<RepDetail representative={durbin} apiBase="" onClose={() => {}} />);
    // obstructionCount rendered into the badge callout only when >= 2.
    // 2 voting + 1 sponsored anti = 3 total.
    expect(screen.getByRole('note')).toHaveTextContent(/3/);
  });

  /** FR-48: SocialsRow rendering covers the icon-map branches for each
   *  platform. Asserts the link URLs and aria-labels, which exercises
   *  the SOCIAL_ICONS lookup for every key. */
  it('FR-48: renders icon-links for every social handle present', () => {
    const withSocials: Representative = {
      ...durbin,
      socials: {
        twitter: 'senatordurbin',
        facebook: 'SenatorDurbin',
        youtube: 'senatordurbin',
        instagram: 'senatordurbin',
      },
    };
    render(<RepDetail representative={withSocials} apiBase="" onClose={() => {}} />);
    expect(screen.getByLabelText(/Durbin.+on Twitter/i)).toHaveAttribute(
      'href', 'https://twitter.com/senatordurbin',
    );
    expect(screen.getByLabelText(/Durbin.+on Facebook/i)).toHaveAttribute(
      'href', 'https://facebook.com/SenatorDurbin',
    );
    expect(screen.getByLabelText(/Durbin.+on YouTube/i)).toHaveAttribute(
      'href', 'https://youtube.com/@senatordurbin',
    );
    expect(screen.getByLabelText(/Durbin.+on Instagram/i)).toHaveAttribute(
      'href', 'https://instagram.com/senatordurbin',
    );
  });

  it('FR-48: renders no social row when socials object is absent or empty', () => {
    render(<RepDetail representative={durbin} apiBase="" onClose={() => {}} />);
    expect(screen.queryByRole('list', { name: /social media accounts/i })).toBeNull();
    // Empty socials object — no individual handles populated.
    const empty = { ...durbin, socials: {} };
    render(<RepDetail representative={empty} apiBase="" onClose={() => {}} />);
    expect(screen.queryByRole('list', { name: /social media accounts/i })).toBeNull();
  });
});
