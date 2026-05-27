/**
 * Tests for proxy/routes/api-upstream.ts → edgeKeyToUrl().
 *
 * Traces to FR-40 AC-40.11 (edge-tier key uniqueness).
 *
 * Background: a 2026-05-03 prod incident produced edge cache poisoning on
 * /api/census/geocoder/... — the wired keyToUrl ignored CacheKey.params and
 * used only the inbound pathname. A single address's empty-match response
 * was then served for every subsequent address at the same POP. AC-40.11
 * codifies the invariant; these tests pin it to the wiring site.
 */
import { describe, expect, it } from 'vitest';
import { edgeKeyToUrl } from '../../../proxy/routes/api-upstream';
import type { CacheKey } from '../../../proxy/cache/key';

const CENSUS_TARGET = 'https://geocoding.geo.census.gov';
const CENSUS_PATH = 'geocoder/geographies/onelineaddress';

describe('edgeKeyToUrl — AC-40.11 key uniqueness', () => {
  it('two census-geocoder keys with different qs produce different URLs', () => {
    const k1: CacheKey = {
      kind: 'census-geocoder',
      params: { path: CENSUS_PATH, qs: 'address=1600+Pennsylvania+Ave+NW' },
    };
    const k2: CacheKey = {
      kind: 'census-geocoder',
      params: { path: CENSUS_PATH, qs: 'address=350+5th+Ave+New+York+NY' },
    };
    const u1 = edgeKeyToUrl(CENSUS_TARGET, CENSUS_PATH, k1).toString();
    const u2 = edgeKeyToUrl(CENSUS_TARGET, CENSUS_PATH, k2).toString();
    expect(u1).not.toBe(u2);
  });

  it('two keys with the same kind+path but different params are distinct', () => {
    const k1: CacheKey = {
      kind: 'house-roster',
      params: { congress: 117, session: 2, rollCall: 78 },
    };
    const k2: CacheKey = {
      kind: 'house-roster',
      params: { congress: 117, session: 2, rollCall: 79 },
    };
    const u1 = edgeKeyToUrl('https://api.congress.gov', 'v3/house-vote/117/2/78/members', k1).toString();
    const u2 = edgeKeyToUrl('https://api.congress.gov', 'v3/house-vote/117/2/79/members', k2).toString();
    expect(u1).not.toBe(u2);
  });

  it('same key produces the same URL (deterministic)', () => {
    const k: CacheKey = {
      kind: 'census-geocoder',
      params: { path: CENSUS_PATH, qs: 'address=1+Main+St' },
    };
    const a = edgeKeyToUrl(CENSUS_TARGET, CENSUS_PATH, k).toString();
    const b = edgeKeyToUrl(CENSUS_TARGET, CENSUS_PATH, k).toString();
    expect(a).toBe(b);
  });
});
