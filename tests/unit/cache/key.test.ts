/**
 * Tests for proxy/cache/key.ts — CacheKey schema + serializers.
 *
 * Traces to FR-40 AC-40.1, AC-40.2 + FR-41 AC-41.2 (spec.md v2.6.0).
 */
import { describe, expect, it } from 'vitest';
import {
  CACHE_KINDS,
  cacheKeyEquals,
  cacheKeyToDottedString,
  type CacheKey,
} from '../../../proxy/cache/key';

describe('CACHE_KINDS — AC-40.2: closed enumeration', () => {
  it('contains exactly the 13 specified kinds', () => {
    expect([...CACHE_KINDS].sort()).toEqual(
      [
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
      ].sort(),
    );
  });
});

describe('cacheKeyToDottedString — deterministic param serialization', () => {
  it('encodes kind:param1:param2:... with sorted keys', () => {
    const key: CacheKey = {
      kind: 'senate-xml',
      params: { congress: 117, session: 2, rollCall: 78 },
    };
    // Sorted key order: congress, rollCall, session (alphabetical).
    expect(cacheKeyToDottedString(key)).toBe('senate-xml:congress=117:rollCall=78:session=2');
  });

  it('produces the same string regardless of param-object key order', () => {
    const a: CacheKey = {
      kind: 'house-roster',
      params: { congress: 118, session: 1, rollCall: 5 },
    };
    const b: CacheKey = {
      kind: 'house-roster',
      params: { rollCall: 5, session: 1, congress: 118 },
    };
    expect(cacheKeyToDottedString(a)).toBe(cacheKeyToDottedString(b));
  });

  it('handles string params', () => {
    const key: CacheKey = {
      kind: 'state-members',
      params: { state: 'IL' },
    };
    expect(cacheKeyToDottedString(key)).toBe('state-members:state=IL');
  });

  it('rejects empty kind (guard against silent fallthrough)', () => {
    expect(() =>
      cacheKeyToDottedString({ kind: '' as CacheKey['kind'], params: {} }),
    ).toThrow(/kind/);
  });
});

describe('cacheKeyEquals — structural equality', () => {
  it('returns true for two keys with same kind + params', () => {
    const a: CacheKey = { kind: 'senate-xml', params: { congress: 117, session: 2, rollCall: 78 } };
    const b: CacheKey = { kind: 'senate-xml', params: { congress: 117, session: 2, rollCall: 78 } };
    expect(cacheKeyEquals(a, b)).toBe(true);
  });

  it('returns true regardless of param-object key order', () => {
    const a: CacheKey = { kind: 'senate-xml', params: { congress: 117, session: 2, rollCall: 78 } };
    const b: CacheKey = { kind: 'senate-xml', params: { rollCall: 78, session: 2, congress: 117 } };
    expect(cacheKeyEquals(a, b)).toBe(true);
  });

  it('returns false when kind differs', () => {
    const a: CacheKey = { kind: 'senate-xml', params: { x: 1 } };
    const b: CacheKey = { kind: 'house-roster', params: { x: 1 } };
    expect(cacheKeyEquals(a, b)).toBe(false);
  });

  it('returns false when params differ', () => {
    const a: CacheKey = { kind: 'senate-xml', params: { congress: 117 } };
    const b: CacheKey = { kind: 'senate-xml', params: { congress: 118 } };
    expect(cacheKeyEquals(a, b)).toBe(false);
  });

  it('returns false when param counts differ', () => {
    const a: CacheKey = { kind: 'senate-xml', params: { congress: 117 } };
    const b: CacheKey = { kind: 'senate-xml', params: { congress: 117, session: 2 } };
    expect(cacheKeyEquals(a, b)).toBe(false);
  });
});
