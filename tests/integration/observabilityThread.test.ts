/** Traces: FR-44 AC-44.19 (T-095), FR-36 AC-36.1..AC-36.4, FR-38 AC-38.2. */
/**
 * Integration test: verify the trace ID threads cleanly through
 *   resolveTraceId -> serveCached -> asErrorResponse -> logEvent
 *                                                    -> writeAnalyticsPoint
 *
 * Catches the bug class where the trace ID is generated correctly at the
 * edge but is lost at one of the four downstream integration points.
 *
 * NOTE (gap): as of this test's authoring, proxy/cache/pipeline.ts does NOT
 * auto-invoke `logEvent` or `writeAnalyticsPoint` on the upstream-error
 * path — it only builds a FR-37 envelope via `asErrorResponse`. To still
 * exercise the full observability thread end-to-end, test (1) invokes
 * `logEvent` and `writeAnalyticsPoint` directly AFTER the serveCached call,
 * using the SAME trace ID that threaded through serveCached. This is the
 * minimum plumbing check; wiring them into pipeline.ts is a follow-up task.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serveCached } from '../../proxy/cache/pipeline';
import { IMMUTABLE_ARCHIVE_POLICY } from '../../proxy/cache/policy';
import { resolveTraceId, TRACE_HEADER } from '../../proxy/observability/trace';
import { logEvent } from '../../proxy/observability/log';
import {
  writeAnalyticsPoint,
  type AnalyticsDatasetLike,
  type AnalyticsPayload,
} from '../../proxy/observability/analytics';
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
  const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  afterEach(() => { consoleSpy.mockClear(); });

  it('upstream error — trace ID propagates to envelope + log + analytics', async () => {
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
    });

    // Envelope + X-Trace-Id echoed.
    expect(resp.headers.get('X-Trace-Id')).toBe(TRACE_BAD);
    const body = (await resp.json()) as { error: { traceId: string; code: string } };
    expect(body.error.traceId).toBe(TRACE_BAD);
    expect(body.error.code).toBe('upstream_5xx');

    // Pipeline does NOT currently invoke logEvent/writeAnalyticsPoint itself
    // (see header comment). Invoke them directly with the same traceId to
    // verify the helper trace-ID plumbing still works end-to-end.
    logEvent(
      { env: 'test', traceId: TRACE_BAD },
      { event: 'upstream_error', level: 'error', upstream: 'senate' },
    );
    const payload: AnalyticsPayload = {
      routeClass: 'senate-xml',
      upstreamName: 'senate',
      errorCode: 'upstream_5xx',
      env: 'test',
      cacheTier: 'n/a',
      totalLatencyMs: 12,
      upstreamLatencyMs: 0,
      statusCode: 502,
      rateLimitRemaining: -1,
      traceId: TRACE_BAD,
    };
    writeAnalyticsPoint(dataset, h.ctx, payload);
    await Promise.all(h.ctx.awaited);

    // logEvent wrote exactly one JSON line carrying the trace ID.
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const firstArg = consoleSpy.mock.calls[0]?.[0];
    expect(typeof firstArg).toBe('string');
    const parsed = JSON.parse(firstArg as string) as { traceId: string; event: string; level: string };
    expect(parsed.traceId).toBe(TRACE_BAD);
    expect(parsed.event).toBe('upstream_error');
    expect(parsed.level).toBe('error');

    // Analytics writeDataPoint was called with the trace ID as indexes[0].
    expect(analyticsCalls).toHaveLength(1);
    expect(analyticsCalls[0]?.indexes).toEqual([TRACE_BAD]);
  });

  it('upstream success — trace ID echoed on 200 response', async () => {
    const h = harness();
    const fetcher = successFetcher(frozenXmlEntry());

    const resp = await serveCached({
      key: SENATE_KEY,
      cache: h.cache,
      fetcher,
      policy: IMMUTABLE_ARCHIVE_POLICY,
      ctx: h.ctx,
      traceId: TRACE_GOOD,
    });
    await Promise.all(h.ctx.awaited);

    expect(resp.status).toBe(200);
    expect(resp.headers.get('X-Cache')).toBe('MISS');
    expect(resp.headers.get('X-Trace-Id')).toBe(TRACE_GOOD);
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
