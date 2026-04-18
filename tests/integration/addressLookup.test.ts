/**
 * Address Lookup Integration Tests (v2.5.2 — ADR-012).
 *
 * Tests the full address → Census → state-members → Representative[]
 * pipeline via the useAddressLookup hook. Fetch is mocked; services
 * are real.
 *
 * Traces to: FR-1, FR-2, FR-3, FR-4 (REVISED v2.5.2), US-1, FR-32 AC-32.16.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAddressLookup } from '../../src/hooks/useAddressLookup';

// ─── Shared fixtures ───

const censusChicago = {
  result: {
    addressMatches: [
      {
        matchedAddress: '2000 S STATE ST, CHICAGO, IL, 60616',
        coordinates: { x: -87.627, y: 41.855 },
        addressComponents: { city: 'CHICAGO', state: 'IL', zip: '60616', streetName: 'STATE' },
        geographies: {
          States: [{ STATE: '17', NAME: 'Illinois', GEOID: '17', BASENAME: 'Illinois', FUNCSTAT: 'A' }],
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

const censusNoMatch = { result: { addressMatches: [] } };

/** AC-32.16 state-members:v1:IL record (as served by the Worker route). */
const stateMembersIL = {
  stateCode: 'IL',
  senators: [
    {
      bioguideId: 'D000563',
      first: 'Richard',
      last: 'Durbin',
      officialName: 'Richard Durbin',
      state: 'IL',
      district: null,
      chamber: 'Senate',
      party: 'D',
      photoUrl: 'https://www.congress.gov/img/member/d000563_200.jpg',
      website: 'https://www.durbin.senate.gov',
    },
    {
      bioguideId: 'D000622',
      first: 'Tammy',
      last: 'Duckworth',
      officialName: 'Tammy Duckworth',
      state: 'IL',
      district: null,
      chamber: 'Senate',
      party: 'D',
      photoUrl: 'https://www.congress.gov/img/member/d000622_200.jpg',
      website: 'https://www.duckworth.senate.gov',
    },
  ],
  house: [
    {
      bioguideId: 'J000309',
      first: 'Jonathan',
      last: 'Jackson',
      officialName: 'Jonathan Jackson',
      state: 'IL',
      district: 1,
      chamber: 'House',
      party: 'D',
      photoUrl: null,
      website: null,
    },
    {
      bioguideId: 'D000096',
      first: 'Danny',
      last: 'Davis',
      officialName: 'Danny Davis',
      state: 'IL',
      district: 7,
      chamber: 'House',
      party: 'D',
      photoUrl: 'https://www.congress.gov/img/member/d000096_200.jpg',
      website: 'https://davis.house.gov',
    },
  ],
  generatedAt: '2026-04-19T02:00:00Z',
  schemaVersion: 1,
};

// ─── Mock fetch router ───

type RouteMap = Array<{ match: (url: string) => boolean; body: unknown; status?: number }>;

function routeFetch(routes: RouteMap) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const route = routes.find((r) => r.match(url));
    if (!route) {
      return new Response(`No mock for ${url}`, { status: 500 });
    }
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('useAddressLookup (v2.5.2 — state-members KV)', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('is idle initially with no data, no error, not loading', () => {
    const { result } = renderHook(() => useAddressLookup(''));
    expect(result.current.status).toBe('idle');
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('resolves an address to state, district, 3 representatives (2 senators + 1 house rep for district)', async () => {
    routeFetch([
      { match: (u) => u.includes('/api/census/'), body: censusChicago },
      { match: (u) => u.includes('/api/state-members/IL'), body: stateMembersIL },
    ]);

    const { result } = renderHook(() => useAddressLookup(''));
    await act(async () => {
      await result.current.lookup('2000 S State St, Chicago, IL 60616');
    });
    await waitFor(() => expect(result.current.status).toBe('success'));

    expect(result.current.data).not.toBeNull();
    expect(result.current.data!.state).toBe('IL');
    expect(result.current.data!.district).toBe(7);
    expect(result.current.data!.representatives).toHaveLength(3);

    const senators = result.current.data!.representatives.filter((r) => r.chamber === 'senate');
    const houseReps = result.current.data!.representatives.filter((r) => r.chamber === 'house');
    expect(senators).toHaveLength(2);
    expect(houseReps).toHaveLength(1);
    expect(houseReps[0]!.district).toBe(7);
    expect(houseReps[0]!.bioguideId).toBe('D000096');
  });

  it('populates error state when Census returns no match', async () => {
    routeFetch([{ match: (u) => u.includes('/api/census/'), body: censusNoMatch }]);

    const { result } = renderHook(() => useAddressLookup(''));
    await act(async () => {
      await result.current.lookup('Fake Address').catch(() => {});
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBeTruthy();
    expect(result.current.data).toBeNull();
  });

  it('populates error state when state-members route returns 404', async () => {
    routeFetch([
      { match: (u) => u.includes('/api/census/'), body: censusChicago },
      { match: (u) => u.includes('/api/state-members/IL'), body: { error: 'state_members_not_found' }, status: 404 },
    ]);

    const { result } = renderHook(() => useAddressLookup(''));
    await act(async () => {
      await result.current.lookup('2000 S State St, Chicago, IL 60616').catch(() => {});
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBeTruthy();
  });

  it('enters loading state while the lookup is in flight', async () => {
    let resolveCensus!: (v: Response) => void;
    const censusPromise = new Promise<Response>((r) => { resolveCensus = r; });
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => censusPromise);

    const { result } = renderHook(() => useAddressLookup(''));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.lookup('test address').catch(() => {});
    });
    await waitFor(() => expect(result.current.status).toBe('loading'));
    resolveCensus(new Response(JSON.stringify(censusNoMatch), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await act(async () => { await pending; });
  });

  it('uses the apiBase passed in for both census and state-members calls', async () => {
    const fetchSpy = routeFetch([
      { match: (u) => u.includes('/api/census/'), body: censusChicago },
      { match: (u) => u.includes('/api/state-members/IL'), body: stateMembersIL },
    ]);

    const hook = renderHook(() => useAddressLookup('/proxy'));
    await act(async () => {
      await hook.result.current.lookup('2000 S State St, Chicago, IL 60616');
    });
    await waitFor(() => expect(hook.result.current.status).toBe('success'));

    const calledUrls = fetchSpy.mock.calls.map((c) => c[0] as string);
    expect(calledUrls.some((u) => u.startsWith('/proxy/api/census/'))).toBe(true);
    expect(calledUrls.some((u) => u.startsWith('/proxy/api/state-members/IL'))).toBe(true);
    // AC-32.16 / T-042 invariant: no upstream congress/senate calls from
    // this hook anymore.
    expect(calledUrls.some((u) => /\/api\/congress\//.test(u))).toBe(false);
    expect(calledUrls.some((u) => /\/api\/senate\//.test(u))).toBe(false);
  });
});
