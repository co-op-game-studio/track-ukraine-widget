/**
 * Address Lookup Integration Tests
 * Traces to: FR-1, FR-2, FR-3, FR-4, US-1
 *
 * Tests the full address → Census → Congress.gov → Representative[] pipeline
 * via the useAddressLookup hook. Fetch is mocked; services are real.
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

const houseRepIL7 = {
  members: [
    {
      bioguideId: 'D000096',
      name: 'Davis, Danny K.',
      partyName: 'Democratic',
      state: 'Illinois',
      district: 7,
      depiction: { imageUrl: 'https://www.congress.gov/img/member/d000096_200.jpg', attribution: '' },
      terms: { item: [{ chamber: 'House of Representatives', startYear: 1997 }] },
      updateDate: '2025-09-24',
      url: 'https://api.congress.gov/v3/member/D000096',
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
      terms: {
        item: [
          { chamber: 'House of Representatives', startYear: 1983, endYear: 1997 },
          { chamber: 'Senate', startYear: 1997 },
        ],
      },
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
    // House reps are also present in the state-wide response; hook should filter them out
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

// ─── Mock fetch router ───

type RouteMap = Array<{ match: (url: string) => boolean; body: unknown; isXml?: boolean }>;

function routeFetch(routes: RouteMap) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const route = routes.find((r) => r.match(url));
    if (!route) {
      return new Response(`No mock for ${url}`, { status: 500 });
    }
    if (route.isXml) {
      return new Response(route.body as string, {
        status: 200,
        headers: { 'Content-Type': 'application/xml' },
      });
    }
    return new Response(JSON.stringify(route.body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('useAddressLookup', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is idle initially with no data, no error, not loading', () => {
    const { result } = renderHook(() => useAddressLookup(''));
    expect(result.current.status).toBe('idle');
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('resolves an address to state, district, 3 representatives (1 house + 2 senators)', async () => {
    routeFetch([
      { match: (u) => u.includes('/api/census/'), body: censusChicago },
      { match: (u) => /\/api\/congress\/v3\/member\/congress\/119\/IL\/7/.test(u), body: houseRepIL7 },
      { match: (u) => /\/api\/congress\/v3\/member\/congress\/119\/IL(\?|$)/.test(u), body: stateMembersIL },
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
    expect(houseReps[0]!.name).toBe('Davis, Danny K.');
  });

  it('populates error state when Census returns no match', async () => {
    routeFetch([
      { match: (u) => u.includes('/api/census/'), body: censusNoMatch },
    ]);

    const { result } = renderHook(() => useAddressLookup(''));

    await act(async () => {
      await result.current.lookup('Fake Address').catch(() => {});
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBeTruthy();
    expect(result.current.data).toBeNull();
  });

  it('enters loading state while the lookup is in flight', async () => {
    let resolveCensus!: (v: Response) => void;
    const censusPromise = new Promise<Response>((r) => {
      resolveCensus = r;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => censusPromise);

    const { result } = renderHook(() => useAddressLookup(''));

    // Kick off the lookup but do NOT await it inside act — we want to observe
    // the intermediate state
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.lookup('test address').catch(() => {});
    });

    // The hook sets loading synchronously inside the callback start
    await waitFor(() => expect(result.current.status).toBe('loading'));

    // Finish the pending call with a no-match so the hook ends cleanly
    resolveCensus(
      new Response(JSON.stringify(censusNoMatch), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await act(async () => {
      await pending;
    });
  });

  it('uses the apiBase passed in', async () => {
    const fetchSpy = routeFetch([
      { match: (u) => u.includes('/api/census/'), body: censusChicago },
      { match: (u) => u.includes('/api/congress/v3/member/congress/119/IL/7'), body: houseRepIL7 },
      { match: (u) => u.includes('/api/congress/v3/member/congress/119/IL'), body: stateMembersIL },
    ]);

    const hook = renderHook(() => useAddressLookup('/proxy'));
    await act(async () => {
      await hook.result.current.lookup('2000 S State St, Chicago, IL 60616');
    });

    await waitFor(() => expect(hook.result.current.status).toBe('success'));

    const calledUrls = fetchSpy.mock.calls.map((c) => c[0] as string);
    expect(calledUrls.some((u) => u.startsWith('/proxy/api/census/'))).toBe(true);
    expect(calledUrls.some((u) => u.startsWith('/proxy/api/congress/'))).toBe(true);
  });
});
