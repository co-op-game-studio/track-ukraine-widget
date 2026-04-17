/**
 * ResultsPanel — v2.2.0 chip grid:
 *
 *   ┌────────────────────────┬────────────────────────┐
 *   │ SENATORS               │ REPRESENTATIVE         │
 *   │ [chip] [chip]          │ [chip]                 │
 *   └────────────────────────┴────────────────────────┘
 *   ┌──────────────────────────────────────────────────┐
 *   │ (detail panel for the selected member, if any)   │
 *   └──────────────────────────────────────────────────┘
 *
 * Only one detail panel is open at a time. Click a chip to open; click again
 * to close; click another chip to switch.
 *
 * Traces to: US-1 (AC-1.3), US-7/US-8/US-9 (v2.2.0), T-020
 */
import { useState } from 'react';
import type { LookupResult, Representative } from '../types/domain';
import { MemberChip } from './MemberChip';
import { RepDetail } from './RepDetail';
import { stateCodeToName } from '../utils/fipsMap';

export interface ResultsPanelProps {
  result: LookupResult;
  apiBase: string;
}

export function ResultsPanel({ result, apiBase }: ResultsPanelProps) {
  const stateName = stateCodeToName(result.state) ?? result.state;

  const [openId, setOpenId] = useState<string | null>(null);

  const toggle = (bioguideId: string) => {
    setOpenId((curr) => (curr === bioguideId ? null : bioguideId));
  };

  const senators: Representative[] = result.representatives
    .filter((r) => r.chamber === 'senate')
    .sort((a, b) => a.name.localeCompare(b.name));

  const houseReps: Representative[] = result.representatives.filter((r) => r.chamber === 'house');
  const selected = result.representatives.find((r) => r.bioguideId === openId) ?? null;

  if (result.representatives.length === 0) {
    return (
      <div className="viw-results-empty" role="status">
        No current federal representatives were found for your district.
      </div>
    );
  }

  return (
    <section className="viw-results" aria-label="Your federal representatives">
      <h2 className="viw-results-heading">
        <span className="viw-results-heading-state">{stateName}</span>
        {result.district > 0 && (
          <span className="viw-results-heading-district">Congressional District {result.district}</span>
        )}
      </h2>

      <div className="viw-chipgrid">
        {/* LEFT: senators */}
        <div className="viw-chipgrid-col viw-chipgrid-col-senators">
          <div className="viw-chipgrid-colhead">Senators</div>
          <div className="viw-chipgrid-row">
            {senators.length === 0 && (
              <div className="viw-chip viw-chip-vacant">
                <div className="viw-chip-photo viw-chip-photo-placeholder" aria-hidden />
                <div className="viw-chip-name">Seat vacant</div>
              </div>
            )}
            {senators.map((sen) => (
              <MemberChip
                key={sen.bioguideId}
                representative={sen}
                selected={openId === sen.bioguideId}
                onClick={() => toggle(sen.bioguideId)}
              />
            ))}
          </div>
        </div>

        {/* RIGHT: house rep */}
        <div className="viw-chipgrid-col viw-chipgrid-col-house">
          <div className="viw-chipgrid-colhead">Representative</div>
          <div className="viw-chipgrid-row">
            {houseReps.length === 0 && (
              <div className="viw-chip viw-chip-vacant">
                <div className="viw-chip-photo viw-chip-photo-placeholder" aria-hidden />
                <div className="viw-chip-name">Seat vacant</div>
              </div>
            )}
            {houseReps.map((rep) => (
              <MemberChip
                key={rep.bioguideId}
                representative={rep}
                selected={openId === rep.bioguideId}
                onClick={() => toggle(rep.bioguideId)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Full-width detail panel */}
      <div
        className={`viw-detail-slot ${selected ? 'viw-detail-slot-open' : ''}`}
        aria-live="polite"
      >
        {selected && (
          <RepDetail
            key={selected.bioguideId}
            representative={selected}
            apiBase={apiBase}
            onClose={() => setOpenId(null)}
          />
        )}
      </div>
    </section>
  );
}
