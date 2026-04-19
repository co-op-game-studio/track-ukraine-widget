/**
 * Tests for proxy/routes/cache-config.ts.
 *
 * Per-route mapping from URL path → { cacheKind, policy, keyFromRequest }.
 * Policy assignments must match FR-41's data-type eligibility matrix.
 *
 * Traces: FR-40 AC-40.8, FR-41 AC-41.* eligibility matrix.
 */
import { describe, expect, it } from 'vitest';
import { matchRoute } from '../../../proxy/routes/cache-config';

describe('matchRoute — senate XML pass-through', () => {
  it('recognizes /api/senate/legislative/LIS/roll_call_votes/... as senate-xml', () => {
    const url = new URL('https://host/api/senate/legislative/LIS/roll_call_votes/vote1172/vote_117_2_00078.xml');
    const req = new Request(url.toString());
    const m = matchRoute(req);
    expect(m).not.toBeNull();
    expect(m?.cacheKind).toBe('senate-xml');
    expect(m?.key.params).toEqual({ congress: 117, session: 2, rollCall: 78 });
  });

  it('policy for senate-xml is eligible for edge+kv+r2 and marked immutable', () => {
    const url = new URL('https://host/api/senate/legislative/LIS/roll_call_votes/vote1172/vote_117_2_00078.xml');
    const m = matchRoute(new Request(url.toString()));
    expect(m?.policy.immutable).toBe(true);
    expect(m?.policy.eligibleTiers).toEqual(['edge', 'kv', 'r2']);
  });
});

describe('matchRoute — house roster + detail', () => {
  it('recognizes /api/congress/v3/house-vote/{c}/{s}/{rc}/members as house-roster', () => {
    const url = new URL('https://host/api/congress/v3/house-vote/118/1/5/members');
    const m = matchRoute(new Request(url.toString()));
    expect(m?.cacheKind).toBe('house-roster');
    expect(m?.key.params).toEqual({ congress: 118, session: 1, rollCall: 5 });
    expect(m?.policy.eligibleTiers).toContain('r2');
  });

  it('recognizes /api/congress/v3/house-vote/{c}/{s}/{rc} as house-vote-detail', () => {
    const url = new URL('https://host/api/congress/v3/house-vote/118/1/5');
    const m = matchRoute(new Request(url.toString()));
    expect(m?.cacheKind).toBe('house-vote-detail');
  });
});

describe('matchRoute — bill actions/summaries', () => {
  it('recognizes /api/congress/v3/bill/{c}/{type}/{num}/actions', () => {
    const url = new URL('https://host/api/congress/v3/bill/117/hr/7691/actions');
    const m = matchRoute(new Request(url.toString()));
    expect(m?.cacheKind).toBe('bill-actions');
    expect(m?.key.params).toEqual({ congress: 117, type: 'hr', number: 7691 });
  });

  it('recognizes /api/congress/v3/bill/{c}/{type}/{num}/summaries', () => {
    const url = new URL('https://host/api/congress/v3/bill/117/hr/7691/summaries');
    const m = matchRoute(new Request(url.toString()));
    expect(m?.cacheKind).toBe('bill-summaries');
  });
});

describe('matchRoute — member detail (NOT r2-eligible)', () => {
  it('recognizes /api/congress/v3/member/{bioguideId} as member-detail', () => {
    const url = new URL('https://host/api/congress/v3/member/D000563');
    const m = matchRoute(new Request(url.toString()));
    expect(m?.cacheKind).toBe('member-detail');
    expect(m?.key.params).toEqual({ bioguideId: 'D000563' });
  });

  it('member-detail policy excludes r2 from eligibleTiers', () => {
    const url = new URL('https://host/api/congress/v3/member/D000563');
    const m = matchRoute(new Request(url.toString()));
    expect(m?.policy.eligibleTiers).not.toContain('r2');
    expect(m?.policy.eligibleTiers).toContain('edge');
    expect(m?.policy.eligibleTiers).toContain('kv');
  });
});

describe('matchRoute — census geocoder (NOT r2-eligible)', () => {
  it('carries path + filtered qs as CacheKey params', () => {
    const url = new URL(
      'https://host/api/census/geocoder/geographies/onelineaddress?address=1600+Penn&benchmark=4&vintage=Current_Current&format=json&attacker=xxx',
    );
    const m = matchRoute(new Request(url.toString()));
    expect(m?.cacheKind).toBe('census-geocoder');
    expect(m?.key.params.path).toBe('geocoder/geographies/onelineaddress');
    // query should include the allowlisted keys, NOT the attacker-controlled one
    const qs = String(m?.key.params.qs);
    expect(qs).toContain('address=');
    expect(qs).toContain('benchmark=4');
    expect(qs).not.toContain('attacker');
  });

  it('census-geocoder policy excludes r2', () => {
    const url = new URL('https://host/api/census/geocoder/x?address=y');
    const m = matchRoute(new Request(url.toString()));
    expect(m?.policy.eligibleTiers).not.toContain('r2');
  });
});

describe('matchRoute — non-match', () => {
  it('returns null for non-/api/* paths', () => {
    expect(matchRoute(new Request('https://host/'))).toBeNull();
    expect(matchRoute(new Request('https://host/voter-info-widget.iife.js'))).toBeNull();
  });

  it('returns null for /api/members (KV-backed, not a cache route)', () => {
    // KV-backed routes live outside the tiered cache — they are their own
    // read path. This ensures we don't accidentally wrap them.
    expect(matchRoute(new Request('https://host/api/members/D000563'))).toBeNull();
  });

  it('returns null for /api/name-search (KV-backed)', () => {
    expect(matchRoute(new Request('https://host/api/name-search?q=x'))).toBeNull();
  });

  it('returns null for unknown /api/congress/v3/* paths', () => {
    expect(matchRoute(new Request('https://host/api/congress/v3/totally/unknown'))).toBeNull();
  });
});
