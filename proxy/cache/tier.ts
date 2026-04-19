/**
 * CacheTier<V> — uniform interface implemented by every cache tier.
 *
 * Three concrete implementations live under proxy/cache/:
 *   - EdgeTier (caches.default, per-POP)
 *   - KvTier   (KV_VOTER_INFO, global)
 *   - R2Tier   (R2_STATIC, global durable, gated by session-status + immutability)
 *
 * A `TieredCache<V>` composes an ordered array of tiers and provides the
 * top-down read, promote-on-hit, store-on-miss semantics per FR-40 AC-40.5.
 *
 * Tiers NEVER reach into each other's internals. All cross-tier behavior
 * lives in `TieredCache` / `serveCached`.
 *
 * Traces: FR-40 AC-40.1, AC-40.3.
 */

import type { CacheKey } from './key';
import type { WritePolicy, TierName } from './policy';

/**
 * CacheEntry<V> — the unit stored in a cache tier. Carries enough metadata
 * that any tier can recover the original content-type and the policy gate
 * inputs (sourceUpstream, sessionStatus).
 */
export interface CacheEntry<V> {
  readonly value: V;
  readonly contentType: string;
  readonly fetchedAt: number;                                        // ms epoch
  readonly sourceUpstream: 'senate' | 'congress' | 'census' | 'synthetic';
  readonly sessionStatus?: 'frozen' | 'live';
}

export interface CacheTier<V> {
  readonly name: TierName;
  readonly canWrite: boolean;
  get(key: CacheKey): Promise<CacheEntry<V> | null>;
  put(key: CacheKey, entry: CacheEntry<V>, policy: WritePolicy): Promise<void>;
}
