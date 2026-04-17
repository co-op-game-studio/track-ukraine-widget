/**
 * useSponsoredBills — fetch a member's sponsored & cosponsored curated Ukraine
 * bills, tagged with valence. Amendments (D-6) are dropped silently.
 *
 * Traces to: FR-7, FR-11, FR-15, US-4, design.md §3.2.3, §4.9.
 */
import { useCallback, useRef, useState } from 'react';
import {
  fetchSponsoredLegislation,
  fetchCosponsoredLegislation,
} from '../services/congressApi';
import { formatBillNumber } from '../utils/formatters';
import {
  isCuratedBill,
  lookupCuratedBill,
  type CuratedBill,
} from '../services/ukraineFilter';
import { computeValence, type Valence } from '../services/valence';
import type {
  CongressLegislationRawEntry,
  CongressLegislationListResponse,
} from '../types/api';

const SCAN_PAGE_SIZE = 100;
const SCAN_MAX_PAGES = 5;

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

async function scan(
  relationship: 'sponsored' | 'cosponsored',
  bioguideId: string,
  apiBase: string,
  fetcher: (
    id: string,
    base: string,
    offset: number,
    limit: number,
  ) => Promise<CongressLegislationListResponse>,
): Promise<UkraineBill[]> {
  const keep: UkraineBill[] = [];
  for (let page = 0; page < SCAN_MAX_PAGES; page++) {
    const offset = page * SCAN_PAGE_SIZE;
    const resp = await fetcher(bioguideId, apiBase, offset, SCAN_PAGE_SIZE);
    const raw =
      (relationship === 'sponsored' ? resp.sponsoredLegislation : resp.cosponsoredLegislation) ?? [];
    if (raw.length === 0) break;

    for (const e of raw) {
      const mapped = tryBuildUkraineBill(e, relationship);
      if (mapped) keep.push(mapped);
    }
    if (raw.length < SCAN_PAGE_SIZE) break;
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
      const [sponsored, cosponsored] = await Promise.all([
        scan('sponsored', bioguideId, apiBase, fetchSponsoredLegislation),
        scan('cosponsored', bioguideId, apiBase, fetchCosponsoredLegislation),
      ]);
      if (thisReq !== reqIdRef.current) return;

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
