/**
 * Ukraine Support Score tests (FR-16, design.md §4.10)
 */
import { describe, it, expect } from 'vitest';
import { computeUkraineScore, scoreToCssColor } from '../../src/services/ukraineScore';

describe('computeUkraineScore', () => {
  it('returns null for zero contributing actions', () => {
    const r = computeUkraineScore([]);
    expect(r.score).toBeNull();
    expect(r.contributing).toBe(0);
    expect(r.total).toBe(0);
  });

  it('returns null when every action is unstated', () => {
    const r = computeUkraineScore([
      { valence: 'unstated', weight: 1.0 },
      { valence: 'unstated', weight: 0.5 },
    ]);
    expect(r.score).toBeNull();
    expect(r.contributing).toBe(0);
    expect(r.total).toBe(2);
  });

  it('returns +1 when every contributing action is pro', () => {
    const r = computeUkraineScore([
      { valence: 'voted-pro', weight: 1.0 },
      { valence: 'voted-pro', weight: 0.9 },
      { valence: 'sponsor-pro', weight: 1.0 },
    ]);
    expect(r.score).toBe(1);
    expect(r.contributing).toBe(3);
  });

  it('returns -1 when every contributing action is anti', () => {
    const r = computeUkraineScore([
      { valence: 'voted-anti', weight: 1.0 },
      { valence: 'sponsor-anti', weight: 1.0 },
    ]);
    expect(r.score).toBe(-1);
    expect(r.contributing).toBe(2);
  });

  it('weighted average: voted-pro (w=1, amp=1) cancels voted-anti (w=1, amp=1) → 0', () => {
    const r = computeUkraineScore([
      { valence: 'voted-pro', weight: 1.0 },
      { valence: 'voted-anti', weight: 1.0 },
    ]);
    expect(r.score).toBe(0);
  });

  it('sponsorship has 1.5× the weight of a mere vote (amplifier)', () => {
    // One pro vote (amp 1.0) vs one anti sponsor (amp 1.5)
    // numerator = +1*1*1  +  -1*1.5*1 = -0.5
    // denominator = 1*1 + 1.5*1 = 2.5
    // score = -0.5 / 2.5 = -0.2
    const r = computeUkraineScore([
      { valence: 'voted-pro', weight: 1.0 },
      { valence: 'sponsor-anti', weight: 1.0 },
    ]);
    expect(r.score).toBeCloseTo(-0.2, 6);
  });

  it('weight-0 votes (ambiguous procedurals like motion-to-table) are EXCLUDED', () => {
    // 1 passage (w=1.0) + 10 weight-0 "motion to table" votes = pure +1
    // since the ambiguous ones are excluded.
    const r = computeUkraineScore([
      { valence: 'voted-pro', weight: 1.0 },
      ...Array.from({ length: 10 }, () => ({ valence: 'voted-pro' as const, weight: 0 })),
    ]);
    expect(r.score).toBe(1);
    expect(r.contributing).toBe(1);

    // Only ambiguous procedurals → no signal at all
    const r2 = computeUkraineScore([
      { valence: 'voted-pro', weight: 0 },
      { valence: 'voted-anti', weight: 0 },
    ]);
    expect(r2.score).toBeNull();
    expect(r2.contributing).toBe(0);
  });

  it('directional procedurals (cloture, motion-to-proceed) DO contribute', () => {
    // 1 pro passage (1.0) + 2 pro clotures (0.45 each) — still +1
    const r = computeUkraineScore([
      { valence: 'voted-pro', weight: 1.0 },
      { valence: 'voted-pro', weight: 0.45 },
      { valence: 'voted-pro', weight: 0.45 },
    ]);
    expect(r.score).toBe(1);
    expect(r.contributing).toBe(3);

    // Mix: passage pro + 2 clotures anti (e.g., voted against allowing debate)
    // numerator = +1.0 - 0.45 - 0.45 = +0.10
    // denominator = 1.0 + 0.45 + 0.45 = 1.90
    // score ≈ +0.053
    const r2 = computeUkraineScore([
      { valence: 'voted-pro', weight: 1.0 },
      { valence: 'voted-anti', weight: 0.45 },
      { valence: 'voted-anti', weight: 0.45 },
    ]);
    expect(r2.score).toBeCloseTo(0.053, 2);
  });

  it('unstated actions are counted in total but not in contributing', () => {
    const r = computeUkraineScore([
      { valence: 'voted-pro', weight: 1.0 },
      { valence: 'unstated', weight: 1.0 },
      { valence: 'unstated', weight: 1.0 },
    ]);
    expect(r.score).toBe(1);
    expect(r.contributing).toBe(1);
    expect(r.total).toBe(3);
  });

  it('flags low-confidence when contributing actions are below threshold', () => {
    // 1 contributing action — low confidence
    const r = computeUkraineScore([
      { valence: 'voted-pro', weight: 1.0 },
    ]);
    expect(r.lowConfidence).toBe(true);
    expect(r.contributing).toBe(1);

    // 3+ contributing actions — not low confidence (binary legacy alias)
    const r2 = computeUkraineScore([
      { valence: 'voted-pro', weight: 1.0 },
      { valence: 'voted-pro', weight: 1.0 },
      { valence: 'voted-pro', weight: 1.0 },
    ]);
    expect(r2.lowConfidence).toBe(false);
  });

  // FR-43 AC-43.1, AC-43.2: tri-state confidence tier.
  describe('confidenceTier (FR-43 AC-43.1)', () => {
    function tierFor(n: number): 'low' | 'moderate' | 'full' {
      const actions = Array.from({ length: n }, () => ({ valence: 'voted-pro' as const, weight: 1.0 }));
      return computeUkraineScore(actions).confidenceTier;
    }

    it('tier=low for 1 action', () => {
      expect(tierFor(1)).toBe('low');
    });
    it('tier=low for 2 actions', () => {
      expect(tierFor(2)).toBe('low');
    });
    it('tier=moderate for exactly LOW_CONFIDENCE_THRESHOLD (3)', () => {
      expect(tierFor(3)).toBe('moderate');
    });
    it('tier=moderate for 7 actions', () => {
      expect(tierFor(7)).toBe('moderate');
    });
    it('tier=full for exactly MODERATE_CONFIDENCE_THRESHOLD (8)', () => {
      expect(tierFor(8)).toBe('full');
    });
    it('tier=full for 9 actions', () => {
      expect(tierFor(9)).toBe('full');
    });
    it('tier=low when zero contributing actions and score is null', () => {
      const r = computeUkraineScore([]);
      expect(r.score).toBeNull();
      expect(r.confidenceTier).toBe('low');
    });
    it('lowConfidence alias mirrors (tier==="low" && contributing>0), AC-43.2', () => {
      for (const n of [0, 1, 2, 3, 7, 8, 9]) {
        const actions = Array.from({ length: n }, () => ({ valence: 'voted-pro' as const, weight: 1.0 }));
        const r = computeUkraineScore(actions);
        expect(r.lowConfidence).toBe(r.confidenceTier === 'low' && r.contributing > 0);
      }
    });
  });

  // FR-43 AC-43.1: continuous confidence index.
  describe('confidence (continuous, AC-43.1)', () => {
    function confidenceFor(n: number): number {
      const actions = Array.from({ length: n }, () => ({ valence: 'voted-pro' as const, weight: 1.0 }));
      return computeUkraineScore(actions).confidence;
    }

    it('zero contributing → confidence 0', () => {
      expect(confidenceFor(0)).toBe(0);
    });
    it('1 action → confidence 0.125', () => {
      expect(confidenceFor(1)).toBeCloseTo(0.125, 4);
    });
    it('4 actions → confidence 0.5', () => {
      expect(confidenceFor(4)).toBe(0.5);
    });
    it('7 actions → confidence 0.875', () => {
      expect(confidenceFor(7)).toBeCloseTo(0.875, 4);
    });
    it('exactly 8 actions (MODERATE_CONFIDENCE_THRESHOLD) → confidence 1.0', () => {
      expect(confidenceFor(8)).toBe(1);
    });
    it('clamps at 1.0 for counts above threshold', () => {
      expect(confidenceFor(20)).toBe(1);
      expect(confidenceFor(1000)).toBe(1);
    });
    it('confidence is monotonic non-decreasing over contributing count', () => {
      let prev = -Infinity;
      for (let n = 0; n <= 12; n++) {
        const c = confidenceFor(n);
        expect(c).toBeGreaterThanOrEqual(prev);
        prev = c;
      }
    });
  });

  it('Lankford-style regression: mostly anti-UA votes produce deep negative score', () => {
    // Approximating Lankford's real actions using the new weight scheme:
    //   HR 2471 Nay        (pro-UA, passage w=0.9)     → voted-anti −0.9
    //   HR 7691 Aye        (pro-UA, passage w=1.0)     → voted-pro  +1.0
    //   HR 815 Nay         (pro-UA, passage w=1.0)     → voted-anti −1.0
    //   HR 815 Aye concur  (pro-UA, concur w=0.9)      → voted-pro  +0.9
    //   HR 6833 Nay        (pro-UA, passage w=1.0)     → voted-anti −1.0
    //   SJRES 117 Aye      (anti-UA, motion-to-proceed w=0.3)  → voted-anti −0.3
    // numerator = −0.9 + 1.0 − 1.0 + 0.9 − 1.0 − 0.3 = −1.3
    // denominator = 0.9 + 1.0 + 1.0 + 0.9 + 1.0 + 0.3 = 5.1
    // score ≈ −0.255
    const r = computeUkraineScore([
      { valence: 'voted-anti', weight: 0.9 },
      { valence: 'voted-pro',  weight: 1.0 },
      { valence: 'voted-anti', weight: 1.0 },
      { valence: 'voted-pro',  weight: 0.9 },
      { valence: 'voted-anti', weight: 1.0 },
      { valence: 'voted-anti', weight: 0.3 },
    ]);
    expect(r.score).toBeCloseTo(-0.255, 2);
    expect(r.contributing).toBe(6);
    expect(r.lowConfidence).toBe(false);
  });
});

describe('scoreToCssColor', () => {
  it('returns slate gray for null', () => {
    expect(scoreToCssColor(null)).toMatch(/hsl/);
  });
  it('returns red-ish hue for -1', () => {
    expect(scoreToCssColor(-1)).toContain('0.0'); // hue 0° = red
  });
  it('returns yellow hue for 0', () => {
    expect(scoreToCssColor(0)).toContain('60.0');
  });
  it('returns green hue for +1', () => {
    expect(scoreToCssColor(1)).toContain('120.0');
  });
  it('clamps values outside [-1, 1]', () => {
    expect(scoreToCssColor(-5)).toContain('0.0');
    expect(scoreToCssColor(5)).toContain('120.0');
  });
});
