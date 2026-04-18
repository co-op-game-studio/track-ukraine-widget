/**
 * MemberChip — compact circle-photo + name chip for the overview grid.
 * Clicking the chip opens the full-width DetailPanel below the grid.
 *
 * Traces to: US-7 (v2.2.0) AC-7.1–7.7, US-8, US-9 (design system).
 */
import type { Representative } from '../types/domain';
import { sanitizeUrl } from '../utils/sanitizeUrl';

export interface MemberChipProps {
  representative: Representative;
  selected: boolean;
  onClick: () => void;
}

function partyCssClass(abbr: string): string {
  if (abbr === 'D') return 'dem';
  if (abbr === 'R') return 'rep';
  return 'ind';
}

function subtitle(rep: Representative): string {
  if (rep.chamber === 'senate') return 'U.S. Senator';
  if (rep.isNonVoting) return 'Delegate (non-voting)';
  return `District ${rep.district}`;
}

export function MemberChip({ representative, selected, onClick }: MemberChipProps) {
  const partyClass = partyCssClass(representative.partyAbbreviation);
  const partyUpper = representative.party.toUpperCase();

  return (
    <button
      type="button"
      className={[
        'viw-chip',
        `viw-chip-${partyClass}`,
        selected ? 'viw-chip-selected' : '',
      ].filter(Boolean).join(' ')}
      onClick={onClick}
      aria-pressed={selected}
    >
      <div className="viw-chip-photo-wrap">
        {sanitizeUrl(representative.photoUrl) ? (
          <img
            src={sanitizeUrl(representative.photoUrl)!}
            alt={representative.name}
            className="viw-chip-photo"
            loading="lazy"
          />
        ) : (
          <div className="viw-chip-photo-placeholder" aria-hidden />
        )}
      </div>
      <div className="viw-chip-name">{representative.name}</div>
      <div className="viw-chip-subtitle">{subtitle(representative)}</div>
      <div className={`viw-chip-party viw-chip-party-${partyClass}`}>{partyUpper}</div>
    </button>
  );
}
