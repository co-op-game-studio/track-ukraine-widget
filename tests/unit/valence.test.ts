/**
 * Valence tests (FR-15, design.md §4.9)
 */
import { describe, it, expect } from 'vitest';
import { computeValence } from '../../src/services/valence';

describe('computeValence', () => {
  describe('pro-ukraine bill', () => {
    it('sponsoring → sponsor-pro', () => {
      expect(computeValence('pro-ukraine', 'sponsored')).toBe('sponsor-pro');
    });
    it('cosponsoring → sponsor-pro', () => {
      expect(computeValence('pro-ukraine', 'cosponsored')).toBe('sponsor-pro');
    });
    it('voting Yea → voted-pro', () => {
      expect(computeValence('pro-ukraine', 'voted-aye')).toBe('voted-pro');
    });
    it('voting Nay → voted-anti', () => {
      expect(computeValence('pro-ukraine', 'voted-nay')).toBe('voted-anti');
    });
    it('voting Present → unstated', () => {
      expect(computeValence('pro-ukraine', 'voted-present')).toBe('unstated');
    });
    it('not voting → unstated', () => {
      expect(computeValence('pro-ukraine', 'not-voted')).toBe('unstated');
    });
  });

  describe('anti-ukraine bill (e.g., strip-$300M amendment)', () => {
    it('sponsoring → sponsor-anti', () => {
      expect(computeValence('anti-ukraine', 'sponsored')).toBe('sponsor-anti');
    });
    it('cosponsoring → sponsor-anti', () => {
      expect(computeValence('anti-ukraine', 'cosponsored')).toBe('sponsor-anti');
    });
    it('voting Yea (for the anti-UA amendment) → voted-anti', () => {
      expect(computeValence('anti-ukraine', 'voted-aye')).toBe('voted-anti');
    });
    it('voting Nay (against the anti-UA amendment) → voted-pro', () => {
      expect(computeValence('anti-ukraine', 'voted-nay')).toBe('voted-pro');
    });
  });

  describe('neutral bill (oversight / symbolic)', () => {
    it('any action on a neutral bill → unstated', () => {
      expect(computeValence('neutral', 'voted-aye')).toBe('unstated');
      expect(computeValence('neutral', 'voted-nay')).toBe('unstated');
      expect(computeValence('neutral', 'sponsored')).toBe('unstated');
      expect(computeValence('neutral', 'cosponsored')).toBe('unstated');
    });
  });

  describe('directionMultiplier (v2.1.2)', () => {
    it('inverts valence for motion-to-recommit (multiplier = -1)', () => {
      // Aye on motion-to-recommit for a pro-UA bill = attempting to kill it = voted-anti
      expect(computeValence('pro-ukraine', 'voted-aye', -1)).toBe('voted-anti');
      // Nay on motion-to-recommit = blocking the kill attempt = voted-pro
      expect(computeValence('pro-ukraine', 'voted-nay', -1)).toBe('voted-pro');
    });

    it('returns unstated when multiplier = 0 (ambiguous)', () => {
      expect(computeValence('pro-ukraine', 'voted-aye', 0)).toBe('unstated');
      expect(computeValence('anti-ukraine', 'voted-aye', 0)).toBe('unstated');
    });

    it('behaves normally when multiplier = +1 (default)', () => {
      expect(computeValence('pro-ukraine', 'voted-aye', +1)).toBe('voted-pro');
    });
  });
});
