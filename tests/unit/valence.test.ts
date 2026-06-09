/**
 * Valence tests (FR-15, design.md §4.9)
 */
import { describe, it, expect } from 'vitest';
import {
  computeValence,
  directionFromLegacy,
  valenceForVote,
  type BillDirection,
  type MemberAction,
  type VoteCast,
} from '../../src/services/valence';

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

/* -------------------------------------------------------------------------- */
/*       FR-63 — explicit per-vote direction: score-preserving equivalence     */
/* -------------------------------------------------------------------------- */

describe('FR-63 explicit per-vote direction', () => {
  const billDirs: BillDirection[] = ['pro-ukraine', 'anti-ukraine', 'neutral'];
  const dms: Array<-1 | 0 | 1> = [-1, 0, 1];
  const casts: VoteCast[] = ['voted-aye', 'voted-nay', 'voted-present', 'not-voted'];

  // VoteCast and MemberAction overlap on the vote values used here.
  const castToAction = (c: VoteCast): MemberAction => c as unknown as MemberAction;

  it('AC-63.4: valenceForVote(directionFromLegacy(...)) equals legacy computeValence for ALL combinations', () => {
    for (const billDir of billDirs) {
      for (const dm of dms) {
        for (const cast of casts) {
          const legacy = computeValence(billDir, castToAction(cast), dm);
          const explicit = valenceForVote(directionFromLegacy(billDir, dm), cast);
          expect(
            explicit,
            `mismatch for billDir=${billDir} dm=${dm} cast=${cast}: legacy=${legacy} explicit=${explicit}`,
          ).toBe(legacy);
        }
      }
    }
  });

  it('AC-63.3: explicit scoring needs no bill direction or multiplier', () => {
    expect(valenceForVote('pro', 'voted-aye')).toBe('voted-pro');
    expect(valenceForVote('pro', 'voted-nay')).toBe('voted-anti');
    expect(valenceForVote('anti', 'voted-aye')).toBe('voted-anti');
    expect(valenceForVote('anti', 'voted-nay')).toBe('voted-pro');
    expect(valenceForVote('neutral', 'voted-aye')).toBe('unstated');
    expect(valenceForVote('pro', 'voted-present')).toBe('unstated');
    expect(valenceForVote('pro', 'not-voted')).toBe('unstated');
  });

  it('AC-63.1: conversion table — the previously-inverted cases flip direction', () => {
    expect(directionFromLegacy('pro-ukraine', 1)).toBe('pro');
    expect(directionFromLegacy('pro-ukraine', -1)).toBe('anti');
    expect(directionFromLegacy('anti-ukraine', 1)).toBe('anti');
    expect(directionFromLegacy('anti-ukraine', -1)).toBe('pro');
    expect(directionFromLegacy('neutral', 1)).toBe('neutral');
    expect(directionFromLegacy('neutral', -1)).toBe('anti');
    expect(directionFromLegacy('pro-ukraine', 0)).toBe('neutral');
  });
});
