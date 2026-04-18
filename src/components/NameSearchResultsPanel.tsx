/**
 * NameSearchResultsPanel — single-pane tile grid of members matching a name query.
 *
 * Mirrors ResultsPanel visually (MemberChip grid + RepDetail slot) but with one
 * unified chip row instead of the Senators/Representative split.
 *
 * Traces to: FR-31, ADR-011.
 */
import { useState } from 'react';
import type { Representative } from '../types/domain';
import type { NameSearchResult } from '../hooks/useNameSearch';
import type { NameSearchStatus } from '../hooks/useNameSearch';
import { MemberChip } from './MemberChip';
import { RepDetail } from './RepDetail';
import { sanitizeUrl } from '../utils/sanitizeUrl';

function resultToRepresentative(r: NameSearchResult): Representative {
  return {
    bioguideId: r.bioguideId,
    // useVotingRecord parses name as "Last, First" to pull a last-name key
    // for Senate roster matching (senateVotesApi matches on last+state).
    // The display pipeline (RepDetail, MemberChip) also renders this string
    // as-is in headers — "Durbin, Richard" is the canonical Congress.gov form.
    name: `${r.last}, ${r.first}`,
    party:
      r.party === 'D' ? 'Democratic' :
      r.party === 'R' ? 'Republican' :
      r.party === 'I' ? 'Independent' : r.party,
    partyAbbreviation: r.party,
    state: r.state,
    district: r.district ?? null,
    chamber: r.chamber.toLowerCase() as 'house' | 'senate',
    // AC-31.1: photoUrl from KV-backed name-search is sanitized at this
    // boundary so MemberChip can trust the field.
    photoUrl: sanitizeUrl(r.photoUrl),
    isNonVoting: false,
    officialWebsiteUrl: null,
  };
}

export interface NameSearchResultsPanelProps {
  query: string;
  results: NameSearchResult[];
  truncated: boolean;
  status: NameSearchStatus;
  error: string | null;
  apiBase: string;
}

export function NameSearchResultsPanel({
  query, results, truncated, status, error, apiBase,
}: NameSearchResultsPanelProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const trimmed = query.trim();

  if (trimmed.length < 2) return null;

  if (status === 'unavailable') {
    return (
      <section className="viw-results" aria-live="polite">
        <div className="viw-name-search-hint" role="status">
          {error ?? 'Name search temporarily unavailable — try address lookup.'}
        </div>
      </section>
    );
  }

  if (status === 'error' && error) {
    return (
      <section className="viw-results" aria-live="polite">
        <div className="viw-name-search-hint" role="status">Search error: {error}</div>
      </section>
    );
  }

  if (status === 'success' && results.length === 0) {
    return (
      <section className="viw-results" aria-live="polite">
        <div className="viw-results-empty" role="status">
          No current members match &ldquo;{trimmed}&rdquo;.
        </div>
      </section>
    );
  }

  const reps = results.map(resultToRepresentative);
  const selected = reps.find((r) => r.bioguideId === openId) ?? null;
  const toggle = (id: string) => setOpenId((curr) => (curr === id ? null : id));

  return (
    <section className="viw-results" aria-label="Name search matches">
      <div className="viw-chipgrid viw-chipgrid-single">
        <div className="viw-chipgrid-col">
          <div className="viw-chipgrid-colhead">
            {status === 'loading' ? 'Searching…' : 'Matches'}
          </div>
          <div className="viw-chipgrid-row">
            {reps.map((r) => (
              <MemberChip
                key={r.bioguideId}
                representative={r}
                selected={openId === r.bioguideId}
                onClick={() => toggle(r.bioguideId)}
              />
            ))}
          </div>
          {truncated && (
            <div className="viw-name-search-truncated-note">
              Showing top 10 — refine your search
            </div>
          )}
        </div>
      </div>

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
