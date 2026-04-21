/**
 * BillActionsFetcher — fetches bill-actions JSON from api.congress.gov at
 * /v3/bill/{c}/{type}/{num}/actions.
 *
 * R2 eligibility is age-gated (AC-41.4): freeze when the bill's latest
 * action date is >180 days before now. The upstream response carries a
 * `latestAction.actionDate` field (ISO date). We parse just enough to
 * compute the gate, without fully reshaping the body.
 *
 * Traces: FR-40 AC-40.7, FR-41 AC-41.4.
 */

import type { CacheKey } from '../cache/key';
import type { CacheEntry } from '../cache/tier';
import { isBillFrozen } from './congress-calendar';
import { applyTraceHeaderToUpstream } from '../observability/trace';
import type { UpstreamFetcher, UpstreamFetchContext } from './fetcher';

export interface BillActionsFetcherDeps {
  apiKey: string;
  fetch: typeof globalThis.fetch;
  now: () => Date;
}

/** Parse the latest ISO actionDate we can find in an actions response. */
export function extractLatestActionDate(body: string): Date | null {
  const matches = body.match(/"actionDate"\s*:\s*"(\d{4}-\d{2}-\d{2})"/g);
  if (!matches || matches.length === 0) return null;
  let latest = 0;
  for (const m of matches) {
    const d = m.match(/"(\d{4}-\d{2}-\d{2})"/)?.[1];
    if (!d) continue;
    const t = new Date(d + 'T00:00:00Z').getTime();
    if (t > latest) latest = t;
  }
  return latest > 0 ? new Date(latest) : null;
}

export class BillActionsFetcher implements UpstreamFetcher<string> {
  private readonly deps: BillActionsFetcherDeps;

  constructor(deps: { apiKey: string; fetch?: typeof globalThis.fetch; now?: () => Date }) {
    this.deps = {
      apiKey: deps.apiKey,
      fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
      now: deps.now ?? (() => new Date()),
    };
  }

  canHandle(key: CacheKey): boolean {
    return key.kind === 'bill-actions';
  }

  async fetch(key: CacheKey, ctx: UpstreamFetchContext): Promise<CacheEntry<string>> {
    if (key.kind !== 'bill-actions') {
      throw new Error(`BillActionsFetcher: cannot handle kind '${key.kind}'`);
    }
    const congress = Number(key.params.congress);
    const type = String(key.params.type);
    const number = Number(key.params.number);
    const url = new URL(`https://api.congress.gov/v3/bill/${congress}/${type}/${number}/actions`);
    url.searchParams.set('api_key', this.deps.apiKey);
    url.searchParams.set('format', 'json');

    const headers = applyTraceHeaderToUpstream({ Accept: 'application/json' }, ctx.traceId);
    const resp = await this.deps.fetch(url.toString(), { headers });
    if (!resp.ok) {
      throw new Error(`BillActionsFetcher: upstream ${resp.status} for ${url.pathname}`);
    }
    const body = await resp.text();
    const now = this.deps.now();
    const latest = extractLatestActionDate(body);
    return {
      value: body,
      contentType: resp.headers.get('Content-Type') ?? 'application/json',
      fetchedAt: now.getTime(),
      sourceUpstream: 'congress',
      sessionStatus: isBillFrozen({ latestActionDate: latest, now }) ? 'frozen' : 'live',
    };
  }
}
