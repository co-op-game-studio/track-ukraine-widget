/**
 * UpstreamFetcher<V> — contract for the tier-3 (live upstream) fallback.
 *
 * The TieredCache never calls upstream directly — it calls `serveCached`,
 * which resolves a miss by invoking a registered UpstreamFetcher that
 * `canHandle` the key. Each upstream (senate.gov, congress.gov, census)
 * has its own implementation under proxy/upstreams/.
 *
 * Fetchers are responsible for:
 *   - Composing the upstream URL from the CacheKey.
 *   - Issuing the fetch with appropriate headers (Accept + X-Trace-Id).
 *   - Wrapping the response bytes + metadata into a CacheEntry<V>.
 *   - Computing sessionStatus for R2-eligible responses.
 *   - Throwing on any upstream failure (non-2xx, timeout, parse error).
 *     The pipeline translates thrown errors into FR-37 envelopes.
 *
 * Traces: FR-40 AC-40.7.
 */

import type { CacheKey } from '../cache/key';
import type { CacheEntry } from '../cache/tier';

export interface UpstreamFetchContext {
  readonly traceId: string;
}

export interface UpstreamFetcher<V> {
  canHandle(key: CacheKey): boolean;
  fetch(key: CacheKey, ctx: UpstreamFetchContext): Promise<CacheEntry<V>>;
}
