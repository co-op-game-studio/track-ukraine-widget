/**
 * Tests for proxy/cache/tiered-cache.ts — composition class.
 *
 * Traces to FR-40 AC-40.5, AC-40.10 (spec.md v2.6.0).
 */
import { describe, expect, it } from 'vitest';
import { TieredCache } from '../../../proxy/cache/tiered-cache';
import type { CacheKey } from '../../../proxy/cache/key';
import type { CacheEntry } from '../../../proxy/cache/tier';
import type { WritePolicy } from '../../../proxy/cache/policy';
import { FakeTier, makeCtx } from '../../fakes/fake-tier';

const KEY: CacheKey = { kind: 'senate-xml', params: { congress: 117, session: 2, rollCall: 78 } };

function makeEntry(overrides: Partial<CacheEntry<string>> = {}): CacheEntry<string> {
  return {
    value: 'hello',
    contentType: 'text/plain',
    fetchedAt: 1_000,
    sourceUpstream: 'synthetic',
    sessionStatus: 'frozen',
    ...overrides,
  };
}

const POLICY: WritePolicy = {
  maxAge: 31_536_000,
  immutable: true,
  eligibleTiers: ['edge', 'kv', 'r2'],
};

describe('TieredCache.get — AC-40.5: top-down read', () => {
  it('returns tier-0 hit first, without consulting tier-1 or tier-2', async () => {
    const edge = new FakeTier<string>('edge');
    const kv = new FakeTier<string>('kv');
    const r2 = new FakeTier<string>('r2');
    edge.seed(KEY, makeEntry({ value: 'EDGE' }));
    kv.seed(KEY, makeEntry({ value: 'KV' }));
    r2.seed(KEY, makeEntry({ value: 'R2' }));

    const cache = new TieredCache([edge, kv, r2]);
    const hit = await cache.get(KEY);

    expect(hit?.servedBy).toBe('edge');
    expect(hit?.entry.value).toBe('EDGE');
    expect(kv.getCalls).toHaveLength(0);
    expect(r2.getCalls).toHaveLength(0);
  });

  it('falls through to tier 1 on edge miss, stops there on kv hit', async () => {
    const edge = new FakeTier<string>('edge');
    const kv = new FakeTier<string>('kv');
    const r2 = new FakeTier<string>('r2');
    kv.seed(KEY, makeEntry({ value: 'KV' }));

    const cache = new TieredCache([edge, kv, r2]);
    const hit = await cache.get(KEY);

    expect(hit?.servedBy).toBe('kv');
    expect(hit?.entry.value).toBe('KV');
    expect(edge.getCalls).toHaveLength(1);
    expect(kv.getCalls).toHaveLength(1);
    expect(r2.getCalls).toHaveLength(0);
  });

  it('falls through to R2 on edge+kv miss', async () => {
    const edge = new FakeTier<string>('edge');
    const kv = new FakeTier<string>('kv');
    const r2 = new FakeTier<string>('r2');
    r2.seed(KEY, makeEntry({ value: 'R2' }));

    const cache = new TieredCache([edge, kv, r2]);
    const hit = await cache.get(KEY);

    expect(hit?.servedBy).toBe('r2');
    expect(hit?.entry.value).toBe('R2');
    expect(edge.getCalls).toHaveLength(1);
    expect(kv.getCalls).toHaveLength(1);
    expect(r2.getCalls).toHaveLength(1);
  });

  it('returns null when every tier misses', async () => {
    const cache = new TieredCache([
      new FakeTier<string>('edge'),
      new FakeTier<string>('kv'),
      new FakeTier<string>('r2'),
    ]);
    const hit = await cache.get(KEY);
    expect(hit).toBeNull();
  });
});

describe('TieredCache.promote — AC-40.5: write-back to faster tiers', () => {
  it('writes to edge + kv when r2 served', async () => {
    const edge = new FakeTier<string>('edge');
    const kv = new FakeTier<string>('kv');
    const r2 = new FakeTier<string>('r2');
    r2.seed(KEY, makeEntry({ value: 'R2' }));

    const cache = new TieredCache([edge, kv, r2]);
    const ctx = makeCtx();
    const hit = await cache.get(KEY);
    cache.promote(KEY, hit!.entry, hit!.servedBy, ctx, POLICY);

    // Drain the background writes.
    await Promise.all(ctx.awaited);

    expect(edge.store.size).toBe(1);
    expect(kv.store.size).toBe(1);
    // R2 was the source; it should not re-write itself.
    expect(r2.putCalls).toHaveLength(0);
  });

  it('writes to edge only when kv served', async () => {
    const edge = new FakeTier<string>('edge');
    const kv = new FakeTier<string>('kv');
    const r2 = new FakeTier<string>('r2');
    kv.seed(KEY, makeEntry({ value: 'KV' }));

    const cache = new TieredCache([edge, kv, r2]);
    const ctx = makeCtx();
    const hit = await cache.get(KEY);
    cache.promote(KEY, hit!.entry, hit!.servedBy, ctx, POLICY);
    await Promise.all(ctx.awaited);

    expect(edge.store.size).toBe(1);
    expect(kv.putCalls).toHaveLength(0);
    expect(r2.putCalls).toHaveLength(0);
  });

  it('writes to no tiers when edge served', async () => {
    const edge = new FakeTier<string>('edge');
    const kv = new FakeTier<string>('kv');
    const r2 = new FakeTier<string>('r2');
    edge.seed(KEY, makeEntry({ value: 'EDGE' }));

    const cache = new TieredCache([edge, kv, r2]);
    const ctx = makeCtx();
    const hit = await cache.get(KEY);
    cache.promote(KEY, hit!.entry, hit!.servedBy, ctx, POLICY);
    await Promise.all(ctx.awaited);

    expect(edge.putCalls).toHaveLength(0);
    expect(kv.putCalls).toHaveLength(0);
    expect(r2.putCalls).toHaveLength(0);
  });

  it('skips read-only tiers during promotion', async () => {
    const edge = new FakeTier<string>('edge', /* canWrite = */ false);
    const kv = new FakeTier<string>('kv');
    const r2 = new FakeTier<string>('r2');
    r2.seed(KEY, makeEntry({ value: 'R2' }));

    const cache = new TieredCache([edge, kv, r2]);
    const ctx = makeCtx();
    const hit = await cache.get(KEY);
    cache.promote(KEY, hit!.entry, hit!.servedBy, ctx, POLICY);
    await Promise.all(ctx.awaited);

    expect(edge.putCalls).toHaveLength(0);
    expect(kv.store.size).toBe(1);
  });
});

describe('TieredCache.storeFromUpstream — AC-40.5: write-through on miss', () => {
  it('writes to every writable tier whose policy allows', async () => {
    const edge = new FakeTier<string>('edge');
    const kv = new FakeTier<string>('kv');
    const r2 = new FakeTier<string>('r2');
    const cache = new TieredCache([edge, kv, r2]);
    const ctx = makeCtx();
    cache.storeFromUpstream(KEY, makeEntry(), ctx, POLICY);
    await Promise.all(ctx.awaited);

    expect(edge.store.size).toBe(1);
    expect(kv.store.size).toBe(1);
    expect(r2.store.size).toBe(1);
  });

  it('filters tiers by policy.eligibleTiers', async () => {
    const edge = new FakeTier<string>('edge');
    const kv = new FakeTier<string>('kv');
    const r2 = new FakeTier<string>('r2');
    const cache = new TieredCache([edge, kv, r2]);
    const ctx = makeCtx();
    cache.storeFromUpstream(KEY, makeEntry(), ctx, {
      maxAge: 3600,
      immutable: false,
      eligibleTiers: ['edge', 'kv'], // R2 excluded
    });
    await Promise.all(ctx.awaited);

    expect(edge.store.size).toBe(1);
    expect(kv.store.size).toBe(1);
    expect(r2.putCalls).toHaveLength(0);
  });

  it('honors each tier\'s own put-gate (e.g. R2 session-status)', async () => {
    const edge = new FakeTier<string>('edge');
    const kv = new FakeTier<string>('kv');
    const r2 = new FakeTier<string>('r2');
    r2.putGate = (_k, entry, policy) => policy.immutable && entry.sessionStatus === 'frozen';
    const cache = new TieredCache([edge, kv, r2]);
    const ctx = makeCtx();
    cache.storeFromUpstream(
      KEY,
      makeEntry({ sessionStatus: 'live' }),
      ctx,
      POLICY,
    );
    await Promise.all(ctx.awaited);

    expect(edge.store.size).toBe(1);
    expect(kv.store.size).toBe(1);
    // r2.put was CALLED, but the gate rejected storage.
    expect(r2.putCalls).toHaveLength(1);
    expect(r2.store.size).toBe(0);
  });

  it('skips read-only tiers during store-through', async () => {
    const edge = new FakeTier<string>('edge', false);
    const kv = new FakeTier<string>('kv');
    const cache = new TieredCache([edge, kv]);
    const ctx = makeCtx();
    cache.storeFromUpstream(KEY, makeEntry(), ctx, POLICY);
    await Promise.all(ctx.awaited);

    expect(edge.putCalls).toHaveLength(0);
    expect(kv.store.size).toBe(1);
  });

  it('uses ctx.waitUntil so the call does not block', () => {
    const edge = new FakeTier<string>('edge');
    const cache = new TieredCache([edge]);
    const ctx = makeCtx();
    cache.storeFromUpstream(KEY, makeEntry(), ctx, POLICY);
    expect(ctx.awaited).toHaveLength(1);
  });
});

describe('TieredCache.promote — idempotency', () => {
  it('re-running the same promote is safe', async () => {
    const edge = new FakeTier<string>('edge');
    const kv = new FakeTier<string>('kv');
    kv.seed(KEY, makeEntry({ value: 'KV' }));

    const cache = new TieredCache([edge, kv]);
    const ctx1 = makeCtx();
    const ctx2 = makeCtx();
    const hit = await cache.get(KEY);
    cache.promote(KEY, hit!.entry, hit!.servedBy, ctx1, POLICY);
    cache.promote(KEY, hit!.entry, hit!.servedBy, ctx2, POLICY);
    await Promise.all([...ctx1.awaited, ...ctx2.awaited]);

    expect(edge.store.size).toBe(1);
  });
});
