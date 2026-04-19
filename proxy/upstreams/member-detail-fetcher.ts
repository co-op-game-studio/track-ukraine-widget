/**
 * MemberDetailFetcher — fetches /v3/member/{bioguideId} from api.congress.gov.
 *
 * NOT R2-eligible. Member status (district, party, photo URL, terms)
 * rotates mid-Congress. Freshness > performance. `sessionStatus` is
 * never stamped, so R2Tier's gate rejects these by default.
 *
 * Traces: FR-40 AC-40.7, FR-41 data-type matrix.
 */

import type { CacheKey } from '../cache/key';
import type { CacheEntry } from '../cache/tier';
import { applyTraceHeaderToUpstream } from '../observability/trace';
import type { UpstreamFetcher, UpstreamFetchContext } from './fetcher';

export interface MemberDetailFetcherDeps {
  apiKey: string;
  fetch: typeof globalThis.fetch;
  now: () => Date;
}

export class MemberDetailFetcher implements UpstreamFetcher<string> {
  private readonly deps: MemberDetailFetcherDeps;

  constructor(deps: { apiKey: string; fetch?: typeof globalThis.fetch; now?: () => Date }) {
    this.deps = {
      apiKey: deps.apiKey,
      fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
      now: deps.now ?? (() => new Date()),
    };
  }

  canHandle(key: CacheKey): boolean {
    return key.kind === 'member-detail';
  }

  async fetch(key: CacheKey, ctx: UpstreamFetchContext): Promise<CacheEntry<string>> {
    if (key.kind !== 'member-detail') {
      throw new Error(`MemberDetailFetcher: cannot handle kind '${key.kind}'`);
    }
    const bioguideId = String(key.params.bioguideId);
    const url = new URL(`https://api.congress.gov/v3/member/${bioguideId}`);
    url.searchParams.set('api_key', this.deps.apiKey);
    url.searchParams.set('format', 'json');

    const headers = applyTraceHeaderToUpstream({ Accept: 'application/json' }, ctx.traceId);
    const resp = await this.deps.fetch(url.toString(), { headers });
    if (!resp.ok) {
      throw new Error(`MemberDetailFetcher: upstream ${resp.status} for ${url.pathname}`);
    }
    const body = await resp.text();
    return {
      value: body,
      contentType: resp.headers.get('Content-Type') ?? 'application/json',
      fetchedAt: this.deps.now().getTime(),
      sourceUpstream: 'congress',
      // No sessionStatus — this data never belongs in R2.
    };
  }
}
