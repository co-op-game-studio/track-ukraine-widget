/**
 * EdgeTier — wraps `caches.default` as a tier-0 cache (per-POP, ~5ms hit).
 *
 * The key-to-URL mapping is injected: each route's CacheKey serializes to a
 * canonical synthetic URL (not the real upstream URL — we don't want
 * cache-poisoning cross-talk with edge responses for real upstream hosts).
 *
 * Stored Response body carries the raw `value`. Metadata travels on custom
 * headers (`X-Cache-FetchedAt`, `X-Cache-Source`, `X-Cache-Session-Status`)
 * so `get()` can reconstruct the full `CacheEntry` without a sidecar store.
 *
 * Traces: FR-40 AC-40.1 (edge tier), AC-40.9 (header emission).
 */

import type { CacheEntry, CacheTier } from './tier';
import type { CacheKey } from './key';
import type { WritePolicy } from './policy';

/** Minimal shape of `caches.default` (re-declared here so tests don't pull
 *  in @cloudflare/workers-types). */
export interface EdgeCacheLike {
  match(req: Request | string): Promise<Response | undefined>;
  put(req: Request | string, resp: Response): Promise<void>;
}

const H_FETCHED_AT = 'X-Cache-FetchedAt';
const H_SOURCE = 'X-Cache-Source';
const H_SESSION = 'X-Cache-Session-Status';

export class EdgeTier<V extends string | ArrayBuffer | Uint8Array>
  implements CacheTier<V> {
  public readonly name = 'edge' as const;
  public readonly canWrite = true;

  constructor(
    private readonly cache: EdgeCacheLike,
    private readonly keyToUrl: (key: CacheKey) => URL,
  ) {}

  async get(key: CacheKey): Promise<CacheEntry<V> | null> {
    const url = this.keyToUrl(key).toString();
    const resp = await this.cache.match(url);
    if (!resp) return null;
    const contentType = resp.headers.get('Content-Type') ?? 'application/octet-stream';
    const fetchedAtStr = resp.headers.get(H_FETCHED_AT);
    const sourceStr = resp.headers.get(H_SOURCE);
    const sessionStr = resp.headers.get(H_SESSION);
    const body = (await resp.text()) as unknown as V;
    const entry: CacheEntry<V> = {
      value: body,
      contentType,
      fetchedAt: fetchedAtStr ? Number(fetchedAtStr) : 0,
      sourceUpstream: (sourceStr as CacheEntry<V>['sourceUpstream']) ?? 'synthetic',
      ...(sessionStr ? { sessionStatus: sessionStr as 'frozen' | 'live' } : {}),
    };
    return entry;
  }

  async put(key: CacheKey, entry: CacheEntry<V>, policy: WritePolicy): Promise<void> {
    const url = this.keyToUrl(key).toString();
    const cc = [
      'public',
      `max-age=${policy.maxAge}`,
      `s-maxage=${policy.maxAge}`,
      policy.immutable ? 'immutable' : '',
    ].filter(Boolean).join(', ');
    const headers = new Headers({
      'Content-Type': entry.contentType,
      'Cache-Control': cc,
      [H_FETCHED_AT]: String(entry.fetchedAt),
      [H_SOURCE]: entry.sourceUpstream,
    });
    if (entry.sessionStatus) headers.set(H_SESSION, entry.sessionStatus);
    const body = typeof entry.value === 'string' ? entry.value : (entry.value as unknown as BodyInit);
    const resp = new Response(body as BodyInit, { headers });
    await this.cache.put(url, resp);
  }
}
