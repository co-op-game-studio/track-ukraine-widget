/**
 * useRepQuotes — fetch curated quotes for a representative.
 * Consumed by the Quotes tab (FR-53 AC-53.2).
 *
 * 404 → empty list (AC-53.5). Other errors are also treated as empty.
 *
 * Traces to FR-51 AC-51.6, FR-53 AC-53.2.
 */
import { useEffect, useState } from 'react';
import { fetchRepBundle } from '../services/repBundle';

export interface RepQuote {
  id: string;
  mediaKind: 'video' | 'audio' | 'text' | 'image' | string;
  sourceUrl: string;
  sourceLabel: string | null;
  quotedAt: string | null;
  bodyText: string;
  /** AC-52.43 — replaces legacy `scoreAdjustment ∈ [-1,+1]`. */
  weight: number;
  direction: number;
  comment: string | null;
  authorEmail: string;
  createdAt: string;
}

export interface QuotesRecord {
  bioguideId: string;
  quotes: RepQuote[];
  generatedAt: string;
  schemaVersion: number;
}

export interface UseRepQuotesResult {
  quotes: RepQuote[];
  status: 'idle' | 'loading' | 'success' | 'empty' | 'error';
}

export function useRepQuotes(
  bioguideId: string | null,
  apiBase: string,
): UseRepQuotesResult {
  const [quotes, setQuotes] = useState<RepQuote[]>([]);
  const [status, setStatus] = useState<UseRepQuotesResult['status']>('idle');

  useEffect(() => {
    if (!bioguideId) {
      setQuotes([]);
      setStatus('idle');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    fetchRepBundle(apiBase, bioguideId)
      .then((bundle) => {
        if (cancelled) return;
        const record = bundle?.quotes as QuotesRecord | null;
        const list = record?.quotes ?? [];
        setQuotes(list);
        setStatus(list.length > 0 ? 'success' : 'empty');
      })
      .catch(() => {
        if (cancelled) return;
        setQuotes([]);
        setStatus('empty');
      });
    return () => {
      cancelled = true;
    };
  }, [bioguideId, apiBase]);

  return { quotes, status };
}
