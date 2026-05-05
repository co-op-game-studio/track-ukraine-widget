/**
 * Tests for src/utils/ulid.ts.
 * Traces to FR-49 AC-49.5.
 */
import { describe, it, expect } from 'vitest';
import { newUlid, isUlid } from '../../src/utils/ulid';

describe('ulid (FR-49 AC-49.5)', () => {
  it('emits 26 chars in the Crockford-base32 alphabet', () => {
    for (let i = 0; i < 10; i++) {
      const id = newUlid();
      expect(id).toHaveLength(26);
      expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(isUlid(id)).toBe(true);
    }
  });

  it('preserves lexicographic order across monotonically increasing timestamps', () => {
    const a = newUlid(1_700_000_000_000);
    const b = newUlid(1_700_000_000_001);
    const c = newUlid(1_800_000_000_000);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });

  it('is collision-resistant at 10k draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      seen.add(newUlid());
    }
    expect(seen.size).toBe(10_000);
  });

  it('isUlid rejects non-strings, wrong length, and disallowed chars', () => {
    expect(isUlid('')).toBe(false);
    expect(isUlid('abc')).toBe(false);
    expect(isUlid('I'.repeat(26))).toBe(false); // I is not in Crockford alphabet
    expect(isUlid('L'.repeat(26))).toBe(false); // L disallowed
    expect(isUlid('O'.repeat(26))).toBe(false); // O disallowed
    expect(isUlid('U'.repeat(26))).toBe(false); // U disallowed
    expect(isUlid('0'.repeat(27))).toBe(false);
    expect(isUlid(null)).toBe(false);
    expect(isUlid(undefined)).toBe(false);
    expect(isUlid(123)).toBe(false);
    expect(isUlid('0'.repeat(26))).toBe(true);
    expect(isUlid('Z'.repeat(26))).toBe(true);
  });

  it('encodes the timestamp prefix consistently for a fixed input', () => {
    // Two ULIDs from the same ms share the 10-char timestamp prefix.
    const t = 1_700_000_000_000;
    const a = newUlid(t);
    const b = newUlid(t);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
    // Random suffix is overwhelmingly different.
    expect(a.slice(10)).not.toBe(b.slice(10));
  });
});
