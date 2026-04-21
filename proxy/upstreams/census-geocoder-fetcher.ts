/**
 * CensusGeocoderFetcher — fetches the Census Bureau's address geocoder.
 *
 * The key carries the raw pathname + query from the inbound /api/census/*
 * request because the geocoder has many sub-endpoints (onelineaddress,
 * address, batch, ...) and we don't want this tier to encode route
 * knowledge.
 *
 * NOT R2-eligible. Each address → one near-unique response.
 *
 * Traces: FR-40 AC-40.7.
 */

import type { CacheKey } from '../cache/key';
import type { CacheEntry } from '../cache/tier';
import { applyTraceHeaderToUpstream } from '../observability/trace';
import type { UpstreamFetcher, UpstreamFetchContext } from './fetcher';

export interface CensusGeocoderFetcherDeps {
  fetch: typeof globalThis.fetch;
  now: () => Date;
}

export class CensusGeocoderFetcher implements UpstreamFetcher<string> {
  private readonly deps: CensusGeocoderFetcherDeps;

  constructor(deps?: Partial<CensusGeocoderFetcherDeps>) {
    this.deps = {
      fetch: deps?.fetch ?? globalThis.fetch.bind(globalThis),
      now: deps?.now ?? (() => new Date()),
    };
  }

  canHandle(key: CacheKey): boolean {
    return key.kind === 'census-geocoder';
  }

  async fetch(key: CacheKey, ctx: UpstreamFetchContext): Promise<CacheEntry<string>> {
    if (key.kind !== 'census-geocoder') {
      throw new Error(`CensusGeocoderFetcher: cannot handle kind '${key.kind}'`);
    }
    const path = String(key.params.path);
    const qs = String(key.params.qs);
    const url = `https://geocoding.geo.census.gov/${path}${qs ? '?' + qs : ''}`;

    const headers = applyTraceHeaderToUpstream({ Accept: 'application/json' }, ctx.traceId);
    const resp = await this.deps.fetch(url, { headers });
    if (!resp.ok) {
      throw new Error(`CensusGeocoderFetcher: upstream ${resp.status} for ${path}`);
    }
    const body = await resp.text();
    return {
      value: body,
      contentType: resp.headers.get('Content-Type') ?? 'application/json',
      fetchedAt: this.deps.now().getTime(),
      sourceUpstream: 'census',
    };
  }
}
