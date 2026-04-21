/**
 * KvTier — wraps `KV_VOTER_INFO` as a tier-1 cache (global, ~30ms hit).
 *
 * Each cached response is serialized as a JSON envelope under the
 * `cache:v1:` prefix:
 *
 *   cache:v1:{cacheKeyToDottedString(key)}  →  CacheEntryEnvelope
 *
 * `cache:v1:` is the reserved prefix from ADR-009 / FR-32 v2.6.0. Other KV
 * prefixes (member:v1:, bill:v1:, etc.) remain owned by the curator-style
 * domain records — those are NOT cache entries and do not flow through
 * KvTier.
 *
 * Traces: FR-40 AC-40.1 (KV implementation).
 */

import { cacheKeyToDottedString, type CacheKey } from './key';
import type { CacheEntry, CacheTier } from './tier';
import type { WritePolicy } from './policy';

export const KV_CACHE_PREFIX = 'cache:v1:';

/** Minimal shape of a KV namespace (narrower than @cloudflare/workers-types). */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

/**
 * JSON-serializable wire form of a CacheEntry. Keeps the value as a string
 * (KvTier<V> is parameterized, but KV storage is always text) and carries
 * metadata fields alongside.
 */
interface Envelope {
  v: string;           // value (already-serialized)
  ct: string;          // contentType
  fa: number;          // fetchedAt
  src: CacheEntry<unknown>['sourceUpstream'];
  ss?: 'frozen' | 'live';
}

/** KV minimum expirationTtl. Anything below 60 is rejected by the binding. */
const KV_MIN_TTL = 60;

export class KvTier<V extends string | ArrayBuffer | Uint8Array>
  implements CacheTier<V> {
  public readonly name = 'kv' as const;
  public readonly canWrite = true;

  constructor(private readonly kv: KvLike) {}

  private storageKey(key: CacheKey): string {
    return KV_CACHE_PREFIX + cacheKeyToDottedString(key);
  }

  async get(key: CacheKey): Promise<CacheEntry<V> | null> {
    const raw = await this.kv.get(this.storageKey(key));
    if (!raw) return null;
    let env: unknown;
    try {
      env = JSON.parse(raw);
    } catch {
      return null; // poisoned entry — graceful miss
    }
    if (!env || typeof env !== 'object') return null;
    const e = env as Partial<Envelope>;
    if (
      typeof e.v !== 'string' ||
      typeof e.ct !== 'string' ||
      typeof e.fa !== 'number' ||
      typeof e.src !== 'string'
    ) {
      return null;
    }
    const entry: CacheEntry<V> = {
      value: e.v as unknown as V,
      contentType: e.ct,
      fetchedAt: e.fa,
      sourceUpstream: e.src,
      ...(e.ss ? { sessionStatus: e.ss } : {}),
    };
    return entry;
  }

  async put(key: CacheKey, entry: CacheEntry<V>, policy: WritePolicy): Promise<void> {
    const envelope: Envelope = {
      v: typeof entry.value === 'string' ? entry.value : String(entry.value),
      ct: entry.contentType,
      fa: entry.fetchedAt,
      src: entry.sourceUpstream,
      ...(entry.sessionStatus ? { ss: entry.sessionStatus } : {}),
    };
    const ttl = Math.max(KV_MIN_TTL, policy.maxAge);
    await this.kv.put(this.storageKey(key), JSON.stringify(envelope), { expirationTtl: ttl });
  }
}
