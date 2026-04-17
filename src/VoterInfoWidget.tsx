/**
 * VoterInfoWidget — root component that composes AddressInput, ResultsPanel, ErrorBanner.
 * Traces to: T-021, all user stories
 */
import { AddressInput } from './components/AddressInput';
import { ErrorBanner } from './components/ErrorBanner';
import { ResultsPanel } from './components/ResultsPanel';
import { useAddressLookup } from './hooks/useAddressLookup';

export interface VoterInfoWidgetProps {
  /** Base URL where the CORS proxy is hosted. Empty string = same-origin (dev). */
  apiBase?: string;
}

export function VoterInfoWidget({ apiBase = '' }: VoterInfoWidgetProps) {
  const lookup = useAddressLookup(apiBase);
  const loading = lookup.status === 'loading';

  return (
    <div className="viw-root">
      <header className="viw-root-header">
        <h1 className="viw-root-title">Do your candidates support Ukraine?</h1>
        <p className="viw-root-subtitle">
          Enter your home address to see how your U.S. Senators and Representative
          voted on major Ukraine aid, sanctions, and oversight legislation.
        </p>
      </header>

      <AddressInput onSubmit={lookup.lookup} disabled={loading} />

      {lookup.error && (
        <ErrorBanner
          message={lookup.error.message}
          onDismiss={lookup.reset}
        />
      )}

      {lookup.status === 'success' && lookup.data && (
        <ResultsPanel result={lookup.data} apiBase={apiBase} />
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
