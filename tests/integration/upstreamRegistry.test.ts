/** Traces: FR-44 AC-44.15 (T-091). */
/**
 * Integration test: every CacheKind that matchRoute emits must have a
 * registered fetcher in createUpstreamRegistry. Guards against a new kind
 * being added to proxy/routes/cache-config.ts without a matching fetcher,
 * which would silently fall through to a null-fetcher path.
 */
import { describe, expect, it, vi } from 'vitest';
import { createUpstreamRegistry } from '../../proxy/upstreams/registry';
import { matchRoute } from '../../proxy/routes/cache-config';
import type { CacheKey, CacheKind } from '../../proxy/cache/key';

const NOW = new Date('2026-04-19T00:00:00Z');

function makeRegistry(): ReturnType<typeof createUpstreamRegistry> {
  return createUpstreamRegistry({
    apiKey: 'test-key',
    fetch: vi.fn(),
    now: () => NOW,
  });
}

interface KindSample {
  readonly kind: CacheKind;
  readonly key: CacheKey;
}

const ROUTED_KINDS: readonly KindSample[] = [
  { kind: 'senate-xml', key: { kind: 'senate-xml', params: { congress: 117, session: 2, rollCall: 78 } } },
  { kind: 'house-roster', key: { kind: 'house-roster', params: { congress: 118, session: 1, rollCall: 5 } } },
  { kind: 'house-vote-detail', key: { kind: 'house-vote-detail', params: { congress: 118, session: 1, rollCall: 5 } } },
  { kind: 'bill-actions', key: { kind: 'bill-actions', params: { congress: 117, type: 'hr', number: 7691 } } },
  { kind: 'bill-summaries', key: { kind: 'bill-summaries', params: { congress: 117, type: 'hr', number: 7691 } } },
  { kind: 'member-detail', key: { kind: 'member-detail', params: { bioguideId: 'D000563' } } },
  { kind: 'census-geocoder', key: { kind: 'census-geocoder', params: { path: 'geocoder/geographies/onelineaddress', qs: 'address=x' } } },
];

describe('createUpstreamRegistry — every matchRoute kind has a fetcher (AC-44.15)', () => {
  it.each(ROUTED_KINDS)('kind=$kind → non-null fetcher that canHandle the key', ({ key }) => {
    const registry = makeRegistry();
    const fetcher = registry.getFor(key);
    expect(fetcher, `no fetcher registered for kind=${key.kind}`).not.toBeNull();
    expect(fetcher!.canHandle(key)).toBe(true);
  });
});

describe('createUpstreamRegistry — KV-only kinds have no upstream fetcher', () => {
  it('member-profile returns null (composed server-side, not fetched)', () => {
    const registry = makeRegistry();
    expect(registry.getFor({ kind: 'member-profile', params: {} })).toBeNull();
  });
});

describe('matchRoute ↔ registry round-trip (URL → CacheKind → Fetcher)', () => {
  it.each([
    ['senate-xml', 'https://x.test/api/senate/legislative/LIS/roll_call_votes/vote1172/vote_117_2_00078.xml'],
    ['bill-actions', 'https://x.test/api/congress/v3/bill/117/hr/7691/actions'],
    ['census-geocoder', 'https://x.test/api/census/geocoder/geographies/onelineaddress?address=1600+Penn&benchmark=4'],
  ])('%s URL resolves to a fetcher that canHandle the key', (expectedKind, url) => {
    const match = matchRoute(new Request(url));
    expect(match).not.toBeNull();
    expect(match!.cacheKind).toBe<CacheKind>(expectedKind as CacheKind);
    const registry = makeRegistry();
    const fetcher = registry.getFor(match!.key);
    expect(fetcher, `no fetcher for URL=${url}`).not.toBeNull();
    expect(fetcher!.canHandle(match!.key)).toBe(true);
  });
});
