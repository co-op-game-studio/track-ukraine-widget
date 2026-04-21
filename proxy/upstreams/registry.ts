/**
 * UpstreamFetcher registry — picks the right fetcher for a CacheKey.
 *
 * One concrete fetcher per upstream; dispatch via `canHandle`. Fail-loud
 * on unknown kinds — we want to surface missing wiring, not silently
 * fall through.
 *
 * Traces: FR-40 AC-40.7.
 */

import type { CacheKey } from '../cache/key';
import type { UpstreamFetcher } from './fetcher';
import { SenateXmlFetcher } from './senate-xml-fetcher';
import { HouseRosterFetcher } from './house-roster-fetcher';
import { HouseVoteDetailFetcher } from './house-vote-detail-fetcher';
import { BillActionsFetcher } from './bill-actions-fetcher';
import { BillSummariesFetcher } from './bill-summaries-fetcher';
import { MemberDetailFetcher } from './member-detail-fetcher';
import { CensusGeocoderFetcher } from './census-geocoder-fetcher';

export interface UpstreamRegistryDeps {
  apiKey: string;
  fetch: typeof globalThis.fetch;
  now: () => Date;
}

export interface UpstreamRegistry {
  getFor(key: CacheKey): UpstreamFetcher<string> | null;
}

export function createUpstreamRegistry(deps: UpstreamRegistryDeps): UpstreamRegistry {
  const fetchers: Array<UpstreamFetcher<string>> = [
    new SenateXmlFetcher({ fetch: deps.fetch, now: deps.now }),
    new HouseRosterFetcher(deps),
    new HouseVoteDetailFetcher(deps),
    new BillActionsFetcher(deps),
    new BillSummariesFetcher(deps),
    new MemberDetailFetcher(deps),
    new CensusGeocoderFetcher({ fetch: deps.fetch, now: deps.now }),
  ];

  return {
    getFor(key: CacheKey): UpstreamFetcher<string> | null {
      for (const f of fetchers) {
        if (f.canHandle(key)) return f;
      }
      return null;
    },
  };
}
