/**
 * UkraineScoreBadge — the red→yellow→green score badge.
 * Traces to: FR-16.
 */
import type { UkraineScore } from '../services/ukraineScore';
import { scoreToCssColor } from '../services/ukraineScore';

export interface UkraineScoreBadgeProps {
  score: UkraineScore | null;
  /** Total obstruction events (procedural anti-UA + anti-UA sponsorships). */
  obstructionCount?: number;
  /** FR-23 AC-23.5: abstentions on primary-weight pro-UA votes. Surfaced
   *  in the badge context when ≥ ABSTENTION_DISPLAY_THRESHOLD. */
  primaryAbstentionCount?: number;
  loading?: boolean;
}

/** Show the abstention callout once a member has abstained on at least this
 *  many primary-weight pro-UA votes. Below this, it's within the noise band. */
const ABSTENTION_DISPLAY_THRESHOLD = 3;

function scoreLabel(value: number, lowConfidence: boolean): string {
  // Low-confidence scores never reach the strong-support/strong-oppose bands.
  if (lowConfidence) {
    if (value > 0.25) return 'Limited record — leans supportive';
    if (value < -0.25) return 'Limited record — leans opposed';
    return 'Limited record';
  }
  if (value >= 0.75) return 'Strong supporter';
  if (value >= 0.35) return 'Supporter';
  if (value >= 0.1) return 'Leaning supportive';
  if (value > -0.1) return 'Mixed';
  if (value > -0.35) return 'Leaning opposed';
  if (value > -0.75) return 'Opposed';
  return 'Strongly opposed';
}

export function UkraineScoreBadge({
  score,
  obstructionCount = 0,
  primaryAbstentionCount = 0,
  loading = false,
}: UkraineScoreBadgeProps) {
  if (loading) {
    return (
      <div className="viw-score viw-score-loading">
        <div className="viw-score-header">
          <span className="viw-score-title">Ukraine Support Score</span>
          <span className="viw-score-value">…</span>
        </div>
        <div className="viw-score-bar" />
      </div>
    );
  }

  if (!score || score.score === null) {
    return (
      <div className="viw-score viw-score-na">
        <div className="viw-score-header">
          <span className="viw-score-title">Ukraine Support Score</span>
          <span className="viw-score-value">N/A</span>
        </div>
        <div className="viw-score-context">
          No curated Ukraine votes or sponsorships found for this member yet.
        </div>
      </div>
    );
  }

  const pct = ((score.score + 1) / 2) * 100; // 0..100 for the gradient-bar position
  const color = scoreToCssColor(score.score);
  const label = scoreLabel(score.score, score.lowConfidence);
  const signed = (score.score >= 0 ? '+' : '') + score.score.toFixed(2);

  return (
    <div className="viw-score">
      <div className="viw-score-header">
        <span className="viw-score-title">Ukraine Support Score</span>
        <span className="viw-score-value" style={{ color }} title={label}>
          {signed}
        </span>
      </div>
      <div
        className="viw-score-bar"
        role="progressbar"
        aria-valuenow={Math.round(score.score * 100)}
        aria-valuemin={-100}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className="viw-score-bar-track">
          <div
            className="viw-score-bar-marker"
            style={{ left: `${pct}%`, background: color }}
          />
        </div>
        <div className="viw-score-bar-scale">
          <span>Opposed</span>
          <span>Mixed</span>
          <span>Supportive</span>
        </div>
      </div>
      <div className="viw-score-context">
        <strong>{label}</strong> · Based on {score.contributing} counted action
        {score.contributing === 1 ? '' : 's'}
        {score.total > score.contributing && ` (${score.total - score.contributing} excluded: unstated, procedural, or neutral)`}
      </div>
      {obstructionCount >= 2 && (
        <div className="viw-score-obstruction-note" role="note">
          Includes <strong>{obstructionCount}</strong> obstruction event
          {obstructionCount === 1 ? '' : 's'} — procedural anti-Ukraine votes
          or anti-Ukraine sponsorships.
        </div>
      )}
      {primaryAbstentionCount >= ABSTENTION_DISPLAY_THRESHOLD && (
        <div className="viw-score-abstention-note" role="note">
          Abstained on <strong>{primaryAbstentionCount}</strong> primary-weight
          Ukraine vote{primaryAbstentionCount === 1 ? '' : 's'} — the member was
          in office for {primaryAbstentionCount === 1 ? 'this vote' : 'these votes'}{' '}
          but cast no ballot.
        </div>
      )}
    </div>
  );
}
