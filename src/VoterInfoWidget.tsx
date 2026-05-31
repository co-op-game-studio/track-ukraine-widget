/**
 * VoterInfoWidget — composes AddressInput + NameSearchInput and routes to
 * ResultsPanel (for address-based lookups) or NameSearchResultsPanel (for
 * live name-search).
 * Traces to: T-021, FR-31, all user stories.
 */
import { useRef } from 'react';
import { AddressInput } from './components/AddressInput';
import { NameSearchInput } from './components/NameSearchInput';
import { NameSearchResultsPanel } from './components/NameSearchResultsPanel';
import { ErrorBanner } from './components/ErrorBanner';
import { ResultsPanel } from './components/ResultsPanel';
import { RepDetail } from './components/RepDetail';
import { AboutSystemPanel } from './components/AboutSystemPanel';
import { useAddressLookup } from './hooks/useAddressLookup';
import { useNameSearch } from './hooks/useNameSearch';
import { useMemberById } from './hooks/useMemberById';
import { getEnvelopeFromError } from './services/errorEnvelope';

export interface VoterInfoWidgetProps {
  /** Base URL for proxy API calls. Empty string = same-origin. */
  apiBase?: string;
  /** When true, show detailed error messages from the search layer (dev/uat/stg).
   *  Prod should set false — errors become generic. */
  showErrorDetails?: boolean;
  /** FR-60: deep-link target. When a shape-valid bioguide is passed, the
   *  widget opens straight onto that member's RepDetail (no address lookup,
   *  no name-search). Used by the admin profile preview. */
  initialBioguide?: string;
}

export function VoterInfoWidget({ apiBase = '', showErrorDetails = false, initialBioguide }: VoterInfoWidgetProps) {
  const lookup = useAddressLookup(apiBase);
  const search = useNameSearch(apiBase);
  // FR-60 — resolve the deep-link member (idle/null when no bioguide given).
  const deepLink = useMemberById(initialBioguide, apiBase);
  const loading = lookup.status === 'loading';
  const hasActiveSearch = search.query.trim().length >= 2;
  // The deep-link detail owns the results area only while the user hasn't
  // begun their own lookup or search (so it never fights an active flow).
  const showDeepLink =
    !hasActiveSearch && lookup.status !== 'success' && lookup.status !== 'loading' &&
    (deepLink.status === 'loading' || deepLink.status === 'success');
  // FR-60 AC-60.8 — when the embed is opened on a specific member, it is a
  // single-member profile view: the address + name-search entry controls are
  // hidden so only that person's profile shows. A 404/error on the deep-link
  // fetch falls back to the full entry screen (deepLinkActive = false), so an
  // unknown bioguide still yields a usable widget.
  const deepLinkActive = showDeepLink;
  // Remember the last-submitted address so the ErrorBanner's "Try again"
  // button (FR-37 AC-37.5) can re-invoke the lookup without re-prompting
  // the user. Populated on every AddressInput submit.
  const lastAddressRef = useRef<string | null>(null);

  // FR-37 AC-37.5/AC-37.8: pull the enveloped view off the error if the
  // service threw one. Otherwise fall back to the pre-v2.6.0 shape.
  const envelope = lookup.error ? getEnvelopeFromError(lookup.error) : null;

  return (
    <div className="viw-root">

      {/* FR-60 AC-60.8 — entry controls are hidden in single-member deep-link
          mode so the embed shows only that person's profile. */}
      {!deepLinkActive && (
        <>
          <AddressInput
            onSubmit={(addr) => {
              search.clear();
              lastAddressRef.current = addr;
              return lookup.lookup(addr);
            }}
            disabled={loading}
          />

          <NameSearchInput
            value={search.query}
            onChange={(q) => {
              if (q.trim().length > 0) lookup.reset();
              search.setQuery(q);
            }}
            disabled={loading}
            status={search.status}
            resultCount={search.results.length}
            showErrorDetails={showErrorDetails}
            errorMessage={search.error}
          />
        </>
      )}

      {lookup.error && !hasActiveSearch && (
        <ErrorBanner
          message={envelope?.userMessage ?? lookup.error.message}
          onDismiss={lookup.reset}
          traceId={envelope?.traceId}
          onRetry={
            envelope?.retryable && lastAddressRef.current
              ? () => { void lookup.lookup(lastAddressRef.current!); }
              : undefined
          }
        />
      )}

      {hasActiveSearch ? (
        <NameSearchResultsPanel
          query={search.query}
          results={search.results}
          truncated={search.truncated}
          status={search.status}
          error={null /* error surface lives on the input now */}
          apiBase={apiBase}
        />
      ) : lookup.status === 'success' && lookup.data ? (
        <ResultsPanel result={lookup.data} apiBase={apiBase} />
      ) : showDeepLink ? (
        // FR-60 AC-60.3/AC-60.4 — deep-link member opens directly. While the
        // member profile is loading, surface the existing status idiom; a
        // 404/error falls through to the entry screen (showDeepLink false).
        deepLink.status === 'loading' || !deepLink.representative ? (
          <section className="viw-results" aria-live="polite">
            <div className="viw-results-empty" role="status">Loading profile…</div>
          </section>
        ) : (
          <section className="viw-results" aria-label="Member profile preview">
            <div className="viw-detail-slot viw-detail-slot-open" aria-live="polite">
              <RepDetail
                key={deepLink.representative.bioguideId}
                representative={deepLink.representative}
                apiBase={apiBase}
                onClose={() => { /* deep-link detail is the root view; close is a no-op */ }}
              />
            </div>
          </section>
        )
      ) : null}

      <footer className="viw-root-footer">
        <small>
          Data from U.S. Census Bureau, Congress.gov, and Senate.gov. Not affiliated with
          any government agency.
          <br />
          We do not store or keep any information you enter in this form.
        </small>
        <AboutSystemPanel apiBase={apiBase} />
      </footer>
    </div>
  );
}
