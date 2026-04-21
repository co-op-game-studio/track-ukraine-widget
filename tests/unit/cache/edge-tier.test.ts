/**
 * Tests for proxy/cache/edge-tier.ts — EdgeTier wraps caches.default.
 *
 * Traces to FR-40 AC-40.1 (edge implementation), AC-40.9 (header emission).
 */
import { describe, expect, it } from 'vitest';
import { EdgeTier } from '../../../proxy/cache/edge-tier';
import type { CacheKey } from '../../../proxy/cache/key';
import type { CacheEntry } from '../../../proxy/cache/tier';
import type { WritePolicy } from '../../../proxy/cache/policy';

class FakeEdgeCache {
  readonly store = new Map<string, Response>();
  async match(req: Request | string): Promise<Response | undefined> {
    const url = typeof req === 'string' ? req : req.url;
    const cached = this.store.get(url);
    // caches.default clones on every read; emulate.
    return cached ? cached.clone() : undefined;
  }
  async put(req: Request | string, resp: Response): Promise<void> {
    const url = typeof req === 'string' ? req : req.url;
    this.store.set(url, resp);
  }
}

const KEY: CacheKey = { kind: 'senate-xml', params: { congress: 117, session: 2, rollCall: 78 } };
const URL_FOR_KEY = 'https://upstream.test/senate/117/2/78';
const keyToUrl = (k: CacheKey) => new URL(URL_FOR_KEY + `?k=${k.params.rollCall}`);

const ENTRY: CacheEntry<string> = {
  value: '<?xml version="1.0"?><root />',
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

describe('EdgeTier — identity + canWrite', () => {
  it('has name="edge" and canWrite=true', () => {
    const cache = new FakeEdgeCache();
    const tier = new EdgeTier<string>(cache, keyToUrl);
    expect(tier.name).toBe('edge');
    expect(tier.canWrite).toBe(true);
  });
});

describe('EdgeTier.put → get roundtrip', () => {
  it('stores an entry and returns it on subsequent get', async () => {
    const cache = new FakeEdgeCache();
    const tier = new EdgeTier<string>(cache, keyToUrl);
    await tier.put(KEY, ENTRY, IMMUTABLE_POLICY);
    const hit = await tier.get(KEY);
    expect(hit?.value).toBe(ENTRY.value);
    expect(hit?.contentType).toBe('application/xml');
    expect(hit?.sessionStatus).toBe('frozen');
  });

  it('returns null on miss', async () => {
    const cache = new FakeEdgeCache();
    const tier = new EdgeTier<string>(cache, keyToUrl);
    const miss = await tier.get(KEY);
    expect(miss).toBeNull();
  });

  it('different keys do not collide', async () => {
    const cache = new FakeEdgeCache();
    const tier = new EdgeTier<string>(cache, keyToUrl);
    const k1: CacheKey = { kind: 'senate-xml', params: { congress: 117, session: 2, rollCall: 78 } };
    const k2: CacheKey = { kind: 'senate-xml', params: { congress: 117, session: 2, rollCall: 79 } };
    await tier.put(k1, { ...ENTRY, value: 'one' }, IMMUTABLE_POLICY);
    await tier.put(k2, { ...ENTRY, value: 'two' }, IMMUTABLE_POLICY);
    expect((await tier.get(k1))?.value).toBe('one');
    expect((await tier.get(k2))?.value).toBe('two');
  });
});

describe('EdgeTier.put — AC-40.9 cache-control header translation', () => {
  it('sets Cache-Control with immutable + max-age from policy', async () => {
    const cache = new FakeEdgeCache();
    const tier = new EdgeTier<string>(cache, keyToUrl);
    await tier.put(KEY, ENTRY, IMMUTABLE_POLICY);
    const stored = cache.store.get(keyToUrl(KEY).toString())!;
    const cc = stored.headers.get('Cache-Control');
    expect(cc).toContain('max-age=31536000');
    expect(cc).toContain('immutable');
    expect(cc).toContain('public');
  });

  it('omits immutable when policy.immutable=false', async () => {
    const cache = new FakeEdgeCache();
    const tier = new EdgeTier<string>(cache, keyToUrl);
    await tier.put(KEY, ENTRY, {
      maxAge: 3600,
      immutable: false,
      eligibleTiers: ['edge', 'kv'],
    });
    const stored = cache.store.get(keyToUrl(KEY).toString())!;
    const cc = stored.headers.get('Cache-Control');
    expect(cc).toContain('max-age=3600');
    expect(cc).not.toContain('immutable');
  });
});

describe('EdgeTier.put — content-type propagation', () => {
  it('sets stored Content-Type from the entry', async () => {
    const cache = new FakeEdgeCache();
    const tier = new EdgeTier<string>(cache, keyToUrl);
    await tier.put(KEY, { ...ENTRY, contentType: 'application/json' }, IMMUTABLE_POLICY);
    const stored = cache.store.get(keyToUrl(KEY).toString())!;
    expect(stored.headers.get('Content-Type')).toBe('application/json');
  });
});

describe('EdgeTier.get — metadata recovery', () => {
  it('recovers fetchedAt + sessionStatus + sourceUpstream from stored headers', async () => {
    const cache = new FakeEdgeCache();
    const tier = new EdgeTier<string>(cache, keyToUrl);
    await tier.put(KEY, ENTRY, IMMUTABLE_POLICY);
    const hit = await tier.get(KEY);
    expect(hit?.fetchedAt).toBe(1000);
    expect(hit?.sourceUpstream).toBe('senate');
    expect(hit?.sessionStatus).toBe('frozen');
  });

  it('tolerates stored entries without sessionStatus (returns undefined)', async () => {
    const cache = new FakeEdgeCache();
    const tier = new EdgeTier<string>(cache, keyToUrl);
    const entryNoStatus: CacheEntry<string> = {
      value: 'x',
      contentType: 'text/plain',
      fetchedAt: 2000,
      sourceUpstream: 'synthetic',
    };
    await tier.put(KEY, entryNoStatus, {
      maxAge: 60, immutable: false, eligibleTiers: ['edge'],
    });
    const hit = await tier.get(KEY);
    expect(hit?.sessionStatus).toBeUndefined();
  });
});
