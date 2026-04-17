/**
 * Ukraine Support Score — a single number in [-1, +1] summarizing a member's
 * Ukraine stance based on weighted votes and sponsorships.
 *
 * See docs/design.md §4.10. Traces to: FR-16.
 *
 * Design notes (v2.1.1):
 *   - Procedural votes (weight ≤ PROCEDURAL_THRESHOLD) are EXCLUDED from the
 *     score. Their pro/anti direction is ambiguous (aye-on-motion-to-table
 *     can mean either direction depending on what's being tabled), so counting
 *     them would add noise without signal. They still appear in the UI for
 *     transparency but don't contribute to the score.
 *   - LOW_CONFIDENCE_THRESHOLD: members with very few contributing actions get
 *     flagged so we don't call someone "Strong supporter" from one vote.
 */
import {
  type Valence,
  VALENCE_SIGN,
  VALENCE_AMPLIFIER,
} from './valence';

/** Votes at or below this weight don't contribute to the score.
 *  v2.1.2: the curator now assigns weight === 0 for ambiguous procedurals
 *  (motion-to-table, motion-to-reconsider) and meaningful weights to directional
 *  procedurals (cloture=0.45, motion-to-proceed=0.3, motion-to-recommit=0.3),
 *  so we only need to exclude zero-weight entries. */
export const PROCEDURAL_THRESHOLD = 0;

/** Fewer than this many contributing actions = low confidence. */
export const LOW_CONFIDENCE_THRESHOLD = 3;

export interface ScoreInput {
  valence: Valence;
  /** Weight in [0, 1] — from the curated JSON for votes, or 1.0 for sponsorship. */
  weight: number;
}

export interface UkraineScore {
  /** Normalized score in [-1, +1], or null if no signed contributions. */
  score: number | null;
  /** Count of actions that contributed (excludes unstated + procedural). */
  contributing: number;
  /** Count of actions considered (including those excluded). */
  total: number;
  /**
   * True when contributing < LOW_CONFIDENCE_THRESHOLD. The UI should
   * de-emphasize the score label in this case (e.g., always say "Limited record").
   */
  lowConfidence: boolean;
}

export function computeUkraineScore(actions: ScoreInput[]): UkraineScore {
  let numerator = 0;
  let denominator = 0;
  let contributing = 0;

  for (const a of actions) {
    const sign = VALENCE_SIGN[a.valence];
    const amp = VALENCE_AMPLIFIER[a.valence];
    if (sign === 0 || amp === 0) continue;

    // Exclude procedural votes — they add noise without clean directional signal.
    // Sponsorships come in with weight 1.0 so they're never excluded here.
    if (a.weight <= PROCEDURAL_THRESHOLD) continue;

    const magnitude = amp * a.weight;
    if (magnitude === 0) continue;
    numerator += sign * magnitude;
    denominator += magnitude;
    contributing++;
  }

  const score = denominator === 0 ? null : numerator / denominator;
  return {
    score,
    contributing,
    total: actions.length,
    lowConfidence: contributing > 0 && contributing < LOW_CONFIDENCE_THRESHOLD,
  };
}

/**
 * Map a score in [-1, +1] to a hue on a red→yellow→green gradient.
 * -1 → red (0°), 0 → yellow (60°), +1 → green (120°).
 */
export function scoreToCssColor(
  score: number | null,
  opts: { lightness?: number; saturation?: number } = {},
): string {
  if (score === null) return 'hsl(220, 10%, 55%)';
  const clamped = Math.max(-1, Math.min(1, score));
  const hue = 60 * (clamped + 1);
  const saturation = opts.saturation ?? 75;
  const lightness = opts.lightness ?? 42;
  return `hsl(${hue.toFixed(1)}, ${saturation}%, ${lightness}%)`;
}
