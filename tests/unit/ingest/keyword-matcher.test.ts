/**
 * Keyword matcher — pure function tests.
 *
 * Traces: FR-59 — keyword watch system.
 */
import { describe, it, expect } from 'vitest';
import { matchKeywords, type KeywordWatch } from '../../../src/ingest/keyword-matcher';

const WATCHES: KeywordWatch[] = [
  { watchName: 'ukraine', pattern: 'ukraine', isRegex: false },
  { watchName: 'coal', pattern: 'coal', isRegex: false },
  { watchName: 'climate', pattern: 'climate change|global warming', isRegex: true },
  { watchName: 'china-hawk', pattern: '\\bCCP\\b|\\bXi Jinping\\b', isRegex: true },
];

describe('matchKeywords', () => {
  it('matches a plain keyword (case-insensitive)', () => {
    expect(matchKeywords('I stand with Ukraine!', WATCHES)).toEqual(['ukraine']);
  });

  it('matches multiple keywords', () => {
    expect(matchKeywords('Ukraine coal miners deserve better', WATCHES)).toEqual([
      'ukraine',
      'coal',
    ]);
  });

  it('matches regex patterns', () => {
    expect(matchKeywords('Climate change is real', WATCHES)).toEqual(['climate']);
    expect(matchKeywords('The CCP must be held accountable', WATCHES)).toEqual(['china-hawk']);
  });

  it('returns empty array when nothing matches', () => {
    expect(matchKeywords('Happy birthday to the Dodgers!', WATCHES)).toEqual([]);
  });

  it('plain keywords match as whole words only', () => {
    // "coalition" contains "coal" but should NOT match the plain keyword "coal"
    expect(matchKeywords('The coalition agreed', WATCHES)).toEqual([]);
  });

  it('handles empty text', () => {
    expect(matchKeywords('', WATCHES)).toEqual([]);
  });

  it('handles empty watches list', () => {
    expect(matchKeywords('Ukraine forever', [])).toEqual([]);
  });

  it('survives a bad regex pattern without crashing', () => {
    const bad: KeywordWatch[] = [
      { watchName: 'broken', pattern: '[invalid(', isRegex: true },
      { watchName: 'ukraine', pattern: 'ukraine', isRegex: false },
    ];
    // Should skip the broken one and still match ukraine.
    expect(matchKeywords('Ukraine', bad)).toEqual(['ukraine']);
  });
});
