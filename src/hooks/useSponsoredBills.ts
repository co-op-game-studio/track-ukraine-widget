/**
 * useSponsoredBills — fetch a member's sponsored & cosponsored curated Ukraine
 * bills, tagged with valence. Amendments (D-6) are dropped silently.
 *
 * Traces to: FR-7, FR-11, FR-15, US-4, design.md §3.2.3, §4.9.
 *
 * Data source: `/api/members/{bioguideId}` — a KV-backed member profile that
 * already contains the first 250 sponsored + 250 cosponsored entries baked
 * in at Worker-build time (see proxy/lib.ts buildProfileFromUpstream). That
 * replaces the prior 5-page × 2-relationship pagination against Congress.gov
 * with a single cached KV read, dropping the per-rep cost from 10 upstream
 * round-trips to 1.
 */
import { useCallback, useRef, useState } from 'react';
import { formatBillNumber } from '../utils/formatters';
import {
  isCuratedBill,
  lookupCuratedBill,
  type CuratedBill,
} from '../services/ukraineFilter';
import { computeValence, type Valence } from '../services/valence';
import type { CongressLegislationRawEntry } from '../types/api';

export type BillStatus = 'idle' | 'loading' | 'success' | 'error';

export interface UkraineBill {
  number: string;                       // "H.R. 7691"
  title: string;
  dateIntroduced: string;
  latestAction: string;
  congressGovUrl: string;
  relationship: 'sponsored' | 'cosponsored';
  featured: boolean;
  direction: CuratedBill['direction'];
  valence: Valence;
  /** Bill summary (CRS) if pre-curated in the JSON; null otherwise. Runtime fetch is handled elsewhere. */
  summary: CuratedBill['summary'];
  curated: CuratedBill;
}

export interface SponsoredBillsData {
  sponsored: UkraineBill[];
  cosponsored: UkraineBill[];
}

export interface UseSponsoredBillsResult {
  status: BillStatus;
  data: SponsoredBillsData | null;
  error: Error | null;
  load: () => Promise<void>;
  reset: () => void;
}

function tryBuildUkraineBill(
  entry: CongressLegislationRawEntry,
  relationship: 'sponsored' | 'cosponsored',
): UkraineBill | null {
  if (!entry.type || !entry.number || !entry.title) return null;
  if (!isCuratedBill(entry.congress, entry.type, entry.number)) return null;
  const curated = lookupCuratedBill(entry.congress, entry.type, entry.number);
  if (!curated) return null;

  // For sponsorship valence, we treat *any* sponsor action as 'sponsored' for the
  // valence function (cosponsored behaves identically there).
  const valence = computeValence(
    curated.direction,
    relationship === 'sponsored' ? 'sponsored' : 'cosponsored',
  );

  return {
    number: formatBillNumber(entry.type, entry.number),
    title: entry.title,
    dateIntroduced: entry.introducedDate ?? '',
    latestAction: entry.latestAction?.text ?? '',
    congressGovUrl: curated.congressGovUrl,
    relationship,
    featured: curated.featured,
    direction: curated.direction,
    valence,
    summary: curated.summary,
    curated,
  };
}

function mapAndSort(
  raw: CongressLegislationRawEntry[],
  relationship: 'sponsored' | 'cosponsored',
): UkraineBill[] {
  const keep: UkraineBill[] = [];
  for (const e of raw) {
    const mapped = tryBuildUkraineBill(e, relationship);
    if (mapped) keep.push(mapped);
  }
  // Featured first, then newest introduced
  return keep.sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    return (b.dateIntroduced || '').localeCompare(a.dateIntroduced || '');
  });
}

export function useSponsoredBills(
  bioguideId: string | null,
  apiBase: string,
): UseSponsoredBillsResult {
  const [status, setStatus] = useState<BillStatus>('idle');
  const [data, setData] = useState<SponsoredBillsData | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const reqIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!bioguideId) return;
    const thisReq = ++reqIdRef.current;
    setStatus('loading');
    setError(null);

    try {
      const base = apiBase.replace(/\/+$/, '');
      const res = await fetch(`${base}/api/members/${encodeURIComponent(bioguideId)}`);
      if (!res.ok) throw new Error(`member profile ${res.status}`);
      const profile = (await res.json()) as {
        sponsored?: CongressLegislationRawEntry[];
        cosponsored?: CongressLegislationRawEntry[];
      };
      if (thisReq !== reqIdRef.current) return;

      const sponsored = mapAndSort(profile.sponsored ?? [], 'sponsored');
      const cosponsored = mapAndSort(profile.cosponsored ?? [], 'cosponsored');
      setData({ sponsored, cosponsored });
      setStatus('success');
    } catch (e) {
      if (thisReq !== reqIdRef.current) return;
      setError(e instanceof Error ? e : new Error(String(e)));
      setStatus('error');
    }
  }, [bioguideId, apiBase]);

  const reset = useCallback(() => {
    reqIdRef.current++;
    setStatus('idle');
    setData(null);
    setError(null);
  }, []);

  return { status, data, error, load, reset };
}
