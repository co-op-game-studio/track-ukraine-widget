/** Traces: FR-44 AC-44.2. */
/**
 * Integration tests driving 20+ realistic /api/* sample paths through the
 * matchRoute → serveCached → FakeTier + stubbed fetcher composition.
 *
 * Companion task T-080 exercises serveCached with real tier classes +
 * fake bindings; this file uses FakeTier so the focus stays on routing.
 */
import { describe, expect, it } from 'vitest';
import { matchRoute } from '../../proxy/routes/cache-config';
import { serveCached } from '../../proxy/cache/pipeline';
import { TieredCache } from '../../proxy/cache/tiered-cache';
import { FakeTier, makeCtx } from '../fakes/fake-tier';
import type { CacheKey, CacheKind } from '../../proxy/cache/key';
import type { CacheEntry } from '../../proxy/cache/tier';
import type { UpstreamFetcher, UpstreamFetchContext } from '../../proxy/upstreams/fetcher';

const TRACE = 'tr_0123456789abcdef';

type Resolver = (k: CacheKey, ctx: UpstreamFetchContext) => CacheEntry<string> | Error;

class FixtureFetcher implements UpstreamFetcher<string> {
  public readonly calls: CacheKey[] = [];
  constructor(private readonly resolver: Resolver) {}
  canHandle(_key: CacheKey): boolean { return true; }
  async fetch(key: CacheKey, ctx: UpstreamFetchContext): Promise<CacheEntry<string>> {
    this.calls.push(key);
    const r = this.resolver(key, ctx);
    if (r instanceof Error) throw r;
    return r;
  }
}

function makeEntry(overrides: Partial<CacheEntry<string>> = {}): CacheEntry<string> {
  return {
    value: 'body',
    contentType: 'application/json',
    fetchedAt: 1_000,
    sourceUpstream: 'congress',
    sessionStatus: 'frozen',
    ...overrides,
  };
}

function freshCache(): TieredCache<string> {
  return new TieredCache([new FakeTier<string>('edge'), new FakeTier<string>('kv')]);
}

async function runMiss(url: string): Promise<{ match: NonNullable<ReturnType<typeof matchRoute>>; resp: Response }> {
  const req = new Request(url);
  const match = matchRoute(req);
  expect(match).not.toBeNull();
  const cache = freshCache();
  const fetcher = new FixtureFetcher(() => makeEntry({ value: 'fresh:' + url }));
  const ctx = makeCtx();
  const resp = await serveCached({
    key: match!.key,
    cache,
    fetcher,
    policy: match!.policy,
    ctx,
    traceId: TRACE,
  });
  return { match: match!, resp };
}

function expectMissHeaders(resp: Response): void {
  expect(resp.status).toBe(200);
  expect(resp.headers.get('X-Cache')).toBe('MISS');
  expect(resp.headers.get('X-Cache-Tier')).toBe('upstream');
  expect(resp.headers.get('X-Trace-Id')).toBe(TRACE);
}

describe('matchRoute × serveCached — senate-xml (AC-44.2)', () => {
  it('117/2/78 → senate-xml key + round-trip MISS', async () => {
    const { match, resp } = await runMiss(
      'https://x.test/api/senate/legislative/LIS/roll_call_votes/vote1172/vote_117_2_00078.xml',
    );
    expect(match.cacheKind).toBe<CacheKind>('senate-xml');
    expect(match.key.params).toEqual({ congress: 117, session: 2, rollCall: 78 });
    expectMissHeaders(resp);
  });

  it('118/1/342 → senate-xml key', async () => {
    const { match, resp } = await runMiss(
      'https://x.test/api/senate/legislative/LIS/roll_call_votes/vote1181/vote_118_1_00342.xml',
    );
    expect(match.cacheKind).toBe<CacheKind>('senate-xml');
    expect(match.key.params).toEqual({ congress: 118, session: 1, rollCall: 342 });
    expectMissHeaders(resp);
  });

  it('119/2/5 → senate-xml key', async () => {
    const { match, resp } = await runMiss(
      'https://x.test/api/senate/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00005.xml',
    );
    expect(match.cacheKind).toBe<CacheKind>('senate-xml');
    expect(match.key.params).toEqual({ congress: 119, session: 2, rollCall: 5 });
    expectMissHeaders(resp);
  });
});

describe('matchRoute × serveCached — house-roster', () => {
  it('118/1/5 → house-roster', async () => {
    const { match, resp } = await runMiss('https://x.test/api/congress/v3/house-vote/118/1/5/members');
    expect(match.cacheKind).toBe<CacheKind>('house-roster');
    expect(match.key.params).toEqual({ congress: 118, session: 1, rollCall: 5 });
    expectMissHeaders(resp);
  });

  it('117/2/78 → house-roster', async () => {
    const { match, resp } = await runMiss('https://x.test/api/congress/v3/house-vote/117/2/78/members');
    expect(match.cacheKind).toBe<CacheKind>('house-roster');
    expect(match.key.params).toEqual({ congress: 117, session: 2, rollCall: 78 });
    expectMissHeaders(resp);
  });
});

describe('matchRoute × serveCached — house-vote-detail', () => {
  it('118/1/5 → house-vote-detail', async () => {
    const { match, resp } = await runMiss('https://x.test/api/congress/v3/house-vote/118/1/5');
    expect(match.cacheKind).toBe<CacheKind>('house-vote-detail');
    expect(match.key.params).toEqual({ congress: 118, session: 1, rollCall: 5 });
    expectMissHeaders(resp);
  });

  it('117/2/78 → house-vote-detail', async () => {
    const { match, resp } = await runMiss('https://x.test/api/congress/v3/house-vote/117/2/78');
    expect(match.cacheKind).toBe<CacheKind>('house-vote-detail');
    expectMissHeaders(resp);
  });
});

describe('matchRoute × serveCached — bill-actions', () => {
  it('117/hr/7691 → bill-actions', async () => {
    const { match, resp } = await runMiss('https://x.test/api/congress/v3/bill/117/hr/7691/actions');
    expect(match.cacheKind).toBe<CacheKind>('bill-actions');
    expect(match.key.params).toEqual({ congress: 117, type: 'hr', number: 7691 });
    expectMissHeaders(resp);
  });

  it('118/s/17 → bill-actions', async () => {
    const { match, resp } = await runMiss('https://x.test/api/congress/v3/bill/118/s/17/actions');
    expect(match.cacheKind).toBe<CacheKind>('bill-actions');
    expect(match.key.params).toEqual({ congress: 118, type: 's', number: 17 });
    expectMissHeaders(resp);
  });
});

describe('matchRoute × serveCached — bill-summaries', () => {
  it('117/hr/7691 → bill-summaries', async () => {
    const { match, resp } = await runMiss('https://x.test/api/congress/v3/bill/117/hr/7691/summaries');
    expect(match.cacheKind).toBe<CacheKind>('bill-summaries');
    expect(match.key.params).toEqual({ congress: 117, type: 'hr', number: 7691 });
    expectMissHeaders(resp);
  });

  it('118/s/17 → bill-summaries', async () => {
    const { match, resp } = await runMiss('https://x.test/api/congress/v3/bill/118/s/17/summaries');
    expect(match.cacheKind).toBe<CacheKind>('bill-summaries');
    expectMissHeaders(resp);
  });
});

describe('matchRoute × serveCached — member-detail', () => {
  it('D000563 → member-detail', async () => {
    const { match, resp } = await runMiss('https://x.test/api/congress/v3/member/D000563');
    expect(match.cacheKind).toBe<CacheKind>('member-detail');
    expect(match.key.params).toEqual({ bioguideId: 'D000563' });
    expectMissHeaders(resp);
  });

  it('A000370 → member-detail', async () => {
    const { match, resp } = await runMiss('https://x.test/api/congress/v3/member/A000370');
    expect(match.cacheKind).toBe<CacheKind>('member-detail');
    expect(match.key.params).toEqual({ bioguideId: 'A000370' });
    expectMissHeaders(resp);
  });
});

describe('matchRoute × serveCached — census-geocoder', () => {
  it('drops attacker-controlled qs params + keeps allowlist', async () => {
    const url =
      'https://x.test/api/census/geocoder/geographies/onelineaddress?address=1600+Penn&benchmark=4&vintage=Current_Current&format=json&attacker=xxx';
    const req = new Request(url);
    const match = matchRoute(req);
    expect(match).not.toBeNull();
    expect(match!.cacheKind).toBe<CacheKind>('census-geocoder');
    expect(match!.key.params.path).toBe('geocoder/geographies/onelineaddress');
    const qs = String(match!.key.params.qs);
    expect(qs).not.toContain('attacker');
    expect(qs).toContain('address=1600');
    expect(qs).toContain('benchmark=4');
    expect(qs).toContain('vintage=Current_Current');
    expect(qs).toContain('format=json');

    const cache = freshCache();
    const fetcher = new FixtureFetcher(() => makeEntry({ sourceUpstream: 'census' }));
    const resp = await serveCached({
      key: match!.key,
      cache,
      fetcher,
      policy: match!.policy,
      ctx: makeCtx(),
      traceId: TRACE,
    });
    expectMissHeaders(resp);
  });

  it('addressbatch with no query string → empty qs', async () => {
    const req = new Request('https://x.test/api/census/geocoder/geographies/addressbatch');
    const match = matchRoute(req);
    expect(match).not.toBeNull();
    expect(match!.cacheKind).toBe<CacheKind>('census-geocoder');
    expect(match!.key.params.path).toBe('geocoder/geographies/addressbatch');
    expect(match!.key.params.qs).toBe('');
  });
});

describe('matchRoute — negative cases return null', () => {
  it.each([
    ['root', 'https://x.test/'],
    ['widget js', 'https://x.test/voter-info-widget.iife.js'],
    ['KV members route', 'https://x.test/api/members/D000563'],
    ['KV name-search route', 'https://x.test/api/name-search?q=x'],
    ['unknown /api/congress path', 'https://x.test/api/congress/v3/totally/unknown'],
    ['KV roll-call-rosters route', 'https://x.test/api/roll-call-rosters/house/117/2/78'],
  ])('%s → null', (_label, url) => {
    expect(matchRoute(new Request(url))).toBeNull();
  });
});

describe('matchRoute × serveCached — envelope + header behaviors', () => {
  it('response always carries X-Cache, X-Cache-Tier, X-Trace-Id', async () => {
    const { resp } = await runMiss('https://x.test/api/congress/v3/bill/117/hr/7691/actions');
    expect(resp.headers.get('X-Cache')).toBe('MISS');
    expect(resp.headers.get('X-Cache-Tier')).toBe('upstream');
    expect(resp.headers.get('X-Trace-Id')).toBe(TRACE);
  });

  it('fetcher throw → FR-37 envelope with retryable=true + traceId', async () => {
    const req = new Request('https://x.test/api/congress/v3/member/D000563');
    const match = matchRoute(req);
    expect(match).not.toBeNull();
    const cache = freshCache();
    const fetcher = new FixtureFetcher(() => new Error('upstream 503'));
    const resp = await serveCached({
      key: match!.key,
      cache,
      fetcher,
      policy: match!.policy,
      ctx: makeCtx(),
      traceId: TRACE,
      upstreamAttribution: 'congress',
    });
    expect(resp.status).toBe(502);
    expect(resp.headers.get('Content-Type')).toContain('application/json');
    const body = (await resp.json()) as {
      error: {
        code: string;
        message: string;
        userMessage: string;
        upstream: string | null;
        retryable: boolean;
        traceId: string;
      };
    };
    expect(body.error.code).toBe('upstream_5xx');
    expect(body.error.retryable).toBe(true);
    expect(body.error.upstream).toBe('congress');
    expect(body.error.traceId).toBe(TRACE);
    expect(body.error.userMessage.length).toBeGreaterThan(0);
    expect(body.error.message).toContain('upstream 503');
  });

  it('second request for the same path transitions X-Cache-Tier upstream → edge', async () => {
    const url = 'https://x.test/api/congress/v3/house-vote/118/1/5/members';
    const req = new Request(url);
    const match = matchRoute(req);
    expect(match).not.toBeNull();
    const cache = freshCache();
    const fetcher = new FixtureFetcher(() => makeEntry({ value: 'roster-bytes' }));
    const ctx = makeCtx();

    const first = await serveCached({
      key: match!.key, cache, fetcher, policy: match!.policy, ctx, traceId: TRACE,
    });
    expect(first.headers.get('X-Cache-Tier')).toBe('upstream');
    // Flush writeback to populate edge before the second read.
    await Promise.all(ctx.awaited);

    const second = await serveCached({
      key: match!.key, cache, fetcher, policy: match!.policy, ctx: makeCtx(), traceId: TRACE,
    });
    expect(second.headers.get('X-Cache')).toBe('HIT');
    expect(second.headers.get('X-Cache-Tier')).toBe('edge');
    expect(await second.text()).toBe('roster-bytes');
    expect(fetcher.calls).toHaveLength(1);
  });
});
