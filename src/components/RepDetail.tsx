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
  facebook: (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">
      <path d="M22 12a10 10 0 1 0-11.6 9.9v-7H7.9V12h2.5V9.8c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.5h-1.3c-1.2 0-1.6.8-1.6 1.6V12h2.8l-.5 2.9h-2.4v7A10 10 0 0 0 22 12z" />
    </svg>
  ),
  instagram: (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">
      <path d="M12 2.2c3.2 0 3.6 0 4.85.07 1.17.05 1.8.25 2.23.42.56.22.96.48 1.38.9.42.42.68.82.9 1.38.17.42.37 1.06.42 2.23.06 1.25.07 1.62.07 4.8s0 3.55-.07 4.8c-.05 1.17-.25 1.8-.42 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.17-1.06.37-2.23.42-1.25.06-1.62.07-4.8.07s-3.55 0-4.8-.07c-1.17-.05-1.8-.25-2.23-.42a3.7 3.7 0 0 1-1.38-.9 3.7 3.7 0 0 1-.9-1.38c-.17-.42-.37-1.06-.42-2.23C2.2 15.55 2.2 15.18 2.2 12s0-3.55.07-4.8c.05-1.17.25-1.8.42-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.17 1.06-.37 2.23-.42C8.45 2.2 8.82 2.2 12 2.2zm0 2A26.6 26.6 0 0 0 7.3 4.3a3 3 0 0 0-1.04.7 3 3 0 0 0-.7 1.04A26.6 26.6 0 0 0 4.3 12a26.6 26.6 0 0 0 .26 4.7 3 3 0 0 0 .7 1.04 3 3 0 0 0 1.04.7 26.6 26.6 0 0 0 4.7.26 26.6 26.6 0 0 0 4.7-.26 3 3 0 0 0 1.04-.7 3 3 0 0 0 .7-1.04 26.6 26.6 0 0 0 .26-4.7 26.6 26.6 0 0 0-.26-4.7 3 3 0 0 0-.7-1.04 3 3 0 0 0-1.04-.7A26.6 26.6 0 0 0 12 4.2zm0 3a4.8 4.8 0 1 1 0 9.6 4.8 4.8 0 0 1 0-9.6zm0 1.9a2.9 2.9 0 1 0 0 5.8 2.9 2.9 0 0 0 0-5.8zm5-2.4a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2z" />
    </svg>
  ),
  threads: (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">
      <path d="M12.2 22h-.05C8.92 22 6.45 20.86 5 18.6c-1.34-2.05-1.4-4.96-.18-7.94 1.1-2.7 3.04-4.78 5.65-6.06 1.66-.82 3.5-1.27 5.4-1.27.62 0 1.27.05 1.94.16 1.4.21 2.6.92 3.43 2.04.56.74.96 1.7 1.18 2.83l-1.93.43c-.32-1.45-1.05-2.42-2.18-2.83-.46-.16-1.05-.27-1.7-.27-1.34 0-2.55.31-3.66.95-1.32.76-2.34 1.94-3 3.5C9.07 11.4 9 13.7 10.06 15.6c.7 1.27 1.94 2.04 3.62 2.04 1.43 0 2.6-.55 3.43-1.66.46-.6.76-1.32.92-2.13l1.94.32c-.21 1.16-.7 2.2-1.43 3.07-.86 1.05-2.13 1.84-3.7 2.32a8.86 8.86 0 0 1-2.65.44z" />
    </svg>
  ),
  bluesky: (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">
      <path d="M5.6 4.5c2.6 1.95 5.4 5.9 6.4 8 1-2.1 3.8-6.05 6.4-8 1.9-1.4 5-2.5 5 .96 0 .7-.4 5.83-.63 6.66-.8 2.9-3.74 3.6-6.36 3.16 4.58.78 5.74 3.36 3.23 5.94-4.78 4.92-6.86-1.24-7.4-2.82-.06-.18-.1-.27-.13-.27-.04 0-.08.1-.14.27-.54 1.58-2.62 7.74-7.4 2.82-2.5-2.58-1.34-5.16 3.23-5.94-2.62.44-5.55-.26-6.36-3.16C.6 11.3.2 6.16.2 5.46c0-3.46 3.1-2.36 5-.96z" />
    </svg>
  ),
  mastodon: (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">
      <path d="M21.58 8.04c0-4.4-2.88-5.7-2.88-5.7C17.27 1.7 14.85 1.5 12.34 1.48h-.06c-2.5.02-4.92.22-6.36.86 0 0-2.88 1.3-2.88 5.7 0 1 0 2.2.04 3.46.13 4.27.8 8.5 4.74 9.55 1.82.48 3.38.58 4.64.51 2.28-.13 3.56-.82 3.56-.82l-.07-1.65s-1.63.51-3.45.45c-1.81-.06-3.71-.2-4-2.42-.03-.2-.04-.4-.04-.6 0 0 1.77.43 4.01.53 1.37.07 2.65-.08 3.96-.24 2.5-.3 4.69-1.85 4.97-3.27.43-2.23.4-5.45.4-5.45zm-3.36 5.6h-2.08V8.55c0-1.07-.45-1.61-1.36-1.61-1 0-1.5.65-1.5 1.93v2.79h-2.07v-2.8c0-1.27-.5-1.92-1.5-1.92-.91 0-1.36.54-1.36 1.61v5.1H6.27V8.4c0-1.07.27-1.92.82-2.55.56-.63 1.3-.95 2.21-.95 1.07 0 1.88.41 2.41 1.23l.52.87.52-.87c.53-.82 1.34-1.23 2.41-1.23.92 0 1.66.32 2.21.95.55.63.82 1.48.82 2.55v5.24z" />
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
  if (socials.facebook) {
    const url = sanitizeUrl(`https://www.facebook.com/${encodeURIComponent(socials.facebook)}`);
    if (url) links.push({ platform: 'Facebook', key: 'facebook', url });
  }
  if (socials.instagram) {
    const url = sanitizeUrl(`https://www.instagram.com/${encodeURIComponent(socials.instagram)}`);
    if (url) links.push({ platform: 'Instagram', key: 'instagram', url });
  }
  if (socials.threads) {
    const url = sanitizeUrl(`https://www.threads.net/@${encodeURIComponent(socials.threads)}`);
    if (url) links.push({ platform: 'Threads', key: 'threads', url });
  }
  if (socials.bluesky) {
    // Bluesky handles include the domain, no extra path needed.
    const url = sanitizeUrl(`https://bsky.app/profile/${encodeURIComponent(socials.bluesky)}`);
    if (url) links.push({ platform: 'Bluesky', key: 'bluesky', url });
  }
  if (socials.mastodon) {
    // Mastodon handles look like `@user@server.tld` or `user@server.tld`.
    // Build the canonical https URL from the server portion.
    const stripped = socials.mastodon.replace(/^@/, '');
    const at = stripped.indexOf('@');
    if (at > 0) {
      const user = stripped.slice(0, at);
      const server = stripped.slice(at + 1);
      const url = sanitizeUrl(`https://${server}/@${encodeURIComponent(user)}`);
      if (url) links.push({ platform: 'Mastodon', key: 'mastodon', url });
    }
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
