/**
 * BillSummariesFetcher — fetches CRS bill summaries from api.congress.gov
 * at /v3/bill/{c}/{type}/{num}/summaries.
 *
 * Age-gated same way as BillActionsFetcher. CRS summaries carry
 * `updateDate` ISO fields; we pick the latest.
 *
 * Traces: FR-40 AC-40.7, FR-41 AC-41.4.
 */

import type { CacheKey } from '../cache/key';
import type { CacheEntry } from '../cache/tier';
import { isBillFrozen } from './congress-calendar';
import { applyTraceHeaderToUpstream } from '../observability/trace';
import type { UpstreamFetcher, UpstreamFetchContext } from './fetcher';

export interface BillSummariesFetcherDeps {
  apiKey: string;
  fetch: typeof globalThis.fetch;
  now: () => Date;
}

export function extractLatestSummaryUpdate(body: string): Date | null {
  const matches = body.match(/"updateDate"\s*:\s*"(\d{4}-\d{2}-\d{2})"/g);
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

export class BillSummariesFetcher implements UpstreamFetcher<string> {
  private readonly deps: BillSummariesFetcherDeps;

  constructor(deps: { apiKey: string; fetch?: typeof globalThis.fetch; now?: () => Date }) {
    this.deps = {
      apiKey: deps.apiKey,
      fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
      now: deps.now ?? (() => new Date()),
    };
  }

  canHandle(key: CacheKey): boolean {
    return key.kind === 'bill-summaries';
  }

  async fetch(key: CacheKey, ctx: UpstreamFetchContext): Promise<CacheEntry<string>> {
    if (key.kind !== 'bill-summaries') {
      throw new Error(`BillSummariesFetcher: cannot handle kind '${key.kind}'`);
    }
    const congress = Number(key.params.congress);
    const type = String(key.params.type);
    const number = Number(key.params.number);
    const url = new URL(`https://api.congress.gov/v3/bill/${congress}/${type}/${number}/summaries`);
    url.searchParams.set('api_key', this.deps.apiKey);
    url.searchParams.set('format', 'json');

    const headers = applyTraceHeaderToUpstream({ Accept: 'application/json' }, ctx.traceId);
    const resp = await this.deps.fetch(url.toString(), { headers });
    if (!resp.ok) {
      throw new Error(`BillSummariesFetcher: upstream ${resp.status} for ${url.pathname}`);
    }
    const body = await resp.text();
    const now = this.deps.now();
    const latest = extractLatestSummaryUpdate(body);
    return {
      value: body,
      contentType: resp.headers.get('Content-Type') ?? 'application/json',
      fetchedAt: now.getTime(),
      sourceUpstream: 'congress',
      sessionStatus: isBillFrozen({ latestActionDate: latest, now }) ? 'frozen' : 'live',
    };
  }
}
