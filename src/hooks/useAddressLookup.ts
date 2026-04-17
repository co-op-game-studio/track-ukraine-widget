/**
 * useAddressLookup — orchestrates the address-to-representatives pipeline.
 *
 * Pipeline (see design.md §3.2.1):
 *   1. Census geocoder → { state, district }
 *   2. Parallel Congress.gov calls: house rep for (state, district), all members for state
 *   3. Filter state response to senators, return combined Representative[]
 *
 * Traces to: FR-1, FR-2, FR-3, FR-4, US-1 (AC-1.1 through AC-1.5)
 */
import { useCallback, useRef, useState } from 'react';
import { geocodeAddress } from '../services/censusApi';
import {
  fetchMembersByState,
  fetchMembersByStateDistrict,
  fetchMemberDetail,
} from '../services/congressApi';
import {
  mapSummaryToRepresentative,
  enrichWithMemberDetail,
} from '../services/mapMember';
import { mapWithConcurrency } from '../utils/limitConcurrency';
import type { LookupResult, Representative } from '../types/domain';

export type LookupStatus = 'idle' | 'loading' | 'success' | 'error';

export interface UseAddressLookupResult {
  status: LookupStatus;
  data: LookupResult | null;
  error: Error | null;
  lookup: (address: string) => Promise<void>;
  reset: () => void;
}

/**
 * Convert a Census at-large/territory district number (e.g., DC = 98) to
 * the value Congress.gov expects (0).
 */
function normalizeDistrictForCongress(district: number): number {
  return district >= 90 ? 0 : district;
}

export function useAddressLookup(apiBase: string): UseAddressLookupResult {
  const [status, setStatus] = useState<LookupStatus>('idle');
  const [data, setData] = useState<LookupResult | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Track the latest lookup to ignore stale responses if lookup() is called
  // multiple times in quick succession.
  const lookupIdRef = useRef(0);

  const lookup = useCallback(
    async (address: string) => {
      const thisLookup = ++lookupIdRef.current;
      setStatus('loading');
      setError(null);
      setData(null);

      try {
        const geo = await geocodeAddress(address, apiBase);
        if (thisLookup !== lookupIdRef.current) return;

        if (!geo.state || geo.district === null) {
          throw new Error('Could not determine your congressional district.');
        }

        const congressDistrict = normalizeDistrictForCongress(geo.district);

        const [houseList, stateList] = await Promise.all([
          fetchMembersByStateDistrict(geo.state, congressDistrict, apiBase),
          fetchMembersByState(geo.state, apiBase),
        ]);
        if (thisLookup !== lookupIdRef.current) return;

        const houseReps: Representative[] = houseList.map(mapSummaryToRepresentative);
        const senators: Representative[] = stateList
          .filter((m) => m.district === null)
          .map(mapSummaryToRepresentative);

        const summaryReps = [...senators, ...houseReps];

        // Enrich each with the detail endpoint (for officialWebsiteUrl + authoritative partyAbbreviation).
        // This is ~3 extra API calls. We swallow individual failures so the UI still renders.
        const representatives = await mapWithConcurrency(
          summaryReps,
          3,
          async (rep) => {
            try {
              const detail = await fetchMemberDetail(rep.bioguideId, apiBase);
              return enrichWithMemberDetail(rep, detail);
            } catch {
              return rep; // detail call failed — fall back to list-endpoint data
            }
          },
        );
        if (thisLookup !== lookupIdRef.current) return;

        setData({
          state: geo.state,
          district: congressDistrict,
          representatives,
        });
        setStatus('success');
      } catch (e) {
        if (thisLookup !== lookupIdRef.current) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setStatus('error');
      }
    },
    [apiBase],
  );

  const reset = useCallback(() => {
    lookupIdRef.current++;
    setStatus('idle');
    setData(null);
    setError(null);
  }, []);

  return { status, data, error, lookup, reset };
}
