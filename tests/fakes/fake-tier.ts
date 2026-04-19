/**
 * In-memory fake for `CacheTier<V>` — used by TieredCache + pipeline tests.
 *
 * - FakeTier records every get/put for assertion.
 * - `canWrite` is configurable so a tier can be marked read-only.
 * - The internal map is exposed for seeding + inspection.
 *
 * Traces: FR-40 AC-40.10.
 */

import { cacheKeyToDottedString, type CacheKey } from '../../proxy/cache/key';
import type { CacheEntry, CacheTier } from '../../proxy/cache/tier';
import type { WritePolicy, TierName } from '../../proxy/cache/policy';

export class FakeTier<V> implements CacheTier<V> {
  public readonly name: TierName;
  public readonly canWrite: boolean;
  public readonly store = new Map<string, CacheEntry<V>>();
  public readonly getCalls: string[] = [];
  public readonly putCalls: Array<{ key: string; entry: CacheEntry<V>; policy: WritePolicy }> = [];
  /** If set, put() silently drops entries whose key matches this predicate.
   *  Use this to model R2Tier's policy/session-status gate. */
  public putGate: ((key: CacheKey, entry: CacheEntry<V>, policy: WritePolicy) => boolean) | null = null;

  constructor(name: TierName, canWrite = true) {
    this.name = name;
    this.canWrite = canWrite;
  }

  async get(key: CacheKey): Promise<CacheEntry<V> | null> {
    const k = cacheKeyToDottedString(key);
    this.getCalls.push(k);
    return this.store.get(k) ?? null;
  }

  async put(key: CacheKey, entry: CacheEntry<V>, policy: WritePolicy): Promise<void> {
    const k = cacheKeyToDottedString(key);
    this.putCalls.push({ key: k, entry, policy });
    if (this.putGate && !this.putGate(key, entry, policy)) return;
    this.store.set(k, entry);
  }

  seed(key: CacheKey, entry: CacheEntry<V>): void {
    this.store.set(cacheKeyToDottedString(key), entry);
  }
}

export function makeCtx(): { waitUntil: (p: Promise<unknown>) => void; awaited: Array<Promise<unknown>> } {
  const awaited: Array<Promise<unknown>> = [];
  return {
    waitUntil(p) { awaited.push(p); },
    awaited,
  };
}
