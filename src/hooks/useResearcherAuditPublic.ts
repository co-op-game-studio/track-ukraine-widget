/**
 * useResearcherAuditPublic — fetch the public, redacted audit feed for the
 * embed's "Recent researcher updates" panel (FR-53 AC-53.4, FR-58 AC-58.2).
 *
 * 401 / 403 / 404 / network errors → empty list (the panel renders nothing).
 * No error banner per AC-53.4 — this is a "nice-to-have" surface.
 *
 * Traces to FR-53 AC-53.4, FR-58 AC-58.2, AC-58.4.
 */
import { useEffect, useState } from 'react';

export interface AuditPublicItem {
  id: string;
  actorLocalPart: string;
  action: string;
  table: string;
  rowTitle: string | null;
  createdAt: string;
}

interface AuditFeedRecord {
  generatedAt: string;
  schemaVersion: number;
  items: AuditPublicItem[];
}

export interface UseResearcherAuditPublicResult {
  items: AuditPublicItem[];
  status: 'idle' | 'loading' | 'success' | 'empty' | 'error';
}

export function useResearcherAuditPublic(
  apiBase: string,
  limit = 20,
): UseResearcherAuditPublicResult {
  const [items, setItems] = useState<AuditPublicItem[]>([]);
  const [status, setStatus] = useState<UseResearcherAuditPublicResult['status']>('idle');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    const base = apiBase.replace(/\/+$/, '');
    fetch(`${base}/api/audit/public?limit=${limit}`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setItems([]);
          setStatus('empty');
          return;
        }
        const json = (await res.json()) as AuditFeedRecord;
        const arr = json.items ?? [];
        setItems(arr);
        setStatus(arr.length > 0 ? 'success' : 'empty');
      })
      .catch(() => {
        if (cancelled) return;
        setItems([]);
        setStatus('empty');
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, limit]);

  return { items, status };
}
