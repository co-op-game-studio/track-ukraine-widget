/**
 * NameSearchInput — live, debounced name-search UI.
 *
 * Traces to: FR-31, ADR-011.
 */
import { useId, useState, useCallback, type KeyboardEvent } from 'react';
import { useNameSearch, type NameSearchResult } from '../hooks/useNameSearch';

export interface NameSearchInputProps {
  apiBase: string;
  onSelect: (result: NameSearchResult) => void;
  disabled?: boolean;
}

export function NameSearchInput({ apiBase, onSelect, disabled }: NameSearchInputProps) {
  const listboxId = useId();
  const { query, setQuery, results, truncated, status, error, clear } = useNameSearch(apiBase);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightedIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && results.length > 0) {
        e.preventDefault();
        const idx = highlightedIndex >= 0 ? highlightedIndex : 0;
        const result = results[idx];
        if (result) {
          onSelect(result);
          clear();
          setHighlightedIndex(-1);
        }
      } else if (e.key === 'Escape') {
        setHighlightedIndex(-1);
        setQuery('');
      }
    },
    [results, highlightedIndex, onSelect, clear, setQuery],
  );

  const open = query.trim().length >= 2 && (results.length > 0 || status === 'unavailable' || status === 'success');

  return (
    <div className="viw-name-search">
      <label className="viw-name-search-label">
        Or search by name:
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          className="viw-name-search-input"
          placeholder="e.g. Durbin or Tammy"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlightedIndex(-1);
          }}
          onKeyDown={handleKeyDown}
          disabled={disabled || status === 'unavailable'}
        />
      </label>

      {error && status === 'unavailable' && (
        <div className="viw-name-search-hint" role="status">{error}</div>
      )}

      {open && (
        <ul
          id={listboxId}
          className="viw-name-search-listbox"
          role="listbox"
          aria-label="Member matches"
        >
          {results.length === 0 && status === 'success' && (
            <li className="viw-name-search-empty" role="option" aria-selected={false}>
              No members match
            </li>
          )}
          {results.map((r, idx) => (
            <li
              key={r.bioguideId}
              role="option"
              aria-selected={idx === highlightedIndex}
              className={`viw-name-search-option${idx === highlightedIndex ? ' is-highlighted' : ''}`}
              onClick={() => {
                onSelect(r);
                clear();
                setHighlightedIndex(-1);
              }}
              onMouseEnter={() => setHighlightedIndex(idx)}
            >
              <span className="viw-name-search-name">{r.displayName}</span>
              <span className="viw-name-search-meta">
                {r.chamber} · {r.state} · {r.party}
              </span>
            </li>
          ))}
          {truncated && (
            <li className="viw-name-search-truncated" role="option" aria-selected={false}>
              Showing top 10 — refine your search
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
