/**
 * WritePolicy — per-route declaration of caching behavior.
 *
 * Each route in `proxy/routes/cache-config.ts` exports a `WritePolicy` that
 * tells the `TieredCache`:
 *   - how long to cache (maxAge)
 *   - whether the response is byte-level-immutable (immutable)
 *   - which tiers are eligible for writes (eligibleTiers)
 *
 * This is the policy-layer gate. Each concrete tier's own `put()` may
 * additionally reject a write (e.g. R2Tier rejects unless sessionStatus is
 * 'frozen'), but the policy is what names which tiers can even be offered
 * the write in the first place.
 *
 * Traces: FR-40 AC-40.4.
 */

export type TierName = 'edge' | 'kv' | 'r2';

export interface WritePolicy {
  readonly maxAge: number;
  readonly immutable: boolean;
  readonly eligibleTiers: readonly TierName[];
}

/** Standard policy for byte-level-immutable upstream responses that qualify
 *  for R2 (closed-session roll-call data). */
export const IMMUTABLE_ARCHIVE_POLICY: WritePolicy = {
  maxAge: 31_536_000,
  immutable: true,
  eligibleTiers: ['edge', 'kv', 'r2'],
} as const;

/** Standard policy for rotating upstream responses (member bios, geocoder).
 *  Edge + KV only; R2 would stale-pin these indefinitely. */
export const ROTATING_POLICY: WritePolicy = {
  maxAge: 86_400,
  immutable: false,
  eligibleTiers: ['edge', 'kv'],
} as const;

/** Short-TTL policy for data that changes frequently (bill metadata, etc.). */
export const SHORT_ROTATING_POLICY: WritePolicy = {
  maxAge: 3_600,
  immutable: false,
  eligibleTiers: ['edge', 'kv'],
} as const;
