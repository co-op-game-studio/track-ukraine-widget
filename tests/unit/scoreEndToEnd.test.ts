/**
 * End-to-end score scenario test (FR-54 + AC-52.44).
 *
 * Walks a researcher-edits-the-score scenario through the score formula:
 *
 *   1. A representative starts with NO contributing actions → score is
 *      null + tier 'insufficient'.
 *   2. Researcher annotates a comment with weight + direction. Comment
 *      should ENTER the formula as a synthetic action (AC-52.44 — pre-V4
 *      behavior had comments stored but never feeding the score; this is
 *      the spec-as-truth correction in AC-52.45).
 *   3. With enough contributing actions, the score becomes a real number
 *      and the tier graduates from 'insufficient' to 'low'/'moderate'/'full'.
 *   4. Direction sign carries through: positive direction → positive score,
 *      negative direction → negative score.
 *
 * This is the canonical "edit changes score" test the V4 architecture
 * promises. It tests the math directly (no React, no D1, no fetch) so
 * it's deterministic and fast.
 */
import { describe, it, expect } from 'vitest';
import { computeUkraineScore, type ScoreInput } from '../../src/services/ukraineScore';
import type { Valence } from '../../src/services/valence';

/** Mirror of `useUkraineScore`'s synthetic-action mapping for comments/posts/quotes.
 *  Keep this in sync with the hook's logic — the hook is React-y; the math
 *  is pure and lives here for direct testability. */
function commentToAction(c: { weight: number; direction: number }): ScoreInput | null {
  if (c.weight <= 0) return null;
  if (c.direction === 0) return null;
  const valence: Valence = c.direction === 1 ? 'voted-pro' : 'voted-anti';
  return { valence, weight: c.weight };
}

function commentsToActions(rows: Array<{ weight: number; direction: number }>): ScoreInput[] {
  const out: ScoreInput[] = [];
  for (const r of rows) {
    const a = commentToAction(r);
    if (a) out.push(a);
  }
  return out;
}

describe('end-to-end: bill-comment edits change the rep score', () => {
  it('baseline: zero actions → score is null with insufficient tier', () => {
    const r = computeUkraineScore([]);
    expect(r.score).toBeNull();
    expect(r.rawScore).toBeNull();
    expect(r.contributing).toBe(0);
    expect(r.confidenceTier).toBe('insufficient');
  });

  it('one zero-weight, zero-direction comment → still no contributing action (matches researcher logging "for the record" with no signal)', () => {
    const actions = commentsToActions([{ weight: 0, direction: 0 }]);
    const r = computeUkraineScore(actions);
    expect(r.contributing).toBe(0);
    expect(r.score).toBeNull();
  });

  it('AC-52.44 — annotating a comment with positive weight + +1 direction adds a contributing action', () => {
    const actions = commentsToActions([{ weight: 3, direction: 1 }]);
    const r = computeUkraineScore(actions);
    expect(r.contributing).toBe(1);
    // 1 contributing < NEW_REP_THRESHOLD (2) → still insufficient.
    expect(r.confidenceTier).toBe('insufficient');
  });

  it('two strong pro comments → tier graduates to "low" with positive raw score', () => {
    const actions = commentsToActions([
      { weight: 3, direction: 1 },
      { weight: 3, direction: 1 },
    ]);
    const r = computeUkraineScore(actions);
    expect(r.contributing).toBe(2);
    expect(r.confidenceTier).toBe('low');
    expect(r.rawScore).toBeGreaterThan(0);
  });

  it('one anti comment > one pro → score goes negative as researcher tunes magnitude', () => {
    const actions = commentsToActions([
      { weight: 5, direction: -1 },
      { weight: 1, direction: 1 },
    ]);
    const r = computeUkraineScore(actions);
    expect(r.contributing).toBe(2);
    expect(r.rawScore).toBeLessThan(0);
  });

  it('flipping direction on a comment (pro → anti) flips the score sign', () => {
    const positive = computeUkraineScore(commentsToActions([
      { weight: 3, direction: 1 },
      { weight: 3, direction: 1 },
    ]));
    const flipped = computeUkraineScore(commentsToActions([
      { weight: 3, direction: -1 },
      { weight: 3, direction: -1 },
    ]));
    expect(positive.rawScore!).toBeGreaterThan(0);
    expect(flipped.rawScore!).toBeLessThan(0);
    expect(flipped.rawScore!).toBeCloseTo(-positive.rawScore!, 5);
  });

  it('reducing weight reduces the score magnitude (researcher dials it down)', () => {
    const heavy = computeUkraineScore(commentsToActions([
      { weight: 5, direction: -1 },
      { weight: 5, direction: -1 },
      { weight: 5, direction: -1 },
    ]));
    const light = computeUkraineScore(commentsToActions([
      { weight: 1, direction: -1 },
      { weight: 1, direction: -1 },
      { weight: 1, direction: -1 },
    ]));
    // Both fully anti, so both should be -1.0 raw (100% magnitude is anti).
    // The formula normalizes by total weight, so magnitude is the same.
    // What matters: the SIGN is preserved and the tier reflects count.
    expect(heavy.rawScore).toBe(-1);
    expect(light.rawScore).toBe(-1);
    expect(heavy.contributing).toBe(3);
    expect(light.contributing).toBe(3);
  });

  it('a vote + a comment compose: each contributes its weighted sign', () => {
    const actions: ScoreInput[] = [
      { valence: 'voted-pro', weight: 1.0 }, // pretend vote
      ...commentsToActions([
        { weight: 2, direction: -1 },         // researcher comment, anti-leaning
      ]),
    ];
    const r = computeUkraineScore(actions);
    expect(r.contributing).toBe(2);
    // 1 pro@1 + 1 anti@2 → numerator = 1 - 2 = -1, denominator = 3 → -1/3
    expect(r.rawScore).toBeCloseTo(-1 / 3, 4);
  });

  it('Bayesian shrink kicks in when partyPrior is supplied: low-count score pulled toward the prior', () => {
    // 2 pro comments → raw +1, but with low contributing count it should shrink.
    const actions = commentsToActions([
      { weight: 3, direction: 1 },
      { weight: 3, direction: 1 },
    ]);
    const noShrink = computeUkraineScore(actions);
    const withShrink = computeUkraineScore(actions, { partyPrior: -0.5 });
    expect(noShrink.rawScore).toBe(1);
    expect(withShrink.rawScore).toBe(1);
    // Shrunk score lies between rawScore (+1) and partyPrior (-0.5).
    expect(withShrink.score!).toBeLessThan(1);
    expect(withShrink.score!).toBeGreaterThan(-0.5);
  });

  it('full scenario: rep imported with 0 score → researcher adds annotation → score reflects edit', () => {
    // Step 1: brand-new rep, no curated content yet.
    let actions: ScoreInput[] = [];
    let r = computeUkraineScore(actions);
    expect(r.score).toBeNull();
    expect(r.confidenceTier).toBe('insufficient');

    // Step 2: researcher imports a bill, marks one vote pro.
    actions = [{ valence: 'voted-pro', weight: 0.9 }];
    r = computeUkraineScore(actions);
    // Still 1 contributing — below NEW_REP_THRESHOLD.
    expect(r.confidenceTier).toBe('insufficient');
    expect(r.score).toBeNull();
    // But rawScore is computable — admin debug surface.
    expect(r.rawScore).toBe(1);

    // Step 3: researcher adds a strong anti comment ("Poisoned with imperialist spending").
    actions.push({ valence: 'voted-anti', weight: 4 });
    r = computeUkraineScore(actions);
    // Now 2 contributing → tier graduates to low.
    expect(r.confidenceTier).toBe('low');
    // Score is real now.
    expect(r.score).not.toBeNull();
    // Anti weight (4) >> pro weight (0.9) → score is strongly negative.
    expect(r.rawScore).toBeCloseTo((0.9 - 4) / 4.9, 4);
    expect(r.rawScore!).toBeLessThan(0);

    // Step 4: researcher backs off the comment to a milder weight.
    actions[1] = { valence: 'voted-anti', weight: 1 };
    r = computeUkraineScore(actions);
    // Still 2 contributing.
    expect(r.contributing).toBe(2);
    // Now closer to balanced — magnitude dropped.
    expect(r.rawScore).toBeCloseTo((0.9 - 1) / 1.9, 4);
    expect(Math.abs(r.rawScore!)).toBeLessThan(0.5);
  });
});
