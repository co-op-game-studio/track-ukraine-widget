/**
 * VoterInfoWidget — composes AddressInput + NameSearchInput and routes to
 * ResultsPanel (for address-based lookups) or NameSearchResultsPanel (for
 * live name-search).
 * Traces to: T-021, FR-31, all user stories.
 */
import { AddressInput } from './components/AddressInput';
import { NameSearchInput } from './components/NameSearchInput';
import { NameSearchResultsPanel } from './components/NameSearchResultsPanel';
import { ErrorBanner } from './components/ErrorBanner';
import { ResultsPanel } from './components/ResultsPanel';
import { useAddressLookup } from './hooks/useAddressLookup';
import { useNameSearch } from './hooks/useNameSearch';

export interface VoterInfoWidgetProps {
  /** Base URL for proxy API calls. Empty string = same-origin. */
  apiBase?: string;
  /** When true, show detailed error messages from the search layer (dev/uat/stg).
   *  Prod should set false — errors become generic. */
  showErrorDetails?: boolean;
}

export function VoterInfoWidget({ apiBase = '', showErrorDetails = false }: VoterInfoWidgetProps) {
  const lookup = useAddressLookup(apiBase);
  const search = useNameSearch(apiBase);
  const loading = lookup.status === 'loading';
  const hasActiveSearch = search.query.trim().length >= 2;

  return (
    <div className="viw-root">

      <AddressInput
        onSubmit={(addr) => {
          search.clear();
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

      {lookup.error && !hasActiveSearch && (
        <ErrorBanner message={lookup.error.message} onDismiss={lookup.reset} />
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
      ) : (
        lookup.status === 'success' &&
        lookup.data && <ResultsPanel result={lookup.data} apiBase={apiBase} />
      )}

      <footer className="viw-root-footer">
        <small>
          Data from U.S. Census Bureau, Congress.gov, and Senate.gov. Not affiliated with
          any government agency.
          <br />
          We do not store or keep any information you enter in this form.
        </small>
      </footer>
    </div>
  );
}
