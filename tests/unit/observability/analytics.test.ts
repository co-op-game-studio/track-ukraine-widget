/**
 * Tests for proxy/observability/analytics.ts — Workers Analytics Engine writer.
 *
 * Traces to FR-38 AC-38.1..AC-38.6 (spec.md v2.6.0).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  writeAnalyticsPoint,
  type AnalyticsDatasetLike,
  type AnalyticsPayload,
  type WaitUntilLike,
} from '../../../proxy/observability/analytics';

function makeFake(): {
  dataset: AnalyticsDatasetLike;
  calls: Array<{ blobs?: string[]; doubles?: number[]; indexes?: string[] }>;
} {
  const calls: Array<{ blobs?: string[]; doubles?: number[]; indexes?: string[] }> = [];
  const dataset: AnalyticsDatasetLike = {
    writeDataPoint: (point) => calls.push(point as typeof calls[number]),
  };
  return { dataset, calls };
}

function makeWaitUntil(): { ctx: WaitUntilLike; awaited: Array<Promise<unknown>> } {
  const awaited: Array<Promise<unknown>> = [];
  return {
    ctx: { waitUntil: (p) => { awaited.push(p); } },
    awaited,
  };
}

const BASE_PAYLOAD: AnalyticsPayload = {
  routeClass: 'members',
  upstreamName: 'congress',
  errorCode: 'ok',
  env: 'prod',
  cacheTier: 'kv',
  totalLatencyMs: 42,
  upstreamLatencyMs: 0,
  statusCode: 200,
  rateLimitRemaining: 58,
  traceId: 'tr_0123456789abcdef',
};

describe('writeAnalyticsPoint — AC-38.2: blob+double+index shape', () => {
  it('writes exactly one data point per call', () => {
    const { dataset, calls } = makeFake();
    const { ctx } = makeWaitUntil();
    writeAnalyticsPoint(dataset, ctx, BASE_PAYLOAD);
    expect(calls).toHaveLength(1);
  });

  it('packs blobs in the AC-38.2 order', () => {
    const { dataset, calls } = makeFake();
    const { ctx } = makeWaitUntil();
    writeAnalyticsPoint(dataset, ctx, BASE_PAYLOAD);
    expect(calls[0]?.blobs).toEqual(['members', 'congress', 'ok', 'prod', 'kv']);
  });

  it('packs doubles in the AC-38.2 order', () => {
    const { dataset, calls } = makeFake();
    const { ctx } = makeWaitUntil();
    writeAnalyticsPoint(dataset, ctx, BASE_PAYLOAD);
    expect(calls[0]?.doubles).toEqual([42, 0, 200, 58]);
  });

  it('packs traceId as the single index', () => {
    const { dataset, calls } = makeFake();
    const { ctx } = makeWaitUntil();
    writeAnalyticsPoint(dataset, ctx, BASE_PAYLOAD);
    expect(calls[0]?.indexes).toEqual(['tr_0123456789abcdef']);
  });
});

describe('writeAnalyticsPoint — AC-38.3: non-blocking via waitUntil', () => {
  it('wraps the write in ctx.waitUntil', () => {
    const { dataset } = makeFake();
    const { ctx, awaited } = makeWaitUntil();
    writeAnalyticsPoint(dataset, ctx, BASE_PAYLOAD);
    expect(awaited).toHaveLength(1);
  });
});

describe('writeAnalyticsPoint — AC-38.6: never throws', () => {
  it('swallows errors from a throwing writeDataPoint', () => {
    const dataset: AnalyticsDatasetLike = {
      writeDataPoint: () => { throw new Error('boom'); },
    };
    const { ctx } = makeWaitUntil();
    expect(() => writeAnalyticsPoint(dataset, ctx, BASE_PAYLOAD)).not.toThrow();
  });

  it('is a no-op when dataset binding is undefined', () => {
    const { ctx, awaited } = makeWaitUntil();
    expect(() => writeAnalyticsPoint(undefined, ctx, BASE_PAYLOAD)).not.toThrow();
    expect(awaited).toHaveLength(0);
  });
});

describe('writeAnalyticsPoint — cache-tier blob', () => {
  it.each(['edge', 'kv', 'r2', 'upstream', 'n/a'] as const)(
    'accepts cacheTier=%s',
    (tier) => {
      const { dataset, calls } = makeFake();
      const { ctx } = makeWaitUntil();
      writeAnalyticsPoint(dataset, ctx, { ...BASE_PAYLOAD, cacheTier: tier });
      expect(calls[0]?.blobs?.[4]).toBe(tier);
    },
  );
});

describe('writeAnalyticsPoint — payload defaults', () => {
  it('defaults upstreamLatencyMs to 0 when served from a cache tier', () => {
    const { dataset, calls } = makeFake();
    const { ctx } = makeWaitUntil();
    writeAnalyticsPoint(dataset, ctx, { ...BASE_PAYLOAD, cacheTier: 'edge', upstreamLatencyMs: 0 });
    expect(calls[0]?.doubles?.[1]).toBe(0);
  });

  it('records rateLimitRemaining=-1 when unknown', () => {
    const { dataset, calls } = makeFake();
    const { ctx } = makeWaitUntil();
    writeAnalyticsPoint(dataset, ctx, { ...BASE_PAYLOAD, rateLimitRemaining: -1 });
    expect(calls[0]?.doubles?.[3]).toBe(-1);
  });
});

describe('writeAnalyticsPoint — even when waitUntil itself throws', () => {
  it('still does not throw (defense-in-depth)', () => {
    const { dataset } = makeFake();
    const ctx: WaitUntilLike = { waitUntil: () => { throw new Error('ctx boom'); } };
    // Use vi.spyOn to suppress any console output from the fallback path.
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => writeAnalyticsPoint(dataset, ctx, BASE_PAYLOAD)).not.toThrow();
    consoleSpy.mockRestore();
  });
});
