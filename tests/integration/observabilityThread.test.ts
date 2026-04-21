/** Traces: FR-44 AC-44.19 (T-095 + T-098), FR-36 AC-36.1..AC-36.4,
 *          FR-38 AC-38.2, AC-38.6, FR-39 AC-39.2.
 *
 * Verifies the trace ID threads cleanly through
 *   resolveTraceId -> serveCached (with observability) -> asErrorResponse
 *                                                      -> logEvent
 *                                                      -> writeAnalyticsPoint
 *
 * v2.6.0 T-098 tightened this from "verify helpers work in isolation" to
 * "verify serveCached itself invokes them." If an `observability` field is
 * supplied to serveCached, every request MUST emit exactly one analytics
 * data point (success or error) and error paths MUST additionally emit
 * one logEvent call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveCached } from '../../proxy/cache/pipeline';
import { IMMUTABLE_ARCHIVE_POLICY } from '../../proxy/cache/policy';
import { resolveTraceId, TRACE_HEADER } from '../../proxy/observability/trace';
import type { AnalyticsDatasetLike } from '../../proxy/observability/analytics';
import type { CacheKey } from '../../proxy/cache/key';
import type { CacheEntry } from '../../proxy/cache/tier';
import type { UpstreamFetcher } from '../../proxy/upstreams/fetcher';
import { harness } from './fixtures/fake-bindings';

const SENATE_KEY: CacheKey = {
  kind: 'senate-xml',
  params: { congress: 117, session: 2, rollCall: 78 },
};
const TRACE_BAD = 'tr_deadbeefcafebabe';
const TRACE_GOOD = 'tr_0123456789abcdef';
const XML_BODY = '<?xml version="1.0"?><roll_call_vote/>';

function throwingFetcher(message: string): UpstreamFetcher<string> {
  return {
    canHandle: () => true,
    fetch: async () => { throw new Error(message); },
  };
}

function successFetcher(entry: CacheEntry<string>): UpstreamFetcher<string> {
  return {
    canHandle: () => true,
    fetch: async () => entry,
  };
}

function frozenXmlEntry(): CacheEntry<string> {
  return {
    value: XML_BODY,
    contentType: 'application/xml',
    fetchedAt: 1_000,
    sourceUpstream: 'senate',
    sessionStatus: 'frozen',
  };
}

interface AnalyticsCall {
  blobs?: string[];
  doubles?: number[];
  indexes?: string[];
}

function makeAnalyticsFake(): { dataset: AnalyticsDatasetLike; calls: AnalyticsCall[] } {
  const calls: AnalyticsCall[] = [];
  const dataset: AnalyticsDatasetLike = {
    writeDataPoint: (point) => { calls.push(point as AnalyticsCall); },
  };
  return { dataset, calls };
}

describe('observability thread — trace id through pipeline + helpers', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { consoleSpy.mockRestore(); });

  it('upstream error — pipeline self-invokes logEvent + writeAnalyticsPoint with trace ID', async () => {
    const h = harness();
    const fetcher = throwingFetcher('upstream boom');
    const { dataset, calls: analyticsCalls } = makeAnalyticsFake();

    const resp = await serveCached({
      key: SENATE_KEY,
      cache: h.cache,
      fetcher,
      policy: IMMUTABLE_ARCHIVE_POLICY,
      ctx: h.ctx,
      traceId: TRACE_BAD,
      upstreamAttribution: 'senate',
      observability: {
        analytics: dataset,
        env: 'test',
        routeClass: 'senate-xml',
        upstreamName: 'senate',
      },
    });
    await Promise.all(h.ctx.awaited);

    // Envelope + X-Trace-Id echoed.
    expect(resp.headers.get('X-Trace-Id')).toBe(TRACE_BAD);
    const body = (await resp.json()) as { error: { traceId: string; code: string } };
    expect(body.error.traceId).toBe(TRACE_BAD);
    expect(body.error.code).toBe('upstream_5xx');

    // Pipeline auto-invoked logEvent with the trace ID + FR-37 code.
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const firstArg = consoleSpy.mock.calls[0]?.[0];
    expect(typeof firstArg).toBe('string');
    const parsed = JSON.parse(firstArg as string) as {
      traceId: string; event: string; level: string; upstream: string | null; status: number;
    };
    expect(parsed.traceId).toBe(TRACE_BAD);
    expect(parsed.event).toBe('upstream_5xx');
    // upstream_5xx is retryable → level=warn (per isRetryable).
    expect(parsed.level).toBe('warn');
    expect(parsed.upstream).toBe('senate');
    expect(parsed.status).toBe(502);

    // Pipeline auto-invoked writeAnalyticsPoint with indexes[0] = traceId
    // and errorCode in blobs[2].
    expect(analyticsCalls).toHaveLength(1);
    const call = analyticsCalls[0]!;
    expect(call.indexes).toEqual([TRACE_BAD]);
    expect(call.blobs?.[0]).toBe('senate-xml'); // routeClass
    expect(call.blobs?.[1]).toBe('senate');     // upstreamName
    expect(call.blobs?.[2]).toBe('upstream_5xx'); // errorCode
    expect(call.blobs?.[3]).toBe('test');       // env
    expect(call.blobs?.[4]).toBe('n/a');        // cacheTier for error
    expect(call.doubles?.[2]).toBe(502);        // statusCode
  });

  it('upstream success — pipeline self-invokes writeAnalyticsPoint only (no log on success)', async () => {
    const h = harness();
    const fetcher = successFetcher(frozenXmlEntry());
    const { dataset, calls: analyticsCalls } = makeAnalyticsFake();

    const resp = await serveCached({
      key: SENATE_KEY,
      cache: h.cache,
      fetcher,
      policy: IMMUTABLE_ARCHIVE_POLICY,
      ctx: h.ctx,
      traceId: TRACE_GOOD,
      observability: {
        analytics: dataset,
        env: 'test',
        routeClass: 'senate-xml',
        upstreamName: 'senate',
      },
    });
    await Promise.all(h.ctx.awaited);

    expect(resp.status).toBe(200);
    expect(resp.headers.get('X-Cache')).toBe('MISS');
    expect(resp.headers.get('X-Trace-Id')).toBe(TRACE_GOOD);

    // AC-39.3: success paths emit NO log lines.
    expect(consoleSpy).not.toHaveBeenCalled();

    // But analytics IS emitted on success, with errorCode='ok'.
    expect(analyticsCalls).toHaveLength(1);
    const call = analyticsCalls[0]!;
    expect(call.indexes).toEqual([TRACE_GOOD]);
    expect(call.blobs?.[2]).toBe('ok');
    expect(call.blobs?.[4]).toBe('upstream'); // cacheTier: upstream on MISS
    expect(call.doubles?.[2]).toBe(200);
  });

  it('cache hit — pipeline emits analytics with cacheTier reflecting the serving tier', async () => {
    const h = harness();
    const { dataset, calls: analyticsCalls } = makeAnalyticsFake();
    // First miss populates all tiers.
    await serveCached({
      key: SENATE_KEY,
      cache: h.cache,
      fetcher: successFetcher(frozenXmlEntry()),
      policy: IMMUTABLE_ARCHIVE_POLICY,
      ctx: h.ctx,
      traceId: 'tr_first000000000',
      observability: { analytics: dataset, env: 'test', routeClass: 'senate-xml', upstreamName: 'senate' },
    });
    await Promise.all(h.ctx.awaited);
    // Second request hits edge.
    const resp = await serveCached({
      key: SENATE_KEY,
      cache: h.cache,
      fetcher: successFetcher(frozenXmlEntry()),
      policy: IMMUTABLE_ARCHIVE_POLICY,
      ctx: h.ctx,
      traceId: TRACE_GOOD,
      observability: { analytics: dataset, env: 'test', routeClass: 'senate-xml', upstreamName: 'senate' },
    });
    expect(resp.headers.get('X-Cache')).toBe('HIT');
    expect(resp.headers.get('X-Cache-Tier')).toBe('edge');
    // Two analytics writes so far; second one is the hit.
    expect(analyticsCalls.length).toBeGreaterThanOrEqual(2);
    const hitCall = analyticsCalls[analyticsCalls.length - 1]!;
    expect(hitCall.indexes).toEqual([TRACE_GOOD]);
    expect(hitCall.blobs?.[4]).toBe('edge');
    expect(hitCall.doubles?.[1]).toBe(0); // upstreamLatencyMs = 0 on hit
  });

  it('no observability field — pipeline does NOT emit log or analytics (back-compat)', async () => {
    const h = harness();
    const fetcher = throwingFetcher('still boom');
    const resp = await serveCached({
      key: SENATE_KEY,
      cache: h.cache,
      fetcher,
      policy: IMMUTABLE_ARCHIVE_POLICY,
      ctx: h.ctx,
      traceId: TRACE_BAD,
      upstreamAttribution: 'senate',
    });
    await Promise.all(h.ctx.awaited);
    expect(resp.status).toBe(502);
    // Envelope still emitted.
    const body = (await resp.json()) as { error: { traceId: string } };
    expect(body.error.traceId).toBe(TRACE_BAD);
    // But no log, no analytics.
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('resolveTraceId + end-to-end — client-supplied trace echoed unchanged', async () => {
    const request = new Request('https://edge.cache.test/senate-xml', {
      headers: { [TRACE_HEADER]: TRACE_GOOD },
    });
    const resolved = resolveTraceId(request);
    expect(resolved).toBe(TRACE_GOOD);

    const h = harness();
    const fetcher = successFetcher(frozenXmlEntry());
    const resp = await serveCached({
      key: SENATE_KEY,
      cache: h.cache,
      fetcher,
      policy: IMMUTABLE_ARCHIVE_POLICY,
      ctx: h.ctx,
      traceId: resolved,
    });
    await Promise.all(h.ctx.awaited);

    expect(resp.headers.get('X-Trace-Id')).toBe(TRACE_GOOD);
  });
});
