/**
 * R2Tier — wraps `R2_STATIC` bucket as a tier-2 cache (durable, gated).
 *
 * ONLY accepts byte-level-static upstream responses (closed-session roll-
 * calls, aged bill actions/summaries). Other kinds throw from
 * `r2PathForKey` (fail-loud per CLAUDE.md).
 *
 * Write gate (AC-41.3): `policy.immutable === true` AND
 *                       `entry.sessionStatus === 'frozen'`.
 * Anything else is silently skipped — not an error, the right semantics
 * for non-static data flowing through the same pipeline.
 *
 * Byte-verbatim: contentType travels on R2 httpMetadata so serving on a
 * later request preserves the original upstream media type (XML stays XML).
 *
 * The binding may be undefined in tests and in envs that haven't yet
 * provisioned the R2 bucket — `get` returns null and `put` no-ops.
 *
 * Traces: FR-41 AC-41.1, AC-41.2, AC-41.3, AC-41.5, AC-41.6.
 */

import type { CacheEntry, CacheTier } from './tier';
import type { CacheKey } from './key';
import type { WritePolicy } from './policy';

/** Minimal shape of an R2 bucket (narrower than @cloudflare/workers-types). */
export interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
  put(
    key: string,
    value: string | ArrayBuffer | Uint8Array,
    opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>;
}
export interface R2ObjectLike {
  text(): Promise<string>;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

/**
 * AC-41.2 — serialize a CacheKey to its canonical R2 archive path.
 * Only the five R2-eligible kinds are supported. Everything else throws.
 */
export function r2PathForKey(key: CacheKey): string {
  switch (key.kind) {
    case 'senate-xml': {
      const rc = String(key.params.rollCall).padStart(5, '0');
      return `archive/senate/xml/vote_${key.params.congress}_${key.params.session}_${rc}.xml`;
    }
    case 'house-roster':
      return `archive/congress/house-vote/${key.params.congress}/${key.params.session}/${key.params.rollCall}/members.json`;
    case 'house-vote-detail':
      return `archive/congress/house-vote/${key.params.congress}/${key.params.session}/${key.params.rollCall}.json`;
    case 'bill-actions':
      return `archive/congress/bill/${key.params.congress}/${key.params.type}/${key.params.number}/actions.json`;
    case 'bill-summaries':
      return `archive/congress/bill/${key.params.congress}/${key.params.type}/${key.params.number}/summaries.json`;
    default:
      throw new Error(`r2PathForKey: unsupported CacheKey kind '${key.kind}' — only static upstream archives are R2-eligible`);
  }
}

export class R2Tier<V extends string> implements CacheTier<V> {
  public readonly name = 'r2' as const;
  public readonly canWrite = true;

  constructor(private readonly bucket: R2BucketLike | undefined) {}

  async get(key: CacheKey): Promise<CacheEntry<V> | null> {
    if (!this.bucket) return null;
    let path: string;
    try {
      path = r2PathForKey(key);
    } catch {
      return null; // unsupported kind — graceful miss on the read path
    }
    const obj = await this.bucket.get(path);
    if (!obj) return null;
    const text = await obj.text();
    const meta = obj.customMetadata ?? {};
    const entry: CacheEntry<V> = {
      value: text as unknown as V,
      contentType: obj.httpMetadata?.contentType ?? 'application/octet-stream',
      fetchedAt: meta.fetchedAt ? Number(meta.fetchedAt) : 0,
      sourceUpstream:
        (meta.sourceUpstream as CacheEntry<V>['sourceUpstream']) ?? 'synthetic',
      ...(meta.sessionStatus
        ? { sessionStatus: meta.sessionStatus as 'frozen' | 'live' }
        : {}),
    };
    return entry;
  }

  async put(key: CacheKey, entry: CacheEntry<V>, policy: WritePolicy): Promise<void> {
    if (!this.bucket) return;
    // AC-41.3 gate.
    if (!policy.immutable) return;
    if (entry.sessionStatus !== 'frozen') return;
    const path = r2PathForKey(key); // throws on unsupported kind — fail-loud on write
    const customMetadata: Record<string, string> = {
      fetchedAt: String(entry.fetchedAt),
      sourceUpstream: entry.sourceUpstream,
      sessionStatus: entry.sessionStatus,
    };
    await this.bucket.put(path, entry.value, {
      httpMetadata: { contentType: entry.contentType },
      customMetadata,
    });
  }
}
