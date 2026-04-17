/**
 * PartyAlignmentBadge — visual indicator of party alignment percentage.
 * Traces to: US-5 (AC-5.1 through AC-5.4), T-018
 */
import type { PartyAlignment } from '../types/domain';
import { formatPercentage } from '../utils/formatters';

export interface PartyAlignmentBadgeProps {
  alignment: PartyAlignment;
  party: string;
}

export function PartyAlignmentBadge({ alignment, party }: PartyAlignmentBadgeProps) {
  if (alignment.score === null) {
    return (
      <div className="viw-alignment viw-alignment-na">
        <span className="viw-alignment-label">Party alignment</span>
        <span className="viw-alignment-value">N/A</span>
        <span className="viw-alignment-context">
          {alignment.totalPartyLineVotes === 0
            ? 'No party-line votes in sample'
            : 'Member has no major-party affiliation'}
        </span>
      </div>
    );
  }

  const pct = Math.round(alignment.score);
  return (
    <div
      className={`viw-alignment viw-alignment-${partyCssClass(party)}`}
      aria-label={`Party alignment: ${pct}% with ${party} party`}
    >
      <div className="viw-alignment-header">
        <span className="viw-alignment-label">Party alignment</span>
        <span className="viw-alignment-value">{formatPercentage(alignment.score)}</span>
      </div>
      <div
        className="viw-alignment-bar"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="viw-alignment-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="viw-alignment-context">
        Based on {alignment.totalPartyLineVotes} party-line vote
        {alignment.totalPartyLineVotes === 1 ? '' : 's'}
        {' · '}
        voted with party {alignment.votesWithParty} time
        {alignment.votesWithParty === 1 ? '' : 's'}
      </span>
    </div>
  );
}

function partyCssClass(party: string): string {
  if (party.startsWith('D')) return 'dem';
  if (party.startsWith('R')) return 'rep';
  return 'ind';
}
