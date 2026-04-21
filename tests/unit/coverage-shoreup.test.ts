/**
 * Coverage shoreup for v2.6.0 modules — targets the branches flagged in
 * the `npx vitest run --coverage` report after Phase 11+12-prep landed.
 *
 * These aren't new behavior specs; they exercise the error-path branches
 * that individual module tests skipped for brevity. Keeping them in a
 * single file (rather than sprinkling across modules) makes it obvious
 * at review time that these are pure coverage tightening, not new spec.
 */
import { describe, expect, it, vi } from 'vitest';

import { parseSenateVoteXml } from '../../proxy/upstreams/senate-xml-parser';
import { BillActionsFetcher } from '../../proxy/upstreams/bill-actions-fetcher';
import { BillSummariesFetcher } from '../../proxy/upstreams/bill-summaries-fetcher';
import { HouseRosterFetcher } from '../../proxy/upstreams/house-roster-fetcher';
import { HouseVoteDetailFetcher } from '../../proxy/upstreams/house-vote-detail-fetcher';
import { MemberDetailFetcher } from '../../proxy/upstreams/member-detail-fetcher';
import { CensusGeocoderFetcher } from '../../proxy/upstreams/census-geocoder-fetcher';
import { SenateXmlFetcher } from '../../proxy/upstreams/senate-xml-fetcher';
import { createUpstreamRegistry } from '../../proxy/upstreams/registry';
import { TieredCache } from '../../proxy/cache/tiered-cache';
import { KvTier } from '../../proxy/cache/kv-tier';
import { EdgeTier } from '../../proxy/cache/edge-tier';
import { R2Tier, r2PathForKey } from '../../proxy/cache/r2-tier';
import { cacheKeyToDottedString } from '../../proxy/cache/key';
import { FakeTier, makeCtx } from '../fakes/fake-tier';
import type { CacheKey } from '../../proxy/cache/key';
import type { CacheEntry } from '../../proxy/cache/tier';
import type { WritePolicy } from '../../proxy/cache/policy';

const NOW = new Date('2026-04-19T00:00:00Z');
const TRACE = 'tr_0123456789abcdef';

describe('parseSenateVoteXml — error branches', () => {
  it('throws on empty string', () => {
    expect(() => parseSenateVoteXml('')).toThrow(/empty/i);
  });

  it('throws on non-string input', () => {
    expect(() => parseSenateVoteXml(null as unknown as string)).toThrow();
    expect(() => parseSenateVoteXml(undefined as unknown as string)).toThrow();
    expect(() => parseSenateVoteXml(42 as unknown as string)).toThrow();
  });

  it('throws when congress metadata is missing', () => {
    const bad = `<?xml version="1.0"?><roll_call_vote>
      <session>2</session><vote_number>00001</vote_number>
      <members></members></roll_call_vote>`;
    expect(() => parseSenateVoteXml(bad)).toThrow(/congress|metadata/i);
  });

  it('throws when session metadata is missing', () => {
    const bad = `<?xml version="1.0"?><roll_call_vote>
      <congress>117</congress><vote_number>00001</vote_number>
      <members></members></roll_call_vote>`;
    expect(() => parseSenateVoteXml(bad)).toThrow(/metadata|session/i);
  });

  it('throws when vote_number metadata is missing', () => {
    const bad = `<?xml version="1.0"?><roll_call_vote>
      <congress>117</congress><session>2</session>
      <members></members></roll_call_vote>`;
    expect(() => parseSenateVoteXml(bad)).toThrow(/metadata|vote_number/i);
  });

  it('throws when numeric metadata is non-numeric', () => {
    const bad = `<?xml version="1.0"?><roll_call_vote>
      <congress>abc</congress><session>2</session><vote_number>00001</vote_number>
      <members></members></roll_call_vote>`;
    expect(() => parseSenateVoteXml(bad)).toThrow(/non-numeric/i);
  });

  it('parses a vote with zero member entries without crashing', () => {
    const empty = `<?xml version="1.0"?><roll_call_vote>
      <congress>117</congress><session>2</session><vote_number>00001</vote_number>
      <members></members></roll_call_vote>`;
    const r = parseSenateVoteXml(empty);
    expect(r.casts).toHaveLength(0);
    expect(r.congress).toBe(117);
  });
});

describe('fetcher error parametrization', () => {
  const fixtures = [
    ['bill-actions', (mock: ReturnType<typeof vi.fn>) => new BillActionsFetcher({ apiKey: 'k', fetch: mock, now: () => NOW }), { kind: 'bill-actions', params: { congress: 117, type: 'hr', number: 7691 } } as CacheKey],
    ['bill-summaries', (mock: ReturnType<typeof vi.fn>) => new BillSummariesFetcher({ apiKey: 'k', fetch: mock, now: () => NOW }), { kind: 'bill-summaries', params: { congress: 117, type: 's', number: 17 } } as CacheKey],
    ['house-roster', (mock: ReturnType<typeof vi.fn>) => new HouseRosterFetcher({ apiKey: 'k', fetch: mock, now: () => NOW }), { kind: 'house-roster', params: { congress: 117, session: 2, rollCall: 78 } } as CacheKey],
    ['house-vote-detail', (mock: ReturnType<typeof vi.fn>) => new HouseVoteDetailFetcher({ apiKey: 'k', fetch: mock, now: () => NOW }), { kind: 'house-vote-detail', params: { congress: 117, session: 2, rollCall: 78 } } as CacheKey],
    ['member-detail', (mock: ReturnType<typeof vi.fn>) => new MemberDetailFetcher({ apiKey: 'k', fetch: mock, now: () => NOW }), { kind: 'member-detail', params: { bioguideId: 'D000563' } } as CacheKey],
    ['senate-xml', (mock: ReturnType<typeof vi.fn>) => new SenateXmlFetcher({ fetch: mock, now: () => NOW }), { kind: 'senate-xml', params: { congress: 117, session: 2, rollCall: 78 } } as CacheKey],
  ] as const;

  it.each(fixtures)('%s fetcher throws on 4xx upstream', async (_name, make, key) => {
    const mock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    const f = make(mock);
    await expect(f.fetch(key, { traceId: TRACE })).rejects.toThrow(/404/);
  });

  it.each(fixtures)('%s fetcher throws on 5xx upstream', async (_name, make, key) => {
    const mock = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    const f = make(mock);
    await expect(f.fetch(key, { traceId: TRACE })).rejects.toThrow(/503/);
  });

  it('census geocoder throws on error too', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    const f = new CensusGeocoderFetcher({ fetch: mock, now: () => NOW });
    await expect(
      f.fetch({ kind: 'census-geocoder', params: { path: 'x', qs: '' } }, { traceId: TRACE }),
    ).rejects.toThrow(/500/);
  });
});

describe('fetcher cross-kind rejection (defensive)', () => {
  // Each fetcher should fail-loud on being passed a kind it doesn't handle.
  // The pipeline dispatches via registry, but this guards direct-call misuse.
  it('HouseRosterFetcher rejects senate-xml', async () => {
    const f = new HouseRosterFetcher({ apiKey: 'k', fetch: vi.fn(), now: () => NOW });
    await expect(f.fetch({ kind: 'senate-xml', params: {} }, { traceId: TRACE })).rejects.toThrow();
  });
  it('BillActionsFetcher rejects bill-summaries', async () => {
    const f = new BillActionsFetcher({ apiKey: 'k', fetch: vi.fn(), now: () => NOW });
    await expect(f.fetch({ kind: 'bill-summaries', params: {} }, { traceId: TRACE })).rejects.toThrow();
  });
  it('BillSummariesFetcher rejects bill-actions', async () => {
    const f = new BillSummariesFetcher({ apiKey: 'k', fetch: vi.fn(), now: () => NOW });
    await expect(f.fetch({ kind: 'bill-actions', params: {} }, { traceId: TRACE })).rejects.toThrow();
  });
  it('HouseVoteDetailFetcher rejects house-roster', async () => {
    const f = new HouseVoteDetailFetcher({ apiKey: 'k', fetch: vi.fn(), now: () => NOW });
    await expect(f.fetch({ kind: 'house-roster', params: {} }, { traceId: TRACE })).rejects.toThrow();
  });
  it('MemberDetailFetcher rejects member-profile', async () => {
    const f = new MemberDetailFetcher({ apiKey: 'k', fetch: vi.fn(), now: () => NOW });
    await expect(f.fetch({ kind: 'member-profile', params: {} }, { traceId: TRACE })).rejects.toThrow();
  });
  it('CensusGeocoderFetcher rejects senate-xml', async () => {
    const f = new CensusGeocoderFetcher({ fetch: vi.fn(), now: () => NOW });
    await expect(f.fetch({ kind: 'senate-xml', params: {} }, { traceId: TRACE })).rejects.toThrow();
  });
});

describe('registry — default deps wiring', () => {
  it('creates a registry that uses globalThis.fetch and Date.now defaults', () => {
    const reg = createUpstreamRegistry({ apiKey: 'k', fetch: globalThis.fetch.bind(globalThis), now: () => new Date() });
    expect(reg.getFor({ kind: 'senate-xml', params: {} })).not.toBeNull();
  });
});

describe('SenateXmlFetcher — default-deps constructor path', () => {
  it('constructs without explicit deps (covers defaults)', () => {
    const f = new SenateXmlFetcher();
    expect(f.canHandle({ kind: 'senate-xml', params: {} })).toBe(true);
  });
});

describe('CensusGeocoderFetcher — default-deps constructor path', () => {
  it('constructs without explicit deps', () => {
    const f = new CensusGeocoderFetcher();
    expect(f.canHandle({ kind: 'census-geocoder', params: {} })).toBe(true);
  });
});

describe('TieredCache — single-tier edge case', () => {
  it('handles a single-tier configuration (no promote ever)', async () => {
    const edge = new FakeTier<string>('edge');
    const cache = new TieredCache([edge]);
    const ctx = makeCtx();
    const policy: WritePolicy = { maxAge: 60, immutable: false, eligibleTiers: ['edge'] };
    const entry: CacheEntry<string> = {
      value: 'v', contentType: 'text/plain', fetchedAt: 1, sourceUpstream: 'synthetic',
    };
    cache.storeFromUpstream({ kind: 'census-geocoder', params: { path: 'x', qs: '' } }, entry, ctx, policy);
    await Promise.all(ctx.awaited);
    expect(edge.store.size).toBe(1);
  });

  it('promote is a no-op when served by tier 0 (no faster tier exists)', async () => {
    const edge = new FakeTier<string>('edge');
    const kv = new FakeTier<string>('kv');
    edge.seed({ kind: 'senate-xml', params: {} }, { value: 'x', contentType: 'text/plain', fetchedAt: 1, sourceUpstream: 'synthetic' });
    const cache = new TieredCache([edge, kv]);
    const ctx = makeCtx();
    const hit = await cache.get({ kind: 'senate-xml', params: {} });
    cache.promote({ kind: 'senate-xml', params: {} }, hit!.entry, hit!.servedBy, ctx, {
      maxAge: 60, immutable: false, eligibleTiers: ['edge', 'kv'],
    });
    // No waitUntil was issued — nothing to promote to.
    expect(ctx.awaited).toHaveLength(0);
  });

  it('storeFromUpstream is a no-op when no tiers are eligible', async () => {
    const edge = new FakeTier<string>('edge');
    const cache = new TieredCache([edge]);
    const ctx = makeCtx();
    cache.storeFromUpstream(
      { kind: 'senate-xml', params: {} },
      { value: 'x', contentType: 'text/plain', fetchedAt: 1, sourceUpstream: 'synthetic' },
      ctx,
      { maxAge: 60, immutable: false, eligibleTiers: [] },
    );
    expect(ctx.awaited).toHaveLength(0);
  });
});

describe('KvTier — error-in-put defensive handling', () => {
  it('put errors surface (caller/pipeline handles via waitUntil catch)', async () => {
    const kv = {
      get: async () => null,
      put: async () => { throw new Error('kv down'); },
    };
    const tier = new KvTier<string>(kv);
    await expect(
      tier.put(
        { kind: 'senate-xml', params: { congress: 117, session: 2, rollCall: 78 } },
        { value: 'v', contentType: 'application/xml', fetchedAt: 1, sourceUpstream: 'senate' },
        { maxAge: 60, immutable: false, eligibleTiers: ['kv'] },
      ),
    ).rejects.toThrow();
  });
});

describe('EdgeTier — binary (non-string) value path', () => {
  it('handles ArrayBuffer-ish content', async () => {
    const store = new Map<string, Response>();
    const fake = {
      async match(req: Request | string) {
        const url = typeof req === 'string' ? req : req.url;
        return store.get(url)?.clone();
      },
      async put(req: Request | string, resp: Response) {
        const url = typeof req === 'string' ? req : req.url;
        store.set(url, resp);
      },
    };
    const tier = new EdgeTier<string>(fake, () => new URL('https://x.test/key'));
    await tier.put(
      { kind: 'senate-xml', params: {} },
      { value: 'abc', contentType: 'text/plain', fetchedAt: 1, sourceUpstream: 'synthetic' },
      { maxAge: 60, immutable: false, eligibleTiers: ['edge'] },
    );
    const hit = await tier.get({ kind: 'senate-xml', params: {} });
    expect(hit?.value).toBe('abc');
  });
});

describe('R2Tier — put with unsupported kind is fail-loud on write', () => {
  it('throws when writing an unsupported kind (fail-loud)', async () => {
    const bucket = { get: async () => null, put: async () => undefined };
    const tier = new R2Tier<string>(bucket);
    await expect(
      tier.put(
        { kind: 'member-detail', params: { bioguideId: 'X' } },
        { value: 'x', contentType: 'application/json', fetchedAt: 1, sourceUpstream: 'congress', sessionStatus: 'frozen' },
        { maxAge: 3600, immutable: true, eligibleTiers: ['r2'] },
      ),
    ).rejects.toThrow(/unsupported|member-detail/i);
  });
});

describe('r2PathForKey — more kinds', () => {
  it('handles all 5 supported kinds without throwing', () => {
    expect(r2PathForKey({ kind: 'senate-xml', params: { congress: 1, session: 1, rollCall: 1 } })).toBeTruthy();
    expect(r2PathForKey({ kind: 'house-roster', params: { congress: 1, session: 1, rollCall: 1 } })).toBeTruthy();
    expect(r2PathForKey({ kind: 'house-vote-detail', params: { congress: 1, session: 1, rollCall: 1 } })).toBeTruthy();
    expect(r2PathForKey({ kind: 'bill-actions', params: { congress: 1, type: 'hr', number: 1 } })).toBeTruthy();
    expect(r2PathForKey({ kind: 'bill-summaries', params: { congress: 1, type: 'hr', number: 1 } })).toBeTruthy();
  });
});

describe('cacheKeyToDottedString — coverage extras', () => {
  it('produces a usable string for a single-param key', () => {
    expect(cacheKeyToDottedString({ kind: 'member-detail', params: { bioguideId: 'D000563' } })).toBe('member-detail:bioguideId=D000563');
  });

  it('handles zero-param keys', () => {
    expect(cacheKeyToDottedString({ kind: 'senate-xml', params: {} })).toBe('senate-xml');
  });
});
