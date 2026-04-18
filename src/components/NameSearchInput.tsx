/**
 * NameSearchInput — input + inline status indicator.
 * Parent handles live results list and renders it as tiles.
 *
 * Traces to: FR-31, ADR-011.
 */
import type { NameSearchStatus } from '../hooks/useNameSearch';

export interface NameSearchInputProps {
  value: string;
  onChange: (query: string) => void;
  disabled?: boolean;
  status?: NameSearchStatus;
  resultCount?: number;
  showErrorDetails?: boolean;
  errorMessage?: string | null;
}

function statusGlyph(status: NameSearchStatus | undefined, resultCount: number): {
  className: string;
  title: string;
  content: string;
} | null {
  switch (status) {
    case 'loading':
      return { className: 'viw-search-status-loading', title: 'Searching…', content: '' };
    case 'error':
      return { className: 'viw-search-status-error', title: 'Search failed', content: '!' };
    case 'unavailable':
      return { className: 'viw-search-status-error', title: 'Search unavailable', content: '!' };
    case 'success':
      if (resultCount === 0) {
        return { className: 'viw-search-status-warn', title: 'No matches found', content: '?' };
      }
      return null;
    default:
      return null;
  }
}

export function NameSearchInput({
  value,
  onChange,
  disabled,
  status,
  resultCount = 0,
  showErrorDetails = false,
  errorMessage,
}: NameSearchInputProps) {
  const glyph = statusGlyph(status, resultCount);
  // When showErrorDetails is on AND we errored, surface the upstream message
  // via the glyph title so hover reveals the detail. No text row.
  const detailTitle =
    (status === 'error' || status === 'unavailable') && showErrorDetails && errorMessage
      ? `${glyph?.title ?? 'Error'}: ${errorMessage}`
      : glyph?.title;

  return (
    <div className="viw-name-search-form">
      <label htmlFor="viw-name-search" className="viw-address-label">
        Or search by name
      </label>
      <div className="viw-address-row viw-name-search-row">
        <input
          id="viw-name-search"
          type="search"
          className="viw-address-input"
          placeholder="e.g. Durbin or Tammy"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          autoComplete="off"
        />
        {glyph && (
          <span
            className={`viw-search-status ${glyph.className}`}
            title={detailTitle}
            aria-label={detailTitle}
            role="status"
          >
            {glyph.content}
          </span>
        )}
      </div>
    </div>
  );
}
