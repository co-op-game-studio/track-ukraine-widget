/**
 * MemberChip — compact chip for the overview grid. Layout (UAT
 * 2026-04-19, US-7 AC-7.1 revised): name on top, photo in the middle,
 * chamber/subtitle + state + party below, arranged with
 * `justify-content: space-between` so tiles of different content lengths
 * line up at the top, middle, and bottom evenly ("no waving").
 *
 * Clicking the chip opens the full-width DetailPanel below the grid.
 *
 * Traces to: US-7 AC-7.1 (revised), AC-7.8, US-8, US-9 (design system).
 */
import { useState } from 'react';
import type { Representative } from '../types/domain';
import { sanitizeUrl } from '../utils/sanitizeUrl';
import { stateCodeToName } from '../utils/fipsMap';

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
  const base =
    rep.chamber === 'senate' ? 'U.S. Senator' :
    rep.isNonVoting ? 'Delegate (non-voting)' :
    rep.district == null ? 'U.S. Representative' :
    `District ${rep.district}`;
  return rep.yearEntered ? `${base} · since ${rep.yearEntered}` : base;
}

export function MemberChip({ representative, selected, onClick }: MemberChipProps) {
  const partyClass = partyCssClass(representative.partyAbbreviation);
  const partyUpper = representative.party.toUpperCase();
  const sanitizedUrl = sanitizeUrl(representative.photoUrl);
  // Broken-image fallback — if the browser fails to load the URL (404 /
  // expired CF asset / CORS block), swap to the placeholder so chips
  // never render as the browser's default broken-image glyph.
  const [imgFailed, setImgFailed] = useState(false);
  const showImage = sanitizedUrl && !imgFailed;

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
      {/* Top section: name sits above the photo so long names wrap with
          room to breathe instead of fighting the circular photo-frame. */}
      <div className="viw-chip-header">
        <div className="viw-chip-name">{representative.name}</div>
      </div>

      <div className="viw-chip-photo-wrap">
        {showImage ? (
          <img
            src={sanitizedUrl!}
            alt={representative.name}
            className="viw-chip-photo"
            loading="lazy"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="viw-chip-photo-placeholder" aria-hidden />
        )}
      </div>

      {/* Bottom section: chamber + state + party tag. `justify-content:
          space-between` on the chip root pins this to the bottom edge so
          short-name and long-name tiles share a common baseline. */}
      <div className="viw-chip-footer">
        <div className="viw-chip-subtitle">{subtitle(representative)}</div>
        <div className="viw-chip-state">
          {stateCodeToName(representative.state) ?? representative.state}
        </div>
        <div className={`viw-chip-party viw-chip-party-${partyClass}`}>{partyUpper}</div>
      </div>
    </button>
  );
}
