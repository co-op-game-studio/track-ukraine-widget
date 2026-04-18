/**
 * Sponsored Bills Integration Tests (v3 — KV-profile-backed)
 * Traces to: FR-7, FR-11, US-4
 *
 * Verifies the hook:
 *   - reads sponsored/cosponsored from /api/members/{bioguideId}
 *   - keeps only entries in the curated Ukraine set
 *   - drops amendments (D-6) and other non-matching entries
 *   - marks featured entries
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useSponsoredBills } from '../../src/hooks/useSponsoredBills';

// The KV-backed member profile carries sponsored/cosponsored arrays
// (same CongressLegislationRawEntry shape the hook consumed before).
const profile = {
  bioguideId: 'D000563',
  sponsored: [
    // Ukraine, FEATURED: H.R. 7691 (117) — $40B supplemental
    {
      congress: 117,
      number: '7691',
      type: 'HR',
      title: 'Additional Ukraine Supplemental Appropriations Act, 2022',
      introducedDate: '2022-05-10',
      latestAction: { actionDate: '2022-05-21', text: 'Became Public Law No: 117-128.' },
      url: '',
    },
    // Non-Ukraine — should be filtered out
    {
      congress: 118,
      number: '1',
      type: 'HR',
      title: 'Some random bill',
      introducedDate: '2023-01-09',
      latestAction: { actionDate: '2023-01-10', text: 'Referred.' },
      url: '',
    },
    // Amendment — should be dropped silently (D-6)
    {
      amendmentNumber: '4855',
      congress: 114,
      introducedDate: '2016-06-22',
      latestAction: null,
      type: null,
      url: 'https://api.congress.gov/v3/amendment/114/samdt/4855',
    },
  ],
  cosponsored: [
    // Ukraine, non-featured: H.R. 6833 (117) — FY23 CR with Ukraine supplemental
    {
      congress: 117,
      number: '6833',
      type: 'HR',
      title: 'Continuing Appropriations and Ukraine Supplemental Appropriations Act, 2023',
      introducedDate: '2022-09-28',
      latestAction: { actionDate: '2022-09-30', text: 'Became Public Law No: 117-180.' },
      url: '',
    },
    // Non-Ukraine — filtered out
    {
      congress: 118,
      number: '2',
      type: 'HR',
      title: 'Unrelated act',
      introducedDate: '2023-01-10',
      latestAction: { actionDate: '2023-01-11', text: 'Introduced.' },
      url: '',
    },
  ],
};

function mockProfile(body: unknown, status = 200) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/api/members/')) {
      return new Response(JSON.stringify(body), { status });
    }
    return new Response('miss', { status: 500 });
  });
}

describe('useSponsoredBills (Ukraine-filtered, v3)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('keeps only curated Ukraine bills and drops everything else', async () => {
    mockProfile(profile);

    const { result } = renderHook(() => useSponsoredBills('D000563', ''));
    await act(async () => {
      await result.current.load();
    });
    await waitFor(() => expect(result.current.status).toBe('success'));

    // Sponsored: just HR 7691 (the Ukraine bill). Non-Ukraine and amendment dropped.
    expect(result.current.data!.sponsored).toHaveLength(1);
    expect(result.current.data!.sponsored[0]!.number).toBe('H.R. 7691');
    expect(result.current.data!.sponsored[0]!.relationship).toBe('sponsored');
    expect(result.current.data!.sponsored[0]!.featured).toBe(true);
    expect(result.current.data!.sponsored[0]!.congressGovUrl).toContain('congress.gov');

    // Cosponsored: just HR 6833, not featured.
    expect(result.current.data!.cosponsored).toHaveLength(1);
    expect(result.current.data!.cosponsored[0]!.number).toBe('H.R. 6833');
    expect(result.current.data!.cosponsored[0]!.featured).toBe(false);
  });

  it('D-6: drops amendments (type: null) without crashing', async () => {
    // Regression for the Lankford crash. A profile whose sponsored list
    // contains only amendments should succeed and return empty arrays.
    mockProfile({
      bioguideId: 'L000575',
      sponsored: [
        { amendmentNumber: '4855', congress: 114, introducedDate: '2016-06-22', latestAction: null, type: null, url: '' },
        { amendmentNumber: '4739', congress: 114, introducedDate: '2016-06-16', latestAction: null, type: null, url: '' },
      ],
      cosponsored: [],
    });

    const { result } = renderHook(() => useSponsoredBills('L000575', ''));
    await act(async () => {
      await result.current.load();
    });
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.data!.sponsored).toHaveLength(0);
    expect(result.current.data!.cosponsored).toHaveLength(0);
  });

  it('records error status on fetch failure but does not throw', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const { result } = renderHook(() => useSponsoredBills('D000563', ''));
    await act(async () => {
      await result.current.load();
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBeTruthy();
  });
});
