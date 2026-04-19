/**
 * Workers Analytics Engine writer — FR-38 (spec.md v2.6.0).
 *
 * Emits exactly one data point per `/api/*` request via `ctx.waitUntil`, so
 * telemetry never extends perceived client latency (AC-38.3). Field layout
 * is fixed by AC-38.2:
 *
 *   blobs[0] routeClass      e.g. 'members' | 'senate-xml' | 'roll-call-roster' | 'other'
 *   blobs[1] upstreamName    'senate' | 'congress' | 'census' | 'none'
 *   blobs[2] errorCode       one of FR-37 AC-37.2 values or 'ok'
 *   blobs[3] env             'prod' | 'stg' | 'uat' | 'dev' | 'preview'
 *   blobs[4] cacheTier       'edge' | 'kv' | 'r2' | 'upstream' | 'n/a'
 *
 *   doubles[0] totalLatencyMs       wall-clock ms request arrival → response flush
 *   doubles[1] upstreamLatencyMs    ms in upstream fetch (0 on cache hits)
 *   doubles[2] statusCode           HTTP status returned to client
 *   doubles[3] rateLimitRemaining   tokens left in RATE_LIMITER window (-1 if unknown)
 *
 *   indexes[0] traceId        per-request trace ID (FR-36)
 *
 * Contract: writer NEVER throws (AC-38.6). If the binding is absent (tests,
 * local wrangler-dev) or the write itself errors, we silently swallow. The
 * only observability signal of a failed write is Workers Logs — and we
 * intentionally don't call logEvent here because logEvent might recursively
 * try to emit analytics and compound the problem.
 *
 * Traces: FR-38 AC-38.1..AC-38.6.
 */

/** Minimal shape of a Cloudflare Analytics Engine dataset binding. */
export interface AnalyticsDatasetLike {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

export interface WaitUntilLike {
  waitUntil(promise: Promise<unknown>): void;
}

export type CacheTierLabel = 'edge' | 'kv' | 'r2' | 'upstream' | 'n/a';
export type UpstreamNameLabel = 'senate' | 'congress' | 'census' | 'none';

/**
 * Payload for a single analytics data point. Caller assembles this from the
 * request + response context, then passes to `writeAnalyticsPoint`.
 */
export interface AnalyticsPayload {
  readonly routeClass: string;
  readonly upstreamName: UpstreamNameLabel;
  readonly errorCode: string;
  readonly env: string;
  readonly cacheTier: CacheTierLabel;
  readonly totalLatencyMs: number;
  readonly upstreamLatencyMs: number;
  readonly statusCode: number;
  readonly rateLimitRemaining: number;
  readonly traceId: string;
}

/**
 * Emit one Analytics Engine data point, wrapped in ctx.waitUntil so the
 * response flush is never blocked. No-op when `dataset` is undefined
 * (AC-38.6 — telemetry MUST NOT be a prerequisite for serving traffic).
 */
export function writeAnalyticsPoint(
  dataset: AnalyticsDatasetLike | undefined,
  ctx: WaitUntilLike,
  payload: AnalyticsPayload,
): void {
  if (!dataset) return;

  const point = {
    blobs: [
      payload.routeClass,
      payload.upstreamName,
      payload.errorCode,
      payload.env,
      payload.cacheTier,
    ],
    doubles: [
      payload.totalLatencyMs,
      payload.upstreamLatencyMs,
      payload.statusCode,
      payload.rateLimitRemaining,
    ],
    indexes: [payload.traceId],
  };

  // The writeDataPoint call itself is synchronous in CF's API, but we wrap
  // its invocation in a resolved promise so ctx.waitUntil receives something
  // awaitable and satisfies the AC-38.3 contract literally. We swallow any
  // throws — from the binding or from ctx.waitUntil itself.
  try {
    const p = (async () => {
      try {
        dataset.writeDataPoint(point);
      } catch {
        // binding errored — drop the point, don't fail the request
      }
    })();
    try {
      ctx.waitUntil(p);
    } catch {
      // ctx.waitUntil threw (shouldn't in real runtime) — the promise still
      // resolves in the background; nothing else to do.
    }
  } catch {
    // belt-and-suspenders — absolutely never throw
  }
}
