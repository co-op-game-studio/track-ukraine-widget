/**
 * CacheKey — structured domain-level identifier for a cacheable response.
 *
 * Each tier (edge/kv/r2) defines its own `serialize(key): string` producing
 * the native format for that tier (URL for edge, dotted string for KV, path
 * for R2). CacheKeys themselves are tier-agnostic and carry semantic meaning
 * only — "this request is for the Senate XML of (c,s,rc)" rather than
 * "this request is for /api/senate/...".
 *
 * Traces: FR-40 AC-40.1, AC-40.2. Used by FR-41 AC-41.2 (R2 path scheme).
 */

export const CACHE_KINDS = [
  'senate-xml',
  'house-roster',
  'house-vote-detail',
  'bill-actions',
  'bill-summaries',
  'member-detail',
  'member-sponsored',
  'member-cosponsored',
  'census-geocoder',
  'bill-record',
  'roll-call-roster',
  'state-members',
  'member-profile',
  'name-index-shard',
] as const;

export type CacheKind = typeof CACHE_KINDS[number];

export interface CacheKey {
  readonly kind: CacheKind;
  readonly params: Readonly<Record<string, string | number>>;
}

/**
 * Deterministic flat serialization for logging and generic keying. Param
 * keys are sorted alphabetically so two `CacheKey`s with the same logical
 * content always produce the same string.
 *
 * Format: `{kind}:{k1}={v1}:{k2}={v2}...`
 *
 * Each tier has its own serializer producing its native format; this helper
 * is for tier-agnostic code (logs, tests, tier-miss debug traces).
 */
export function cacheKeyToDottedString(key: CacheKey): string {
  if (!key.kind) {
    throw new Error('cacheKeyToDottedString: kind is required');
  }
  const keys = Object.keys(key.params).sort();
  const parts = [key.kind as string, ...keys.map((k) => `${k}=${key.params[k]}`)];
  return parts.join(':');
}

/**
 * Structural equality on two CacheKeys. Tier-agnostic.
 */
export function cacheKeyEquals(a: CacheKey, b: CacheKey): boolean {
  if (a.kind !== b.kind) return false;
  const aKeys = Object.keys(a.params).sort();
  const bKeys = Object.keys(b.params).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    const k = aKeys[i]!;
    if (a.params[k] !== b.params[k]) return false;
  }
  return true;
}
