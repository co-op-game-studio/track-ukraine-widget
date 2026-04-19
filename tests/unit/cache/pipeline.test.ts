/**
 * Tests for proxy/cache/pipeline.ts — serveCached() request pipeline.
 *
 * Traces to FR-40 AC-40.6, AC-40.9 (header emission), FR-41 AC-41.9.
 * Error paths use the FR-37 envelope shape.
 */
import { describe, expect, it } from 'vitest';
import { serveCached } from '../../../proxy/cache/pipeline';
import { TieredCache } from '../../../proxy/cache/tiered-cache';
import { FakeTier, makeCtx } from '../../fakes/fake-tier';
import type { CacheKey } from '../../../proxy/cache/key';
import type { WritePolicy } from '../../../proxy/cache/policy';
import type { CacheEntry } from '../../../proxy/cache/tier';
import type { UpstreamFetcher, UpstreamFetchContext } from '../../../proxy/upstreams/fetcher';

const KEY: CacheKey = {
  kind: 'senate-xml',
  params: { congress: 117, session: 2, rollCall: 78 },
};
const IMMUTABLE_POLICY: WritePolicy = {
  maxAge: 31_536_000,
  immutable: true,
  eligibleTiers: ['edge', 'kv', 'r2'],
};

function makeEntry(overrides: Partial<CacheEntry<string>> = {}): CacheEntry<string> {
  return {
    value: '<?xml?><ok/>',
    contentType: 'application/xml',
    fetchedAt: 1_000,
    sourceUpstream: 'senate',
    sessionStatus: 'frozen',
    ...overrides,
  };
}

class FixtureFetcher implements UpstreamFetcher<string> {
  public readonly calls: CacheKey[] = [];
  constructor(private readonly resolver: (k: CacheKey, ctx: UpstreamFetchContext) => CacheEntry<string> | Error) {}
  canHandle(_key: CacheKey): boolean { return true; }
  async fetch(key: CacheKey, ctx: UpstreamFetchContext): Promise<CacheEntry<string>> {
    this.calls.push(key);
    const r = this.resolver(key, ctx);
    if (r instanceof Error) throw r;
    return r;
  }
}

describe('serveCached — cache hit paths', () => {
  it('HIT:edge → X-Cache=HIT + X-Cache-Tier=edge', async () => {
    const edge = new FakeTier<string>('edge');
    const kv = new FakeTier<string>('kv');
    edge.seed(KEY, makeEntry());
    const cache = new TieredCache([edge, kv]);
    const fetcher = new FixtureFetcher(() => new Error('should not call upstream'));
    const ctx = makeCtx();

    const resp = await serveCached({
      key: KEY,
      cache,
      fetcher,
      policy: IMMUTABLE_POLICY,
      ctx,
      traceId: 'tr_0123456789abcdef',
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get('X-Cache')).toBe('HIT');
    expect(resp.headers.get('X-Cache-Tier')).toBe('edge');
    expect(await resp.text()).toBe('<?xml?><ok/>');
    expect(fetcher.calls).toHaveLength(0);
  });

  it('HIT:kv → promote writes to edge via waitUntil', async () => {
    const edge = new FakeTier<string>('edge');
    const kv = new FakeTier<string>('kv');
    kv.seed(KEY, makeEntry());
    const cache = new TieredCache([edge, kv]);
    const fetcher = new FixtureFetcher(() => new Error('no'));
    const ctx = makeCtx();

    const resp = await serveCached({
      key: KEY, cache, fetcher, policy: IMMUTABLE_POLICY, ctx, traceId: 'tr_0123456789abcdef',
    });
    await Promise.all(ctx.awaited);

    expect(resp.headers.get('X-Cache-Tier')).toBe('kv');
    expect(edge.store.size).toBe(1);
  });

  it('HIT:r2 → promote writes to edge + kv', async () => {
    const edge = new FakeTier<string>('edge');
    const kv = new FakeTier<string>('kv');
    const r2 = new FakeTier<string>('r2');
    r2.seed(KEY, makeEntry());
    const cache = new TieredCache([edge, kv, r2]);
    const fetcher = new FixtureFetcher(() => new Error('no'));
    const ctx = makeCtx();

    const resp = await serveCached({
      key: KEY, cache, fetcher, policy: IMMUTABLE_POLICY, ctx, traceId: 'tr_0123456789abcdef',
    });
    await Promise.all(ctx.awaited);

    expect(resp.headers.get('X-Cache-Tier')).toBe('r2');
    expect(edge.store.size).toBe(1);
    expect(kv.store.size).toBe(1);
  });
});

describe('serveCached — cache miss → upstream', () => {
  it('all tiers miss → calls fetcher, returns with X-Cache=MISS + X-Cache-Tier=upstream', async () => {
    const edge = new FakeTier<string>('edge');
    const kv = new FakeTier<string>('kv');
    const cache = new TieredCache([edge, kv]);
    const fetcher = new FixtureFetcher(() => makeEntry({ value: 'fresh' }));
    const ctx = makeCtx();

    const resp = await serveCached({
      key: KEY, cache, fetcher, policy: IMMUTABLE_POLICY, ctx, traceId: 'tr_0123456789abcdef',
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get('X-Cache')).toBe('MISS');
    expect(resp.headers.get('X-Cache-Tier')).toBe('upstream');
    expect(await resp.text()).toBe('fresh');
    expect(fetcher.calls).toHaveLength(1);
  });

  it('on miss, stores to all writable tiers the policy allows', async () => {
    const edge = new FakeTier<string>('edge');
    const kv = new FakeTier<string>('kv');
    const cache = new TieredCache([edge, kv]);
    const fetcher = new FixtureFetcher(() => makeEntry({ value: 'fresh' }));
    const ctx = makeCtx();

    await serveCached({
      key: KEY, cache, fetcher, policy: IMMUTABLE_POLICY, ctx, traceId: 'tr_0123456789abcdef',
    });
    await Promise.all(ctx.awaited);

    expect(edge.store.size).toBe(1);
    expect(kv.store.size).toBe(1);
  });
});

describe('serveCached — content-type + trace-id propagation', () => {
  it('preserves entry.contentType on the response', async () => {
    const edge = new FakeTier<string>('edge');
    edge.seed(KEY, makeEntry({ contentType: 'application/xml' }));
    const cache = new TieredCache([edge]);
    const resp = await serveCached({
      key: KEY, cache, fetcher: new FixtureFetcher(() => new Error('no')), policy: IMMUTABLE_POLICY, ctx: makeCtx(), traceId: 'tr_0123456789abcdef',
    });
    expect(resp.headers.get('Content-Type')).toBe('application/xml');
  });

  it('echoes trace ID in X-Trace-Id response header', async () => {
    const edge = new FakeTier<string>('edge');
    edge.seed(KEY, makeEntry());
    const cache = new TieredCache([edge]);
    const resp = await serveCached({
      key: KEY, cache, fetcher: new FixtureFetcher(() => new Error('no')), policy: IMMUTABLE_POLICY, ctx: makeCtx(), traceId: 'tr_deadbeefcafebabe',
    });
    expect(resp.headers.get('X-Trace-Id')).toBe('tr_deadbeefcafebabe');
  });
});

describe('serveCached — upstream error path', () => {
  it('returns FR-37 envelope with code=upstream_5xx when fetcher throws', async () => {
    const cache = new TieredCache([new FakeTier<string>('edge')]);
    const fetcher = new FixtureFetcher(() => new Error('upstream 503'));
    const resp = await serveCached({
      key: KEY, cache, fetcher, policy: IMMUTABLE_POLICY, ctx: makeCtx(), traceId: 'tr_0123456789abcdef',
    });
    expect(resp.status).toBe(502);
    const body = (await resp.json()) as { error: { code: string; retryable: boolean; traceId: string } };
    expect(body.error.code).toBe('upstream_5xx');
    expect(body.error.retryable).toBe(true);
    expect(body.error.traceId).toBe('tr_0123456789abcdef');
  });

  it('includes trace ID in the error response X-Trace-Id', async () => {
    const cache = new TieredCache([new FakeTier<string>('edge')]);
    const fetcher = new FixtureFetcher(() => new Error('boom'));
    const resp = await serveCached({
      key: KEY, cache, fetcher, policy: IMMUTABLE_POLICY, ctx: makeCtx(), traceId: 'tr_deadbeefcafebabe',
    });
    expect(resp.headers.get('X-Trace-Id')).toBe('tr_deadbeefcafebabe');
  });
});
