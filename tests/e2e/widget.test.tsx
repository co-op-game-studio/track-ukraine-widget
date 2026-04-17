/**
 * End-to-end widget integration test.
 * Traces to: T-021, all user stories.
 *
 * Fires up the real VoterInfoWidget with mocked fetch for every external API,
 * types in an address, clicks Look Up, and asserts rep cards render.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { VoterInfoWidget } from '../../src/VoterInfoWidget';

const censusChicago = {
  result: {
    addressMatches: [
      {
        matchedAddress: '2000 S STATE ST, CHICAGO, IL, 60616',
        coordinates: { x: -87, y: 41 },
        addressComponents: { city: 'CHICAGO', state: 'IL', zip: '60616', streetName: 'STATE' },
        geographies: {
          '119th Congressional Districts': [
            {
              STATE: '17',
              CD119: '07',
              CDSESSN: '119',
              NAME: 'Congressional District 7',
              GEOID: '1707',
              BASENAME: '7',
              FUNCSTAT: 'N',
            },
          ],
        },
      },
    ],
  },
};

const houseRepIL7 = {
  members: [
    {
      bioguideId: 'D000096',
      name: 'Davis, Danny K.',
      partyName: 'Democratic',
      state: 'Illinois',
      district: 7,
      depiction: { imageUrl: '', attribution: '' },
      terms: { item: [{ chamber: 'House of Representatives', startYear: 1997 }] },
      updateDate: '2025-09-24',
      url: '',
    },
  ],
  pagination: { count: 1 },
  request: {},
};

const stateMembersIL = {
  members: [
    {
      bioguideId: 'D000563',
      name: 'Durbin, Richard J.',
      partyName: 'Democratic',
      state: 'Illinois',
      district: null,
      terms: { item: [{ chamber: 'Senate', startYear: 1997 }] },
      updateDate: '2026-03-08',
      url: '',
    },
    {
      bioguideId: 'D000622',
      name: 'Duckworth, Tammy',
      partyName: 'Democratic',
      state: 'Illinois',
      district: null,
      terms: { item: [{ chamber: 'Senate', startYear: 2017 }] },
      updateDate: '2026-03-08',
      url: '',
    },
    {
      bioguideId: 'D000096',
      name: 'Davis, Danny K.',
      partyName: 'Democratic',
      state: 'Illinois',
      district: 7,
      terms: { item: [{ chamber: 'House of Representatives', startYear: 1997 }] },
      updateDate: '2025-09-24',
      url: '',
    },
  ],
  pagination: { count: 19 },
  request: {},
};

// Empty vote list + empty bills so RepCards don't explode
const emptyVotes = { houseRollCallVotes: [], pagination: { count: 0 } };
const emptySenateIndex = `<?xml version="1.0"?><vote_summary><congress>119</congress><session>2</session><votes></votes></vote_summary>`;
const emptySponsored = { sponsoredLegislation: [], pagination: { count: 0 } };
const emptyCosponsored = { cosponsoredLegislation: [], pagination: { count: 0 } };

function setupFetchMocks() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/api/census/')) {
      return new Response(JSON.stringify(censusChicago), { status: 200 });
    }
    if (url.includes('/v3/member/congress/119/IL/7')) {
      return new Response(JSON.stringify(houseRepIL7), { status: 200 });
    }
    if (url.includes('/v3/member/congress/119/IL')) {
      return new Response(JSON.stringify(stateMembersIL), { status: 200 });
    }
    if (url.includes('/house-vote/')) {
      return new Response(JSON.stringify(emptyVotes), { status: 200 });
    }
    if (url.includes('vote_menu_')) {
      return new Response(emptySenateIndex, {
        status: 200,
        headers: { 'Content-Type': 'application/xml' },
      });
    }
    if (url.includes('/sponsored-legislation')) {
      return new Response(JSON.stringify(emptySponsored), { status: 200 });
    }
    if (url.includes('/cosponsored-legislation')) {
      return new Response(JSON.stringify(emptyCosponsored), { status: 200 });
    }
    return new Response(`No mock for ${url}`, { status: 500 });
  });
}

describe('VoterInfoWidget (e2e)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setupFetchMocks();
  });

  it('full flow: enter address → see three rep cards', async () => {
    render(<VoterInfoWidget apiBase="" />);

    const input = screen.getByLabelText(/home address/i);
    fireEvent.change(input, { target: { value: '2000 S State St, Chicago, IL 60616' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /look up/i }));
    });

    await waitFor(() => {
      expect(screen.getByText('Durbin, Richard J.')).toBeInTheDocument();
      expect(screen.getByText('Duckworth, Tammy')).toBeInTheDocument();
      expect(screen.getByText('Davis, Danny K.')).toBeInTheDocument();
    });

    // And the district heading should show (rendered as two elements in v2)
    expect(screen.getAllByText('Illinois').length).toBeGreaterThan(0);
    expect(screen.getByText(/Congressional District 7/)).toBeInTheDocument();
  });
});
