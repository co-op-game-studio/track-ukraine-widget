/**
 * RepDetail — the full-width detail panel shown beneath the chip grid when a
 * member is selected. Always visible when rendered; collapse/expand is owned
 * by ResultsPanel.
 *
 * Traces to: US-2, US-3, US-4, US-5, US-7, US-8 (v2.2.0), US-9 (design).
 */
import { useEffect, useState } from 'react';
import type { Representative } from '../types/domain';
import { stateCodeToName } from '../utils/fipsMap';
import { useVotingRecord } from '../hooks/useVotingRecord';
import { useSponsoredBills } from '../hooks/useSponsoredBills';
import { useUkraineScore } from '../hooks/useUkraineScore';
import { VoteList } from './VoteList';
import { BillList } from './BillList';
import { UkraineScoreBadge } from './UkraineScoreBadge';
import { sanitizeUrl } from '../utils/sanitizeUrl';
import { getEnvelopeFromError } from '../services/errorEnvelope';

export interface RepDetailProps {
  representative: Representative;
  apiBase: string;
  onClose: () => void;
}

type Tab = 'votes' | 'bills';

function partyCssClass(abbr: string): string {
  if (abbr === 'D') return 'dem';
  if (abbr === 'R') return 'rep';
  return 'ind';
}

function chamberLabel(rep: Representative): string {
  const base =
    rep.chamber === 'senate' ? 'U.S. Senator' :
    rep.isNonVoting ? 'U.S. Delegate (non-voting)' :
    rep.district == null ? 'U.S. Representative' :
    `U.S. Representative · District ${rep.district}`;
  return rep.yearEntered ? `${base} · since ${rep.yearEntered}` : base;
}

export function RepDetail({ representative, apiBase, onClose }: RepDetailProps) {
  const [tab, setTab] = useState<Tab>('votes');
  // Enrich the representative with profile data (photoUrl, website, district)
  // fetched from /api/members/{bioguideId}. This makes the name-search path
  // render the same rich card as the address path without the address flow
  // having to pass photoUrl through.
  const [enriched, setEnriched] = useState<Representative>(representative);
  // Broken-image fallback — mirrors MemberChip. If Congress.gov's photo URL
  // 404s or is blocked, fall back to the placeholder instead of the
  // browser's default broken-image glyph.
  const [photoFailed, setPhotoFailed] = useState(false);
  useEffect(() => {
    setEnriched(representative);
    setPhotoFailed(false);
    const base = apiBase.replace(/\/+$/, '');
    let cancelled = false;
    fetch(`${base}/api/members/${encodeURIComponent(enriched.bioguideId)}`)
      .then(async (r) => (r.ok ? r.json() : null))
      .then((p: {
        photoUrl?: string | null;
        website?: string | null;
        district?: number | null;
        officialName?: string;
        yearEntered?: number;
      } | null) => {
        if (!p || cancelled) return;
        // AC-31.1: every URL sourced from /api/members/{id} passes through
        // sanitizeUrl before entering state. Blocks javascript:, data:, etc.
        // at the API boundary so downstream render sites can trust the field.
        const safePhoto = sanitizeUrl(p.photoUrl);
        const safeWebsite = sanitizeUrl(p.website);
        setEnriched((curr) => ({
          ...curr,
          photoUrl: curr.photoUrl ?? safePhoto ?? null,
          officialWebsiteUrl: curr.officialWebsiteUrl ?? safeWebsite ?? null,
          district: curr.district ?? p.district ?? null,
          name: curr.name || p.officialName || curr.name,
          yearEntered: curr.yearEntered ?? p.yearEntered,
        }));
      })
      .catch(() => { /* keep base representative if profile lookup fails */ });
    return () => { cancelled = true; };
  }, [representative, apiBase]);
  const votingRecord = useVotingRecord(enriched, apiBase);
  const bills = useSponsoredBills(enriched.bioguideId, apiBase);
  const score = useUkraineScore(votingRecord.data, bills.data);

  useEffect(() => {
    // Auto-load on mount (or when member switches)
    if (!(enriched.isNonVoting && enriched.chamber === 'house') && votingRecord.status === 'idle') {
      votingRecord.load();
    }
    if (bills.status === 'idle') {
      bills.load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enriched.bioguideId]);

  const stateName = stateCodeToName(enriched.state) ?? enriched.state;
  const partyClass = partyCssClass(enriched.partyAbbreviation);

  const obstructionCount =
    (votingRecord.data?.obstructionCount ?? 0)
    + (bills.data?.sponsored.filter((b) => b.valence === 'sponsor-anti').length ?? 0)
    + (bills.data?.cosponsored.filter((b) => b.valence === 'sponsor-anti').length ?? 0);

  return (
    <section
      className={`viw-detail viw-detail-${partyClass}`}
      aria-labelledby={`viw-detail-name-${enriched.bioguideId}`}
    >
      <header className="viw-detail-header">
        <div className="viw-detail-identity">
          {sanitizeUrl(enriched.photoUrl) && !photoFailed ? (
            <img
              src={sanitizeUrl(enriched.photoUrl)!}
              alt=""
              className="viw-detail-photo"
              loading="lazy"
              onError={() => setPhotoFailed(true)}
            />
          ) : (
            <div className="viw-detail-photo viw-detail-photo-placeholder" aria-hidden />
          )}
          <div className="viw-detail-ident-text">
            <h3 id={`viw-detail-name-${enriched.bioguideId}`} className="viw-detail-name">
              {enriched.name}
            </h3>
            <div className="viw-detail-meta">
              <span className={`viw-detail-party viw-detail-party-${partyClass}`}>
                {enriched.party.toUpperCase()}
              </span>
              <span className="viw-detail-state">{stateName}</span>
              <span className="viw-detail-chamber">{chamberLabel(enriched)}</span>
            </div>
            {sanitizeUrl(enriched.officialWebsiteUrl) && (
              <a
                href={sanitizeUrl(enriched.officialWebsiteUrl)!}
                target="_blank"
                rel="noopener noreferrer"
                className="viw-detail-link"
              >
                Official website ↗
              </a>
            )}
          </div>
        </div>
        <button type="button" className="viw-detail-close" onClick={onClose} aria-label="Close detail panel">
          ✕
        </button>
      </header>

      {!enriched.isNonVoting && (
        <UkraineScoreBadge
          score={score}
          voting={votingRecord.data}
          bills={bills.data}
          obstructionCount={obstructionCount}
          primaryAbstentionCount={votingRecord.data?.primaryAbstentionCount ?? 0}
          loading={votingRecord.status === 'loading' || bills.status === 'loading'}
        />
      )}

      <nav className="viw-detail-tabs" role="tablist">
        <button
          role="tab"
          type="button"
          aria-selected={tab === 'votes'}
          className={`viw-detail-tab ${tab === 'votes' ? 'active' : ''}`}
          onClick={() => setTab('votes')}
          disabled={enriched.isNonVoting && enriched.chamber === 'house'}
        >
          Ukraine Votes
        </button>
        <button
          role="tab"
          type="button"
          aria-selected={tab === 'bills'}
          className={`viw-detail-tab ${tab === 'bills' ? 'active' : ''}`}
          onClick={() => setTab('bills')}
        >
          Ukraine Legislation
        </button>
      </nav>

      <div className="viw-detail-body">
        {tab === 'votes' &&
          (enriched.isNonVoting && enriched.chamber === 'house' ? (
            <div className="viw-detail-nonvoting">Non-voting delegate — no floor vote record.</div>
          ) : (
            <VoteList
              clusters={votingRecord.data?.clusters ?? []}
              loading={votingRecord.status === 'loading'}
              error={(() => {
                const env = votingRecord.error ? getEnvelopeFromError(votingRecord.error) : null;
                return env?.userMessage ?? votingRecord.error?.message ?? null;
              })()}
              errorTraceId={(() => {
                const env = votingRecord.error ? getEnvelopeFromError(votingRecord.error) : null;
                return env?.traceId;
              })()}
              errorOnRetry={(() => {
                const env = votingRecord.error ? getEnvelopeFromError(votingRecord.error) : null;
                return env?.retryable ? () => votingRecord.load() : undefined;
              })()}
            />
          ))}
        {tab === 'bills' && (
          <BillList
            sponsored={bills.data?.sponsored ?? []}
            cosponsored={bills.data?.cosponsored ?? []}
            loading={bills.status === 'loading'}
            error={(() => {
              const env = bills.error ? getEnvelopeFromError(bills.error) : null;
              return env?.userMessage ?? bills.error?.message ?? null;
            })()}
            errorTraceId={(() => {
              const env = bills.error ? getEnvelopeFromError(bills.error) : null;
              return env?.traceId;
            })()}
            errorOnRetry={(() => {
              const env = bills.error ? getEnvelopeFromError(bills.error) : null;
              return env?.retryable ? () => bills.load() : undefined;
            })()}
          />
        )}
      </div>
    </section>
  );
}
