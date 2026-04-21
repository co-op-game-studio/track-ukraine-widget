/**
 * Census Bureau Geocoder Service
 * See: docs/design.md §4.1, docs/api-contracts.md §1
 * Traces to: FR-1, FR-2
 */
import type { CensusGeocodeResponse } from '../types/api';
import type { GeocodedDistrict } from '../types/domain';
import { fipsToStateCode } from '../utils/fipsMap';
import { throwFromResponse } from './errorEnvelope';

const CD_LAYER = '119th Congressional Districts';

export async function geocodeAddress(
  address: string,
  apiBase: string,
): Promise<GeocodedDistrict> {
  const params = new URLSearchParams({
    address,
    benchmark: 'Public_AR_Current',
    vintage: 'Current_Current',
    format: 'json',
  });

  const url = `${apiBase}/api/census/geocoder/geographies/onelineaddress?${params}`;
  const res = await fetch(url);

  if (!res.ok) {
    // Preserves the FR-37 envelope (if upstream emitted one) so hook
    // consumers can surface userMessage + traceId + retryable via
    // getEnvelopeFromError. Plain `Error` fallback keeps pre-v2.6.0
    // contract when upstream is not FR-37-shaped.
    await throwFromResponse(res, 'Census geocoder');
  }

  const data: CensusGeocodeResponse = await res.json();
  const matches = data.result.addressMatches;

  if (matches.length === 0) {
    throw new Error('Address not found. Please enter a valid U.S. street address.');
  }

  const match = matches[0]!;
  const cdLayer = match.geographies[CD_LAYER];

  if (!cdLayer || cdLayer.length === 0) {
    throw new Error('Could not determine congressional district for this address.');
  }

  const cd = cdLayer[0]!;
  const stateFips = cd.STATE;
  const stateCode = fipsToStateCode(stateFips);

  if (!stateCode) {
    throw new Error(`Unknown state FIPS code: ${stateFips}`);
  }

  const district = parseInt(cd.CD119 ?? '0', 10);

  return {
    state: stateCode,
    district,
    matchedAddress: match.matchedAddress,
  };
}
