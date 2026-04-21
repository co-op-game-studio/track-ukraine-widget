/**
 * Cache-Control picker tests — AC-25.2, AC-25.3 (REVISED v2.5.2), AC-25.4 (REVISED v2.5.2).
 *
 * These tests pin the Cache-Control header values the Worker emits for each
 * upstream-route class. The v2.5.2 revision bumped semi-mutable sponsored/
 * cosponsored TTLs and added `stale-while-revalidate` to Congress routes.
 */
import { describe, expect, it } from 'vitest';
import { pickApiCacheControl, API_ROUTES, type ApiRouteRule } from '../../proxy/lib';

const CENSUS = API_ROUTES.find((r) => r.upstreamName === 'census')!;
const SENATE = API_ROUTES.find((r) => r.upstreamName === 'senate')!;
const CONGRESS = API_ROUTES.find((r) => r.upstreamName === 'congress')!;

describe('AC-25.2 — immutable routes', () => {
  it('house-vote rolls return a 1y immutable directive', () => {
    const cc = pickApiCacheControl(CONGRESS, 'v3/house-vote/117/2/185/members');
    expect(cc).toBe('public, s-maxage=31536000, max-age=31536000, immutable');
  });

  it('bill actions return a 1y immutable directive', () => {
    const cc = pickApiCacheControl(CONGRESS, 'v3/bill/117/hr/7691/actions');
    expect(cc).toBe('public, s-maxage=31536000, max-age=31536000, immutable');
  });

  it('bill summaries return a 1y immutable directive', () => {
    const cc = pickApiCacheControl(CONGRESS, 'v3/bill/117/hr/7691/summaries');
    expect(cc).toBe('public, s-maxage=31536000, max-age=31536000, immutable');
  });

  it('Senate XML route (handled via SENATE rule) is immutable', () => {
    // The senate rule's baseline cacheControl is immutable per AC-25.2.
    expect(SENATE.cacheControl).toBe(
      'public, s-maxage=31536000, max-age=31536000, immutable',
    );
  });
});

describe('AC-25.3 (REVISED v2.5.2) — semi-mutable sponsored/cosponsored', () => {
  it('sponsored-legislation returns 7d edge + 24h browser + 1h SWR', () => {
    const cc = pickApiCacheControl(
      CONGRESS,
      'v3/member/D000563/sponsored-legislation',
    );
    expect(cc).toBe(
      'public, s-maxage=604800, max-age=86400, stale-while-revalidate=3600',
    );
  });

  it('cosponsored-legislation returns 7d edge + 24h browser + 1h SWR', () => {
    const cc = pickApiCacheControl(
      CONGRESS,
      'v3/member/D000563/cosponsored-legislation',
    );
    expect(cc).toBe(
      'public, s-maxage=604800, max-age=86400, stale-while-revalidate=3600',
    );
  });

  // Regression: pre-v2.5.2 value was `public, s-maxage=3600, max-age=300`
  // (1h edge, 5min browser, no SWR). Asserting the OLD string is NOT returned
  // catches accidental reverts.
  it('does not return the pre-v2.5.2 TTL string', () => {
    const cc = pickApiCacheControl(
      CONGRESS,
      'v3/member/D000563/sponsored-legislation',
    );
    expect(cc).not.toBe('public, s-maxage=3600, max-age=300');
  });
});

describe('AC-25.4 (REVISED v2.5.2) — default Congress routes (member detail + list)', () => {
  it('member detail returns 24h edge + 24h browser + 1h SWR', () => {
    const cc = pickApiCacheControl(CONGRESS, 'v3/member/D000563');
    expect(cc).toBe(
      'public, s-maxage=86400, max-age=86400, stale-while-revalidate=3600',
    );
  });

  it('state member-list returns 24h edge + 24h browser + 1h SWR', () => {
    const cc = pickApiCacheControl(CONGRESS, 'v3/member/congress/119/IL');
    expect(cc).toBe(
      'public, s-maxage=86400, max-age=86400, stale-while-revalidate=3600',
    );
  });

  it('Census geocoder uses its own baseline rule (AC-25.4)', () => {
    // The Census rule is a separate ApiRouteRule; pickApiCacheControl returns
    // its baseline directly for any non-congress upstream.
    const cc = pickApiCacheControl(CENSUS, 'geographies/onelineaddress');
    expect(cc).toBe('public, s-maxage=86400, max-age=3600');
  });

  it('does not return the pre-v2.5.2 1h/1h value', () => {
    const cc = pickApiCacheControl(CONGRESS, 'v3/member/D000563');
    expect(cc).not.toBe('public, s-maxage=3600, max-age=3600');
  });
});

describe('Non-congress routes pass through their own baseline cacheControl', () => {
  it('senate route returns the SENATE rule baseline', () => {
    const fakeRule: ApiRouteRule = {
      prefix: '/api/x/',
      upstreamName: 'senate',
      target: 'https://example.invalid',
      injectKey: false,
      cacheControl: 'public, max-age=1',
      upstreamAccept: '*/*',
      allowedQueryParams: [],
    };
    expect(pickApiCacheControl(fakeRule, 'anything')).toBe('public, max-age=1');
  });

  it('census route returns the CENSUS rule baseline', () => {
    const fakeRule: ApiRouteRule = {
      prefix: '/api/x/',
      upstreamName: 'census',
      target: 'https://example.invalid',
      injectKey: false,
      cacheControl: 'public, max-age=42',
      upstreamAccept: '*/*',
      allowedQueryParams: [],
    };
    expect(pickApiCacheControl(fakeRule, 'anything')).toBe('public, max-age=42');
  });
});
