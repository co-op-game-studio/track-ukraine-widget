/**
 * useAddressLookup — orchestrates the address-to-representatives pipeline.
 *
 * Pipeline (v2.5.2, see design.md §3.2.1 and §4.14):
 *   1. Census geocoder → { state, district }
 *   2. ONE KV-backed call: `/api/state-members/{state}` returns the
 *      full senator + house roster for the state in one record (ADR-012).
 *   3. Filter house[] to the resolved district; combine with senators[] to
 *      produce the `Representative[]` result.
 *
 * Traces to: FR-1, FR-2, FR-3, FR-4 (REVISED v2.5.2), US-1 (AC-1.1\u20131.5),
 * FR-32 AC-32.16, ADR-012.
 *
 * The v2.5.1 implementation did two Congress.gov list calls plus a
 * per-rep member-detail enrichment loop (5\u20136 upstream round-trips total).
 * The v2.5.2 path is a single KV read after the geocode.
 */
import { useCallback, useRef, useState } from 'react';
import { geocodeAddress } from '../services/censusApi';
import { fetchStateMembers, type StateMemberSummary } from '../services/stateMembers';
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
 * the value used in the state-members record (0 for non-voting
 * at-large delegates). Preserves the domain's existing convention.
 */
function normalizeDistrictForCongress(district: number): number {
  return district >= 90 ? 0 : district;
}

function toRepresentative(summary: StateMemberSummary): Representative {
  return {
    bioguideId: summary.bioguideId,
    name: `${summary.last}, ${summary.first}`,
    party:
      summary.party === 'D' ? 'Democratic' :
      summary.party === 'R' ? 'Republican' :
      summary.party === 'I' ? 'Independent' : summary.party,
    partyAbbreviation: summary.party as Representative['partyAbbreviation'],
    state: summary.state,
    district: summary.district,
    chamber: summary.chamber === 'Senate' ? 'senate' : 'house',
    photoUrl: summary.photoUrl,
    isNonVoting: summary.isNonVoting ?? false,
    officialWebsiteUrl: summary.website,
    yearEntered: summary.yearEntered,
  };
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

        const stateRecord = await fetchStateMembers(geo.state, apiBase);
        if (thisLookup !== lookupIdRef.current) return;

        if (!stateRecord) {
          throw new Error('Member roster for your state is temporarily unavailable.');
        }

        const senators: Representative[] = stateRecord.senators.map(toRepresentative);
        const houseForDistrict: Representative[] = stateRecord.house
          .filter((m) => m.district === congressDistrict)
          .map(toRepresentative);

        // Prefer the house rep to fall last (matches v2.5.1 chip-grid layout).
        const representatives: Representative[] = [...senators, ...houseForDistrict];

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
