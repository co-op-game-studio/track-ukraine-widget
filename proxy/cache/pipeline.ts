/**
 * serveCached — the request-pipeline function for every cacheable route.
 *
 * Flow:
 *   1. cache.get(key) — tries tier 0, 1, 2 in order.
 *   2. On hit: promote to faster tiers (waitUntil) + return with
 *      X-Cache: HIT / X-Cache-Tier: <tier>.
 *   3. On miss: fetcher.fetch(key) → upstream bytes + metadata.
 *      Write to every writable eligible tier (waitUntil). Return with
 *      X-Cache: MISS / X-Cache-Tier: upstream.
 *   4. On fetcher throw: return FR-37 envelope with code=upstream_5xx +
 *      retryable=true + trace ID.
 *
 * This is the ONLY function in the proxy that mediates upstream calls for
 * cached routes. Every route handler under proxy/routes/ calls through
 * this rather than issuing its own `fetch`.
 *
 * Traces: FR-40 AC-40.6, AC-40.9, FR-41 AC-41.9, FR-37 (error envelope).
 */

import type { CacheKey } from './key';
import type { WritePolicy } from './policy';
import type { TieredCache, WaitUntilLike } from './tiered-cache';
import type { UpstreamFetcher } from '../upstreams/fetcher';
import { asErrorResponse } from '../observability/error-envelope';

export interface ServeCachedInput<V extends string> {
  readonly key: CacheKey;
  readonly cache: TieredCache<V>;
  readonly fetcher: UpstreamFetcher<V>;
  readonly policy: WritePolicy;
  readonly ctx: WaitUntilLike;
  readonly traceId: string;
  /** Merged onto the response headers (CORS reflection, etc.). */
  readonly extraHeaders?: HeadersInit;
  /** FR-37 upstream attribution on error responses. */
  readonly upstreamAttribution?: 'congress' | 'senate' | 'census' | null;
}

/**
 * Resolve a cacheable request through the tiered cache + fetcher.
 * Always returns a Response — success or canonical error envelope.
 */
export async function serveCached<V extends string>(
  input: ServeCachedInput<V>,
): Promise<Response> {
  const { key, cache, fetcher, policy, ctx, traceId, extraHeaders } = input;

  const hit = await cache.get(key);
  if (hit) {
    cache.promote(key, hit.entry, hit.servedBy, ctx, policy);
    return responseFromEntry(hit.entry, {
      cacheStatus: 'HIT',
      cacheTier: hit.servedBy,
      traceId,
      extraHeaders,
    });
  }

  let entry;
  try {
    entry = await fetcher.fetch(key, { traceId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return asErrorResponse({
      code: 'upstream_5xx',
      message,
      userMessage: 'Something went wrong loading that data. Try again in a moment.',
      upstream: input.upstreamAttribution ?? null,
      traceId,
      extraHeaders,
    });
  }

  cache.storeFromUpstream(key, entry, ctx, policy);
  return responseFromEntry(entry, {
    cacheStatus: 'MISS',
    cacheTier: 'upstream',
    traceId,
    extraHeaders,
  });
}

function responseFromEntry<V extends string>(
  entry: { value: V; contentType: string },
  opts: {
    cacheStatus: 'HIT' | 'MISS';
    cacheTier: 'edge' | 'kv' | 'r2' | 'upstream';
    traceId: string;
    extraHeaders?: HeadersInit;
  },
): Response {
  const headers = new Headers(opts.extraHeaders);
  headers.set('Content-Type', entry.contentType);
  headers.set('X-Cache', opts.cacheStatus);
  headers.set('X-Cache-Tier', opts.cacheTier);
  headers.set('X-Trace-Id', opts.traceId);
  return new Response(entry.value, { status: 200, headers });
}
