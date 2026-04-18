/**
 * VoterInfoWidget — root component that composes AddressInput, NameSearchInput,
 * ResultsPanel, ErrorBanner.
 * Traces to: T-021, FR-31, all user stories.
 */
import { useState } from 'react';
import { AddressInput } from './components/AddressInput';
import { NameSearchInput } from './components/NameSearchInput';
import { ErrorBanner } from './components/ErrorBanner';
import { ResultsPanel } from './components/ResultsPanel';
import { useAddressLookup } from './hooks/useAddressLookup';
import type { NameSearchResult } from './hooks/useNameSearch';
import type { LookupResult, Representative } from './types/domain';

export interface VoterInfoWidgetProps {
  /** Base URL where the proxy Worker is hosted. Empty string = same-origin (dev). */
  apiBase?: string;
}

function nameSearchResultToLookupResult(r: NameSearchResult): LookupResult {
  const rep: Representative = {
    bioguideId: r.bioguideId,
    name: r.displayName,
    party:
      r.party === 'D' ? 'Democratic' :
      r.party === 'R' ? 'Republican' :
      r.party === 'I' ? 'Independent' : r.party,
    partyAbbreviation: r.party,
    state: r.state,
    district: null,
    chamber: r.chamber.toLowerCase() as 'house' | 'senate',
    photoUrl: null,
    isNonVoting: false,
    officialWebsiteUrl: null,
  };
  return { representatives: [rep], state: r.state, district: 0 };
}

export function VoterInfoWidget({ apiBase = '' }: VoterInfoWidgetProps) {
  const lookup = useAddressLookup(apiBase);
  const loading = lookup.status === 'loading';
  const [nameSelection, setNameSelection] = useState<LookupResult | null>(null);

  const handleNameSelect = (r: NameSearchResult) => {
    lookup.reset();
    setNameSelection(nameSearchResultToLookupResult(r));
  };

  const addressResult = lookup.status === 'success' ? lookup.data : null;
  const effectiveResult = addressResult ?? nameSelection;

  return (
    <div className="viw-root">
      <header className="viw-root-header">
        <h1 className="viw-root-title">Do your candidates support Ukraine?</h1>
        <p className="viw-root-subtitle">
          Enter your home address, or search by name, to see how your U.S. Senators and
          Representative voted on major Ukraine aid, sanctions, and oversight legislation.
        </p>
      </header>

      <AddressInput
        onSubmit={(addr) => {
          setNameSelection(null);
          return lookup.lookup(addr);
        }}
        disabled={loading}
      />

      <NameSearchInput apiBase={apiBase} onSelect={handleNameSelect} disabled={loading} />

      {lookup.error && (
        <ErrorBanner
          message={lookup.error.message}
          onDismiss={lookup.reset}
        />
      )}

      {effectiveResult && (
        <ResultsPanel result={effectiveResult} apiBase={apiBase} />
      )}

      <footer className="viw-root-footer">
        <small>
          Data from U.S. Census Bureau, Congress.gov, and Senate.gov. Not affiliated with
          any government agency.
        </small>
      </footer>
    </div>
  );
}
