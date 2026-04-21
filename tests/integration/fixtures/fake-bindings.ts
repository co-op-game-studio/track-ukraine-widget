/**
 * Fake Cloudflare bindings for the serveCached integration test. These
 * implement the minimal-shape interfaces (EdgeCacheLike, KvLike,
 * R2BucketLike) so the REAL tier classes can be composed against them.
 *
 * Traces: FR-44 AC-44.1 (integration fakes).
 */
import { vi } from 'vitest';
import { TieredCache } from '../../../proxy/cache/tiered-cache';
import { EdgeTier, type EdgeCacheLike } from '../../../proxy/cache/edge-tier';
import { KvTier, type KvLike } from '../../../proxy/cache/kv-tier';
import { R2Tier, type R2BucketLike, type R2ObjectLike } from '../../../proxy/cache/r2-tier';
import { createUpstreamRegistry } from '../../../proxy/upstreams/registry';
import { IMMUTABLE_ARCHIVE_POLICY } from '../../../proxy/cache/policy';
import { cacheKeyToDottedString, type CacheKey } from '../../../proxy/cache/key';
import type { UpstreamFetcher } from '../../../proxy/upstreams/fetcher';
import type { CacheEntry } from '../../../proxy/cache/tier';

export class FakeEdgeCache implements EdgeCacheLike {
  readonly store = new Map<string, Response>();
  readonly getCalls: string[] = [];
  async match(req: Request | string): Promise<Response | undefined> {
    const url = typeof req === 'string' ? req : req.url;
    this.getCalls.push(url);
    const cached = this.store.get(url);
    return cached ? cached.clone() : undefined;
  }
  async put(req: Request | string, resp: Response): Promise<void> {
    const url = typeof req === 'string' ? req : req.url;
    this.store.set(url, resp);
  }
}

export class FakeKv implements KvLike {
  readonly store = new Map<string, string>();
  readonly getCalls: string[] = [];
  async get(k: string): Promise<string | null> {
    this.getCalls.push(k);
    return this.store.get(k) ?? null;
  }
  async put(k: string, v: string): Promise<void> { this.store.set(k, v); }
}

export class FakeR2 implements R2BucketLike {
  readonly store = new Map<string, { body: string; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }>();
  readonly getCalls: string[] = [];
  async get(k: string): Promise<R2ObjectLike | null> {
    this.getCalls.push(k);
    const hit = this.store.get(k);
    if (!hit) return null;
    return {
      text: async () => hit.body,
      httpMetadata: hit.httpMetadata,
      customMetadata: hit.customMetadata,
    };
  }
  async put(k: string, value: string | ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown> {
    this.store.set(k, {
      body: typeof value === 'string' ? value : String(value),
      httpMetadata: opts?.httpMetadata,
      customMetadata: opts?.customMetadata,
    });
    return undefined;
  }
}

export function makeCtx(): { waitUntil: (p: Promise<unknown>) => void; awaited: Array<Promise<unknown>> } {
  const awaited: Array<Promise<unknown>> = [];
  return { waitUntil(p) { awaited.push(p); }, awaited };
}

export function keyToEdgeUrl(k: CacheKey): URL {
  return new URL(`https://edge.cache.test/${cacheKeyToDottedString(k)}`);
}

export interface Harness {
  edge: FakeEdgeCache;
  kv: FakeKv;
  r2: FakeR2;
  cache: TieredCache<string>;
  fetch: ReturnType<typeof vi.fn>;
  ctx: ReturnType<typeof makeCtx>;
  fetcherFor: (k: CacheKey) => UpstreamFetcher<string>;
}

export function harness(now: Date = new Date('2026-04-19T12:00:00Z')): Harness {
  const edge = new FakeEdgeCache();
  const kv = new FakeKv();
  const r2 = new FakeR2();
  const cache = new TieredCache<string>([
    new EdgeTier<string>(edge, keyToEdgeUrl),
    new KvTier<string>(kv),
    new R2Tier<string>(r2),
  ]);
  const fetch = vi.fn();
  const registry = createUpstreamRegistry({ apiKey: 'test-key', fetch: fetch as unknown as typeof globalThis.fetch, now: () => now });
  return {
    edge, kv, r2, cache,
    fetch,
    ctx: makeCtx(),
    fetcherFor: (k) => {
      const f = registry.getFor(k);
      if (!f) throw new Error(`no fetcher for ${k.kind}`);
      return f;
    },
  };
}

// Pre-seed helpers using the real tier classes.
export async function seedEdge(h: Harness, key: CacheKey, entry: CacheEntry<string>): Promise<void> {
  await new EdgeTier<string>(h.edge, keyToEdgeUrl).put(key, entry, IMMUTABLE_ARCHIVE_POLICY);
}
export async function seedKv(h: Harness, key: CacheKey, entry: CacheEntry<string>): Promise<void> {
  await new KvTier<string>(h.kv).put(key, entry, IMMUTABLE_ARCHIVE_POLICY);
}
export async function seedR2(h: Harness, key: CacheKey, entry: CacheEntry<string>): Promise<void> {
  await new R2Tier<string>(h.r2).put(key, entry, IMMUTABLE_ARCHIVE_POLICY);
}
