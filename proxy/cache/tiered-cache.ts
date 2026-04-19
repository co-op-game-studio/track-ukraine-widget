/**
 * TieredCache<V> — composition of ordered CacheTier<V>s.
 *
 * Three tiers, fastest to slowest:
 *   0. EdgeTier  — caches.default, per-POP, ~5ms
 *   1. KvTier    — KV_VOTER_INFO,  global, ~30ms
 *   2. R2Tier    — R2_STATIC,      global durable, ~50ms (gated)
 *
 * Semantics per FR-40 AC-40.5:
 *   - `get`  reads tier-by-tier, returns first hit.
 *   - `promote` writes a hit from tier N back to tiers 0..N-1 via waitUntil.
 *   - `storeFromUpstream` writes a fresh response to every writable tier
 *     whose `policy.eligibleTiers` includes the tier name, via waitUntil.
 *
 * Each individual tier may reject a write via its own `put` implementation
 * (e.g. R2Tier enforces `policy.immutable && sessionStatus==='frozen'`).
 * That's intentional defense-in-depth: the policy layer says "offer the
 * write," the tier decides "accept it."
 *
 * Tiers are otherwise unaware of each other. All cross-tier behavior lives
 * here.
 *
 * Traces: FR-40 AC-40.5, AC-40.10.
 */

import type { CacheKey } from './key';
import type { CacheEntry, CacheTier } from './tier';
import type { WritePolicy, TierName } from './policy';

export interface WaitUntilLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface TieredCacheHit<V> {
  readonly entry: CacheEntry<V>;
  readonly servedBy: TierName;
}

export class TieredCache<V> {
  constructor(private readonly tiers: readonly CacheTier<V>[]) {}

  /** Top-down read; returns the first hit and the tier that served it. */
  async get(key: CacheKey): Promise<TieredCacheHit<V> | null> {
    for (const tier of this.tiers) {
      const entry = await tier.get(key);
      if (entry) {
        return { entry, servedBy: tier.name };
      }
    }
    return null;
  }

  /**
   * Write-back: when tier N served a hit, copy the entry to tiers 0..N-1.
   * Writes are dispatched via ctx.waitUntil and NEVER block the caller.
   * Read-only tiers are skipped.
   */
  promote(
    key: CacheKey,
    entry: CacheEntry<V>,
    servedBy: TierName,
    ctx: WaitUntilLike,
    policy: WritePolicy,
  ): void {
    const idx = this.tiers.findIndex((t) => t.name === servedBy);
    if (idx <= 0) return;
    const fasterWritable = this.tiers
      .slice(0, idx)
      .filter((t) => t.canWrite && policy.eligibleTiers.includes(t.name));
    if (fasterWritable.length === 0) return;
    ctx.waitUntil(
      Promise.all(fasterWritable.map((t) => t.put(key, entry, policy).catch(() => undefined))),
    );
  }

  /**
   * Write-through: a freshly-fetched upstream response is offered to every
   * writable tier whose name appears in `policy.eligibleTiers`. Each tier's
   * own `put` is the final authority on acceptance.
   */
  storeFromUpstream(
    key: CacheKey,
    entry: CacheEntry<V>,
    ctx: WaitUntilLike,
    policy: WritePolicy,
  ): void {
    const writable = this.tiers.filter(
      (t) => t.canWrite && policy.eligibleTiers.includes(t.name),
    );
    if (writable.length === 0) return;
    ctx.waitUntil(
      Promise.all(writable.map((t) => t.put(key, entry, policy).catch(() => undefined))),
    );
  }
}
