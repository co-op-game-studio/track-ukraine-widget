/**
 * Tests for proxy/cache/kv-tier.ts — KvTier wraps KV_VOTER_INFO.
 *
 * Traces to FR-40 AC-40.1 (KV implementation), FR-40 AC-40.5 (expirationTtl
 * honors WritePolicy.maxAge).
 */
import { describe, expect, it } from 'vitest';
import { KV_CACHE_PREFIX, KvTier } from '../../../proxy/cache/kv-tier';
import type { CacheKey } from '../../../proxy/cache/key';
import type { CacheEntry } from '../../../proxy/cache/tier';
import type { WritePolicy } from '../../../proxy/cache/policy';

class FakeKv {
  readonly store = new Map<string, { value: string; ttl?: number }>();
  readonly getCalls: string[] = [];
  readonly putCalls: Array<{ key: string; value: string; ttl?: number }> = [];
  async get(key: string): Promise<string | null> {
    this.getCalls.push(key);
    return this.store.get(key)?.value ?? null;
  }
  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.putCalls.push({ key, value, ttl: opts?.expirationTtl });
    this.store.set(key, { value, ttl: opts?.expirationTtl });
  }
}

const KEY: CacheKey = { kind: 'senate-xml', params: { congress: 117, session: 2, rollCall: 78 } };
const ENTRY: CacheEntry<string> = {
  value: 'hello',
  contentType: 'application/xml',
  fetchedAt: 1_000,
  sourceUpstream: 'senate',
  sessionStatus: 'frozen',
};
const IMMUTABLE_POLICY: WritePolicy = {
  maxAge: 31_536_000,
  immutable: true,
  eligibleTiers: ['edge', 'kv', 'r2'],
};

describe('KvTier — identity', () => {
  it('has name="kv" and canWrite=true', () => {
    const tier = new KvTier<string>(new FakeKv());
    expect(tier.name).toBe('kv');
    expect(tier.canWrite).toBe(true);
  });
});

describe('KvTier key namespacing', () => {
  it('stores under cache:v1:{kind}:{serialized} prefix', async () => {
    const kv = new FakeKv();
    const tier = new KvTier<string>(kv);
    await tier.put(KEY, ENTRY, IMMUTABLE_POLICY);
    const keys = [...kv.store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp('^' + KV_CACHE_PREFIX));
    expect(keys[0]).toContain('senate-xml');
  });

  it('KV_CACHE_PREFIX is the reserved "cache:v1:" per spec', () => {
    expect(KV_CACHE_PREFIX).toBe('cache:v1:');
  });
});

describe('KvTier.put → get roundtrip', () => {
  it('stores + returns the entry', async () => {
    const kv = new FakeKv();
    const tier = new KvTier<string>(kv);
    await tier.put(KEY, ENTRY, IMMUTABLE_POLICY);
    const hit = await tier.get(KEY);
    expect(hit).not.toBeNull();
    expect(hit?.value).toBe('hello');
    expect(hit?.contentType).toBe('application/xml');
    expect(hit?.sessionStatus).toBe('frozen');
    expect(hit?.sourceUpstream).toBe('senate');
    expect(hit?.fetchedAt).toBe(1000);
  });

  it('returns null on miss', async () => {
    const tier = new KvTier<string>(new FakeKv());
    expect(await tier.get(KEY)).toBeNull();
  });
});

describe('KvTier.put — TTL translation', () => {
  it('sets expirationTtl from policy.maxAge when maxAge ≥ 60', async () => {
    const kv = new FakeKv();
    const tier = new KvTier<string>(kv);
    await tier.put(KEY, ENTRY, IMMUTABLE_POLICY);
    expect(kv.putCalls[0]?.ttl).toBe(31_536_000);
  });

  it('clamps TTL to KV minimum (60s) when policy.maxAge is smaller', async () => {
    // KV_NAMESPACE.put requires expirationTtl ≥ 60.
    const kv = new FakeKv();
    const tier = new KvTier<string>(kv);
    await tier.put(KEY, ENTRY, {
      maxAge: 10,
      immutable: false,
      eligibleTiers: ['kv'],
    });
    expect(kv.putCalls[0]?.ttl).toBe(60);
  });
});

describe('KvTier.get — malformed-envelope resilience', () => {
  it('returns null when stored JSON is truncated / unparseable', async () => {
    const kv = new FakeKv();
    const tier = new KvTier<string>(kv);
    // Corrupt the stored envelope.
    const serialized = 'cache:v1:senate-xml:congress=117:rollCall=78:session=2';
    kv.store.set(serialized, { value: '{ not-valid-json' });
    // Calling get with the matching key should gracefully miss.
    const hit = await tier.get(KEY);
    expect(hit).toBeNull();
  });

  it('returns null when stored envelope lacks required fields', async () => {
    const kv = new FakeKv();
    const tier = new KvTier<string>(kv);
    const serialized = 'cache:v1:senate-xml:congress=117:rollCall=78:session=2';
    kv.store.set(serialized, { value: JSON.stringify({ partial: true }) });
    expect(await tier.get(KEY)).toBeNull();
  });
});

describe('KvTier — two different keys do not collide', () => {
  it('isolates storage per cache-key identity', async () => {
    const kv = new FakeKv();
    const tier = new KvTier<string>(kv);
    const k1: CacheKey = { kind: 'senate-xml', params: { congress: 117, session: 2, rollCall: 78 } };
    const k2: CacheKey = { kind: 'senate-xml', params: { congress: 117, session: 2, rollCall: 79 } };
    await tier.put(k1, { ...ENTRY, value: 'one' }, IMMUTABLE_POLICY);
    await tier.put(k2, { ...ENTRY, value: 'two' }, IMMUTABLE_POLICY);
    expect((await tier.get(k1))?.value).toBe('one');
    expect((await tier.get(k2))?.value).toBe('two');
  });
});
