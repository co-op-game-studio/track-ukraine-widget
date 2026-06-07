/** FR-64 AC-64.6 — weight-adjustment math. */
import { describe, it, expect } from 'vitest';
import { computeWeight, clampWeight, isWeightChange } from '../../src/admin/utils/weightAdjust';

describe('FR-64 weightAdjust', () => {
  it('AC-64.2: multiply mode = old × k', () => {
    expect(computeWeight(1.0, 'multiply', 1.2)).toBe(1.2);
    expect(computeWeight(0.45, 'multiply', 2)).toBe(0.9);
  });

  it('AC-64.2: linear mode = old + d (d may be negative)', () => {
    expect(computeWeight(1.0, 'linear', 0.5)).toBe(1.5);
    expect(computeWeight(1.0, 'linear', -0.3)).toBe(0.7);
  });

  it('AC-64.2: clamps to [0,5]', () => {
    expect(computeWeight(4.0, 'multiply', 2)).toBe(5); // 8 → 5
    expect(computeWeight(0.2, 'linear', -1)).toBe(0);  // -0.8 → 0
  });

  it('AC-64.2: rounds to 2 decimals', () => {
    expect(computeWeight(0.333, 'multiply', 1.1)).toBe(0.37); // 0.3663 → 0.37
    expect(clampWeight(1.006)).toBe(1.01);
    expect(clampWeight(1.004)).toBe(1);
  });

  it('AC-64.3: isWeightChange detects no-ops', () => {
    expect(isWeightChange(1.0, computeWeight(1.0, 'multiply', 1))).toBe(false);
    expect(isWeightChange(1.0, computeWeight(1.0, 'linear', 0))).toBe(false);
    expect(isWeightChange(1.0, computeWeight(1.0, 'multiply', 1.2))).toBe(true);
    // clamped no-op: 5.0 × 2 = 5.0 (already at max) → no change
    expect(isWeightChange(5.0, computeWeight(5.0, 'multiply', 2))).toBe(false);
  });
});
