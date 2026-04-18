/**
 * useNameSearch — live, debounced member-name search against /api/name-search.
 *
 * Traces to: FR-31, ADR-011.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface NameSearchResult {
  bioguideId: string;
  displayName: string;
  first: string;
  last: string;
  state: string;
  chamber: 'Senate' | 'House';
  party: string;
  photoUrl?: string | null;
  searchKeys: string[];
}

export type NameSearchStatus = 'idle' | 'loading' | 'success' | 'error' | 'unavailable';

export interface UseNameSearchResult {
  query: string;
  setQuery: (q: string) => void;
  results: NameSearchResult[];
  truncated: boolean;
  status: NameSearchStatus;
  error: string | null;
  clear: () => void;
}

const DEBOUNCE_MS = 150;

export function useNameSearch(apiBase: string): UseNameSearchResult {
  const [query, setQueryState] = useState('');
  const [results, setResults] = useState<NameSearchResult[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [status, setStatus] = useState<NameSearchStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const setQuery = useCallback((q: string) => setQueryState(q), []);
  const clear = useCallback(() => {
    setQueryState('');
    setResults([]);
    setTruncated(false);
    setStatus('idle');
    setError(null);
  }, []);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (abortRef.current) abortRef.current.abort();

    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setTruncated(false);
      setStatus('idle');
      setError(null);
      return;
    }

    timerRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus('loading');
      setError(null);
      try {
        const base = apiBase.replace(/\/+$/, '');
        const res = await fetch(
          `${base}/api/name-search?q=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal },
        );
        if (res.status === 503) {
          setStatus('unavailable');
          setResults([]);
          setError('Name search temporarily unavailable — try address lookup.');
          return;
        }
        if (!res.ok) {
          setStatus('error');
          setError(`Search failed (${res.status})`);
          return;
        }
        const data = (await res.json()) as { results: NameSearchResult[]; truncated: boolean };
        setResults(data.results);
        setTruncated(data.truncated);
        setStatus('success');
      } catch (e) {
        if ((e as { name?: string }).name === 'AbortError') return;
        setStatus('error');
        setError((e as Error).message);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, apiBase]);

  return { query, setQuery, results, truncated, status, error, clear };
}
