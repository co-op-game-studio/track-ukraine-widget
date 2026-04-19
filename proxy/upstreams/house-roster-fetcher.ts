/**
 * HouseRosterFetcher — fetches House roll-call member rosters from
 * api.congress.gov.
 *
 * URL: https://api.congress.gov/v3/house-vote/{c}/{s}/{rc}/members
 * Query: api_key + format=json + limit=500 (one page covers every House
 *        rep even in a unanimous vote).
 *
 * Returns the JSON body verbatim. Downstream callers that need the
 * roster-projected shape (/api/roll-call-rosters/house/*) can parse it on
 * demand — this fetcher stays byte-verbatim so R2 stores exactly what
 * upstream returned.
 *
 * Traces: FR-40 AC-40.7, FR-41 AC-41.4, FR-36 AC-36.3.
 */

import type { CacheKey } from '../cache/key';
import type { CacheEntry } from '../cache/tier';
import { isRollCallFrozen } from './congress-calendar';
import { applyTraceHeaderToUpstream } from '../observability/trace';
import type { UpstreamFetcher, UpstreamFetchContext } from './fetcher';

export interface HouseRosterFetcherDeps {
  apiKey: string;
  fetch: typeof globalThis.fetch;
  now: () => Date;
}

export class HouseRosterFetcher implements UpstreamFetcher<string> {
  private readonly deps: HouseRosterFetcherDeps;

  constructor(deps: { apiKey: string; fetch?: typeof globalThis.fetch; now?: () => Date }) {
    this.deps = {
      apiKey: deps.apiKey,
      fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
      now: deps.now ?? (() => new Date()),
    };
  }

  canHandle(key: CacheKey): boolean {
    return key.kind === 'house-roster';
  }

  async fetch(key: CacheKey, ctx: UpstreamFetchContext): Promise<CacheEntry<string>> {
    if (key.kind !== 'house-roster') {
      throw new Error(`HouseRosterFetcher: cannot handle kind '${key.kind}'`);
    }
    const congress = Number(key.params.congress);
    const session = Number(key.params.session);
    const rollCall = Number(key.params.rollCall);
    const url = new URL(
      `https://api.congress.gov/v3/house-vote/${congress}/${session}/${rollCall}/members`,
    );
    url.searchParams.set('api_key', this.deps.apiKey);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '500');

    const headers = applyTraceHeaderToUpstream({ Accept: 'application/json' }, ctx.traceId);
    const resp = await this.deps.fetch(url.toString(), { headers });
    if (!resp.ok) {
      throw new Error(`HouseRosterFetcher: upstream ${resp.status} for ${url.pathname}`);
    }
    const body = await resp.text();
    const now = this.deps.now();
    const frozen = isRollCallFrozen({ congress, session, now });
    return {
      value: body,
      contentType: resp.headers.get('Content-Type') ?? 'application/json',
      fetchedAt: now.getTime(),
      sourceUpstream: 'congress',
      sessionStatus: frozen ? 'frozen' : 'live',
    };
  }
}
