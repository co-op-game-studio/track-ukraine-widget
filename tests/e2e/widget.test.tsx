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

/**
 * v2.5.2 state-members:v1:IL KV record shape — the Worker returns this
 * verbatim from /api/state-members/IL (AC-32.16, api-contracts.md §5.6).
 */
const stateMembersIL = {
  stateCode: 'IL',
  senators: [
    {
      bioguideId: 'D000563', first: 'Richard', last: 'Durbin',
      officialName: 'Richard Durbin', state: 'IL', district: null,
      chamber: 'Senate', party: 'D',
      photoUrl: null, website: null,
    },
    {
      bioguideId: 'D000622', first: 'Tammy', last: 'Duckworth',
      officialName: 'Tammy Duckworth', state: 'IL', district: null,
      chamber: 'Senate', party: 'D',
      photoUrl: null, website: null,
    },
  ],
  house: [
    {
      bioguideId: 'D000096', first: 'Danny', last: 'Davis',
      officialName: 'Danny Davis', state: 'IL', district: 7,
      chamber: 'House', party: 'D',
      photoUrl: null, website: null,
    },
  ],
  generatedAt: '2026-04-19T02:00:00Z',
  schemaVersion: 1,
};

/** Empty member profile (the widget reads sponsored/cosponsored from here). */
function emptyMemberProfile(bioguideId: string) {
  return {
    bioguideId,
    first: '',
    last: '',
    officialName: '',
    state: 'IL',
    district: null,
    chamber: 'House',
    party: 'D',
    photoUrl: null,
    website: null,
    searchKey: '',
    sponsored: [],
    cosponsored: [],
    generatedAt: '2026-04-19T02:00:00Z',
    schemaVersion: 1,
  };
}

function setupFetchMocks() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/api/census/')) {
      return new Response(JSON.stringify(censusChicago), { status: 200 });
    }
    if (url.includes('/api/state-members/IL')) {
      return new Response(JSON.stringify(stateMembersIL), { status: 200 });
    }
    const memberMatch = url.match(/\/api\/members\/([A-Z]\d{6})/);
    if (memberMatch) {
      return new Response(JSON.stringify(emptyMemberProfile(memberMatch[1]!)), { status: 200 });
    }
    if (url.includes('/api/roll-call-rosters/')) {
      // Empty roster — hook treats the member as Did Not Serve for every
      // curated vote, so there's nothing to display under the detail.
      return new Response(
        JSON.stringify({
          rollCallId: 'x',
          chamber: url.includes('/house/') ? 'house' : 'senate',
          congress: 0, session: 0, rollCall: 0,
          casts: url.includes('/house/') ? {} : [],
          generatedAt: '2026-04-19T02:00:00Z',
          schemaVersion: 1,
        }),
        { status: 200 },
      );
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
      expect(screen.getByText('Durbin, Richard')).toBeInTheDocument();
      expect(screen.getByText('Duckworth, Tammy')).toBeInTheDocument();
      expect(screen.getByText('Davis, Danny')).toBeInTheDocument();
    });

    // And the district heading should show (rendered as two elements in v2)
    expect(screen.getAllByText('Illinois').length).toBeGreaterThan(0);
    expect(screen.getByText(/Congressional District 7/)).toBeInTheDocument();
  });
});
