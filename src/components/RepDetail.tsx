/**
 * RepDetail — the full-width detail panel shown beneath the chip grid when a
 * member is selected. Always visible when rendered; collapse/expand is owned
 * by ResultsPanel.
 *
 * Traces to: US-2, US-3, US-4, US-5, US-7, US-8 (v2.2.0), US-9 (design).
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { Representative } from '../types/domain';
import { stateCodeToName } from '../utils/fipsMap';
import { useVotingRecord } from '../hooks/useVotingRecord';
import { useSponsoredBills } from '../hooks/useSponsoredBills';
import { useUkraineScore } from '../hooks/useUkraineScore';
import { useRepComments } from '../hooks/useRepComments';
import { useRepStatements } from '../hooks/useRepStatements';
import { useRepQuotes } from '../hooks/useRepQuotes';
import { VoteList } from './VoteList';
import { BillList } from './BillList';
import { StatementsList } from './StatementsList';
import { UkraineScoreBadge } from './UkraineScoreBadge';
import { sanitizeUrl } from '../utils/sanitizeUrl';
import { getEnvelopeFromError } from '../services/errorEnvelope';

export interface RepDetailProps {
  representative: Representative;
  apiBase: string;
  onClose: () => void;
}

type Tab = 'record' | 'statements';

function partyCssClass(abbr: string): string {
  if (abbr === 'D') return 'dem';
  if (abbr === 'R') return 'rep';
  return 'ind';
}

function chamberLabel(rep: Representative): string {
  if (rep.chamber === 'senate') return 'U.S. Senator';
  if (rep.isNonVoting) return 'U.S. Delegate (non-voting)';
  if (rep.district == null) return 'U.S. Representative';
  return `U.S. Representative · District ${rep.district}`;
}

/** FR-48: render socials as a row of icon-links beneath the Official
 *  Website button. Only present handles render; missing platforms are
 *  skipped entirely (AC-48.4). URLs pass through sanitizeUrl at the
 *  render boundary (AC-31.1). */
const SOCIAL_ICONS: Record<string, ReactElement> = {
  twitter: (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">
      <path d="M22.46 6c-.77.35-1.6.58-2.46.69.88-.53 1.56-1.37 1.88-2.38-.83.5-1.75.86-2.72 1.05C18.37 4.5 17.26 4 16 4c-2.35 0-4.27 1.92-4.27 4.29 0 .34.04.67.11.98C8.28 9.09 5.11 7.38 3 4.79c-.37.63-.58 1.37-.58 2.15 0 1.49.75 2.81 1.91 3.56-.71 0-1.37-.2-1.95-.5v.03c0 2.08 1.48 3.82 3.44 4.21a4.22 4.22 0 0 1-1.93.07 4.28 4.28 0 0 0 4 2.98 8.52 8.52 0 0 1-5.33 1.84c-.34 0-.68-.02-1.02-.06C3.44 20.29 5.7 21 8.12 21 16 21 20.33 14.46 20.33 8.79c0-.19 0-.37-.01-.56.84-.6 1.56-1.36 2.14-2.23z" />
    </svg>
  ),
  youtube: (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">
      <path d="M23 12s0-3.7-.5-5.4a2.8 2.8 0 0 0-2-2C18.8 4 12 4 12 4s-6.8 0-8.5.6a2.8 2.8 0 0 0-2 2C1 8.3 1 12 1 12s0 3.7.5 5.4a2.8 2.8 0 0 0 2 2c1.7.6 8.5.6 8.5.6s6.8 0 8.5-.6a2.8 2.8 0 0 0 2-2c.5-1.7.5-5.4.5-5.4zM10 15.5v-7l6 3.5-6 3.5z" />
    </svg>
  ),
};

function SocialsRow({ name, socials }: { name: string; socials?: Representative['socials'] }) {
  if (!socials) return null;
  const links: Array<{ platform: string; key: string; url: string }> = [];
  if (socials.twitter) {
    const url = sanitizeUrl(`https://twitter.com/${encodeURIComponent(socials.twitter)}`);
    if (url) links.push({ platform: 'Twitter', key: 'twitter', url });
  }
  if (socials.youtube) {
    const url = sanitizeUrl(`https://youtube.com/@${encodeURIComponent(socials.youtube)}`);
    if (url) links.push({ platform: 'YouTube', key: 'youtube', url });
  }
  if (links.length === 0) return null;
  return (
    <div className="viw-detail-socials" role="list" aria-label={`${name}'s social media accounts`}>
      {links.map(({ platform, key, url }) => (
        <a
          key={platform}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className={`viw-detail-social viw-detail-social-${key}`}
          aria-label={`${name} on ${platform}`}
          title={platform}
          role="listitem"
        >
          {SOCIAL_ICONS[key]}
        </a>
      ))}
    </div>
  );
}

export function RepDetail({ representative, apiBase, onClose }: RepDetailProps) {
  const [tab, setTab] = useState<Tab>('record');
  // Enrich the representative with profile data (photoUrl, website, district)
  // fetched from /api/members/{bioguideId}. This makes the name-search path
  // render the same rich card as the address path without the address flow
  // having to pass photoUrl through.
  const [enriched, setEnriched] = useState<Representative>(representative);
  // FR-55 AC-55.6 — party prior comes from `member:v1:{id}.partyPrior` and
  // is threaded into useUkraineScore for Bayesian shrink.
  const [partyPrior, setPartyPrior] = useState<number | null>(null);
  // Broken-image fallback — mirrors MemberChip. If Congress.gov's photo URL
  // 404s or is blocked, fall back to the placeholder instead of the
  // browser's default broken-image glyph.
  const [photoFailed, setPhotoFailed] = useState(false);
  useEffect(() => {
    setEnriched(representative);
    setPartyPrior(null);
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
        partyPrior?: number | null;
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
        if (typeof p.partyPrior === 'number') {
          setPartyPrior(p.partyPrior);
        }
      })
      .catch(() => { /* keep base representative if profile lookup fails */ });
    return () => { cancelled = true; };
  }, [representative, apiBase]);
  const votingRecord = useVotingRecord(enriched, apiBase);
  const bills = useSponsoredBills(enriched.bioguideId, apiBase);
  const score = useUkraineScore(votingRecord.data, bills.data, { partyPrior });

  // V4: collect every bill_id appearing in this rep's surfaces — votes
  // (cluster.primary.bill) + sponsored / cosponsored — and feed them into
  // useRepComments so VoteList can render comment-expand affordances on
  // matching rows. Stable string-derived dep so a re-render doesn't refetch.
  const billIds = useMemo(() => {
    const set = new Set<string>();
    for (const c of votingRecord.data?.clusters ?? []) {
      const b = c.primary.bill;
      set.add(`${b.congress}-${b.type}-${b.number}`);
    }
    for (const b of bills.data?.sponsored ?? []) {
      set.add(`${b.curated.congress}-${b.curated.type}-${b.curated.number}`);
    }
    for (const b of bills.data?.cosponsored ?? []) {
      set.add(`${b.curated.congress}-${b.curated.type}-${b.curated.number}`);
    }
    return [...set];
  }, [votingRecord.data, bills.data]);
  const repComments = useRepComments(billIds, apiBase);
  const statements = useRepStatements(enriched.bioguideId, apiBase);
  const quotes = useRepQuotes(enriched.bioguideId, apiBase);

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
              {enriched.yearEntered != null && (
                <span className="viw-detail-since">Serving since {enriched.yearEntered}</span>
              )}
            </div>
            <div className="viw-detail-links-row">
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
              <SocialsRow name={enriched.name} socials={enriched.socials} />
            </div>
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
          loading={votingRecord.status === 'loading'}
        />
      )}

      <nav className="viw-detail-tabs" role="tablist">
        <button
          role="tab"
          type="button"
          aria-selected={tab === 'record'}
          className={`viw-detail-tab ${tab === 'record' ? 'active' : ''}`}
          onClick={() => setTab('record')}
        >
          Record
        </button>
        <button
          role="tab"
          type="button"
          aria-selected={tab === 'statements'}
          className={`viw-detail-tab ${tab === 'statements' ? 'active' : ''}`}
          onClick={() => setTab('statements')}
        >
          Statements
        </button>
      </nav>

      <div className="viw-detail-body">
        {tab === 'record' && (
          <>
            {/* AC-53.2 (revised) — legislation renders ABOVE voting record. */}
            <h4 className="viw-detail-section-heading">Ukraine legislation</h4>
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
            <h4 className="viw-detail-section-heading">Ukraine voting record</h4>
            {enriched.isNonVoting && enriched.chamber === 'house' ? (
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
                commentsByBill={repComments.commentsByBill}
              />
            )}
          </>
        )}
        {tab === 'statements' && (
          <StatementsList
            posts={statements.posts}
            quotes={quotes.quotes}
            loading={
              statements.status === 'loading' || quotes.status === 'loading'
            }
          />
        )}
      </div>
    </section>
  );
}
