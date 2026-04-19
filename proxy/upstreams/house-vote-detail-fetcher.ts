/**
 * HouseVoteDetailFetcher — fetches House roll-call detail JSON from
 * api.congress.gov at /v3/house-vote/{c}/{s}/{rc}.
 *
 * R2-eligible (static after session close).
 *
 * Traces: FR-40 AC-40.7, FR-41 AC-41.4.
 */

import type { CacheKey } from '../cache/key';
import type { CacheEntry } from '../cache/tier';
import { isRollCallFrozen } from './congress-calendar';
import { applyTraceHeaderToUpstream } from '../observability/trace';
import type { UpstreamFetcher, UpstreamFetchContext } from './fetcher';

export interface HouseVoteDetailFetcherDeps {
  apiKey: string;
  fetch: typeof globalThis.fetch;
  now: () => Date;
}

export class HouseVoteDetailFetcher implements UpstreamFetcher<string> {
  private readonly deps: HouseVoteDetailFetcherDeps;

  constructor(deps: { apiKey: string; fetch?: typeof globalThis.fetch; now?: () => Date }) {
    this.deps = {
      apiKey: deps.apiKey,
      fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
      now: deps.now ?? (() => new Date()),
    };
  }

  canHandle(key: CacheKey): boolean {
    return key.kind === 'house-vote-detail';
  }

  async fetch(key: CacheKey, ctx: UpstreamFetchContext): Promise<CacheEntry<string>> {
    if (key.kind !== 'house-vote-detail') {
      throw new Error(`HouseVoteDetailFetcher: cannot handle kind '${key.kind}'`);
    }
    const congress = Number(key.params.congress);
    const session = Number(key.params.session);
    const rollCall = Number(key.params.rollCall);
    const url = new URL(`https://api.congress.gov/v3/house-vote/${congress}/${session}/${rollCall}`);
    url.searchParams.set('api_key', this.deps.apiKey);
    url.searchParams.set('format', 'json');

    const headers = applyTraceHeaderToUpstream({ Accept: 'application/json' }, ctx.traceId);
    const resp = await this.deps.fetch(url.toString(), { headers });
    if (!resp.ok) {
      throw new Error(`HouseVoteDetailFetcher: upstream ${resp.status} for ${url.pathname}`);
    }
    const body = await resp.text();
    const now = this.deps.now();
    return {
      value: body,
      contentType: resp.headers.get('Content-Type') ?? 'application/json',
      fetchedAt: now.getTime(),
      sourceUpstream: 'congress',
      sessionStatus: isRollCallFrozen({ congress, session, now }) ? 'frozen' : 'live',
    };
  }
}
