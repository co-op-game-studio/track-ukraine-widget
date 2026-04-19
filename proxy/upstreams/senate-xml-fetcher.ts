/**
 * SenateXmlFetcher — fetches raw Senate roll-call XML from senate.gov.
 *
 * URL schema:
 *   https://www.senate.gov/legislative/LIS/roll_call_votes/vote{c}{s}/vote_{c}_{s}_{rc}.xml
 * where rollCall is zero-padded to 5 digits.
 *
 * Returns the XML bytes verbatim (no parse). If a downstream caller needs
 * the JSON-projected roster shape (e.g. the /api/roll-call-rosters/senate/*
 * route hitting R2 on a cold KV), it invokes `parseSenateVoteXml` on the
 * bytes separately — see AC-41.7.
 *
 * sessionStatus is stamped at fetch time so R2Tier can gate on it without
 * re-deriving Congress calendar state later.
 *
 * Traces: FR-40 AC-40.7, FR-41 AC-41.4, FR-36 AC-36.3.
 */

import type { CacheKey } from '../cache/key';
import type { CacheEntry } from '../cache/tier';
import { isRollCallFrozen } from './congress-calendar';
import { applyTraceHeaderToUpstream } from '../observability/trace';
import type { UpstreamFetcher, UpstreamFetchContext } from './fetcher';

export interface SenateXmlFetcherDeps {
  fetch: typeof globalThis.fetch;
  now: () => Date;
}

export class SenateXmlFetcher implements UpstreamFetcher<string> {
  private readonly deps: SenateXmlFetcherDeps;

  constructor(deps?: Partial<SenateXmlFetcherDeps>) {
    this.deps = {
      fetch: deps?.fetch ?? globalThis.fetch.bind(globalThis),
      now: deps?.now ?? (() => new Date()),
    };
  }

  canHandle(key: CacheKey): boolean {
    return key.kind === 'senate-xml';
  }

  async fetch(key: CacheKey, ctx: UpstreamFetchContext): Promise<CacheEntry<string>> {
    if (key.kind !== 'senate-xml') {
      throw new Error(`SenateXmlFetcher: cannot handle kind '${key.kind}'`);
    }
    const congress = Number(key.params.congress);
    const session = Number(key.params.session);
    const rollCall = Number(key.params.rollCall);
    const padded = String(rollCall).padStart(5, '0');
    const url =
      `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${padded}.xml`;

    const headers = applyTraceHeaderToUpstream(
      { Accept: 'application/xml, text/xml;q=0.9, */*;q=0.1' },
      ctx.traceId,
    );
    const resp = await this.deps.fetch(url, { headers });
    if (!resp.ok) {
      throw new Error(`SenateXmlFetcher: upstream ${resp.status} for ${url}`);
    }
    const body = await resp.text();
    const contentType = resp.headers.get('Content-Type') ?? 'application/xml';
    const now = this.deps.now();

    const frozen = isRollCallFrozen({ congress, session, now });
    return {
      value: body,
      contentType,
      fetchedAt: now.getTime(),
      sourceUpstream: 'senate',
      sessionStatus: frozen ? 'frozen' : 'live',
    };
  }
}
