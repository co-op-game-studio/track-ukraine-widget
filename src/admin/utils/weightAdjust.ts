/**
 * FR-64 — pure weight-adjustment math for the bulk weight tuner.
 *
 * Kept pure + dependency-free so the math is unit-tested in isolation (AC-64.6)
 * and the view stays presentational.
 */

export type AdjustMode = 'multiply' | 'linear';

/** Vote weight domain (FR-54): [0, 5], two decimals. */
export const WEIGHT_MIN = 0;
export const WEIGHT_MAX = 5;

/** Clamp to [0,5] and round to 2 decimals. */
export function clampWeight(w: number): number {
  const clamped = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, w));
  return Math.round(clamped * 100) / 100;
}

/**
 * Compute the adjusted weight. `multiply`: old × amount (amount > 0).
 * `linear`: old + amount (amount may be negative). Result clamped + rounded.
 */
export function computeWeight(current: number, mode: AdjustMode, amount: number): number {
  const raw = mode === 'multiply' ? current * amount : current + amount;
  return clampWeight(raw);
}

/** True when the computed weight differs from the current (i.e. a real change). */
export function isWeightChange(current: number, computed: number): boolean {
  return clampWeight(current) !== computed;
}
