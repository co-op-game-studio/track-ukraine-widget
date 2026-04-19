/**
 * serveCached — the request-pipeline function for every cacheable route.
 *
 * Flow:
 *   1. cache.get(key) — tries tier 0, 1, 2 in order.
 *   2. On hit: promote to faster tiers (waitUntil) + return with
 *      X-Cache: HIT / X-Cache-Tier: <tier>.
 *   3. On miss: fetcher.fetch(key) → upstream bytes + metadata.
 *      Write to every writable eligible tier (waitUntil). Return with
 *      X-Cache: MISS / X-Cache-Tier: upstream.
 *   4. On fetcher throw: return FR-37 envelope with code=upstream_5xx +
 *      retryable=true + trace ID.
 *
 * Observability (T-098, FR-38/FR-39):
 *   When `observability` is supplied, every request emits exactly one
 *   `writeAnalyticsPoint` call at response time (via ctx.waitUntil).
 *   Error paths ALSO emit one `logEvent` at level=error with the canonical
 *   error code. Success paths DO NOT log (AC-39.3 — success is silent by
 *   default). `observability` is optional for back-compat with existing
 *   callers; when absent, the pipeline behaves exactly as before.
 *
 * This is the ONLY function in the proxy that mediates upstream calls for
 * cached routes. Every route handler under proxy/routes/ calls through
 * this rather than issuing its own `fetch`.
 *
 * Traces: FR-40 AC-40.6, AC-40.9, FR-41 AC-41.9, FR-37 (error envelope),
 *         FR-38 AC-38.2, AC-38.6, FR-39 AC-39.2.
 */

import type { CacheKey } from './key';
import type { WritePolicy } from './policy';
import type { TieredCache, WaitUntilLike } from './tiered-cache';
import type { UpstreamFetcher } from '../upstreams/fetcher';
import { asErrorResponse, isRetryable, type ErrorCode } from '../observability/error-envelope';
import { logEvent, type LogContext } from '../observability/log';
import {
  writeAnalyticsPoint,
  type AnalyticsDatasetLike,
  type CacheTierLabel,
  type UpstreamNameLabel,
} from '../observability/analytics';

/** Per-request observability wiring. All fields are required when this
 *  object is supplied — callers opt in to instrumentation as a bundle. */
export interface ServeCachedObservability {
  /** Workers Analytics Engine dataset binding (optional; writer no-ops if absent). */
  readonly analytics?: AnalyticsDatasetLike;
  /** Env label for logs + analytics blobs — 'prod' | 'stg' | 'uat' | 'dev' | 'preview' | 'test'. */
  readonly env: string;
  /** Logical route-family for analytics blobs[0] — 'senate-xml' | 'members' | etc. */
  readonly routeClass: string;
  /** Upstream label for analytics blobs[1]. */
  readonly upstreamName: UpstreamNameLabel;
  /** Rate-limit remaining tokens, -1 if unknown. */
  readonly rateLimitRemaining?: number;
  /** Extra redact list for log serialization (e.g., CONGRESS_API_KEY). */
  readonly redactList?: readonly string[];
}

export interface ServeCachedInput<V extends string> {
  readonly key: CacheKey;
  readonly cache: TieredCache<V>;
  readonly fetcher: UpstreamFetcher<V>;
  readonly policy: WritePolicy;
  readonly ctx: WaitUntilLike;
  readonly traceId: string;
  /** Merged onto the response headers (CORS reflection, etc.). */
  readonly extraHeaders?: HeadersInit;
  /** FR-37 upstream attribution on error responses. */
  readonly upstreamAttribution?: 'congress' | 'senate' | 'census' | null;
  /** FR-38/FR-39 observability wiring. Optional; absent = back-compat (no emissions). */
  readonly observability?: ServeCachedObservability;
}

/**
 * Resolve a cacheable request through the tiered cache + fetcher.
 * Always returns a Response — success or canonical error envelope.
 */
export async function serveCached<V extends string>(
  input: ServeCachedInput<V>,
): Promise<Response> {
  const { key, cache, fetcher, policy, ctx, traceId, extraHeaders, observability } = input;
  const started = now();

  const hit = await cache.get(key);
  if (hit) {
    cache.promote(key, hit.entry, hit.servedBy, ctx, policy);
    emitAnalytics(observability, ctx, {
      cacheTier: hit.servedBy,
      errorCode: 'ok',
      statusCode: 200,
      totalLatencyMs: now() - started,
      upstreamLatencyMs: 0,
      traceId,
    });
    return responseFromEntry(hit.entry, {
      cacheStatus: 'HIT',
      cacheTier: hit.servedBy,
      traceId,
      extraHeaders,
    });
  }

  let entry;
  const upstreamStart = now();
  try {
    entry = await fetcher.fetch(key, { traceId });
  } catch (err) {
    const upstreamElapsed = now() - upstreamStart;
    const message = err instanceof Error ? err.message : String(err);
    const code: ErrorCode = 'upstream_5xx';
    emitLogAndAnalyticsOnError(observability, ctx, {
      traceId,
      code,
      message,
      upstream: input.upstreamAttribution ?? null,
      statusCode: 502,
      totalLatencyMs: now() - started,
      upstreamLatencyMs: upstreamElapsed,
    });
    return asErrorResponse({
      code,
      message,
      userMessage: 'Something went wrong loading that data. Try again in a moment.',
      upstream: input.upstreamAttribution ?? null,
      traceId,
      extraHeaders,
    });
  }
  const upstreamElapsed = now() - upstreamStart;

  cache.storeFromUpstream(key, entry, ctx, policy);
  emitAnalytics(observability, ctx, {
    cacheTier: 'upstream',
    errorCode: 'ok',
    statusCode: 200,
    totalLatencyMs: now() - started,
    upstreamLatencyMs: upstreamElapsed,
    traceId,
  });
  return responseFromEntry(entry, {
    cacheStatus: 'MISS',
    cacheTier: 'upstream',
    traceId,
    extraHeaders,
  });
}

// ── helpers ────────────────────────────────────────────────────────────

function now(): number {
  // Use performance.now when available (Workers + browsers + modern Node),
  // else Date.now as fallback. We round to ms — the AE doubles field is ms.
  return typeof performance !== 'undefined' ? Math.round(performance.now()) : Date.now();
}

interface AnalyticsArgs {
  cacheTier: CacheTierLabel;
  errorCode: string;
  statusCode: number;
  totalLatencyMs: number;
  upstreamLatencyMs: number;
  traceId: string;
}

function emitAnalytics(
  obs: ServeCachedObservability | undefined,
  ctx: WaitUntilLike,
  args: AnalyticsArgs,
): void {
  if (!obs) return;
  writeAnalyticsPoint(obs.analytics, ctx, {
    routeClass: obs.routeClass,
    upstreamName: obs.upstreamName,
    errorCode: args.errorCode,
    env: obs.env,
    cacheTier: args.cacheTier,
    totalLatencyMs: args.totalLatencyMs,
    upstreamLatencyMs: args.upstreamLatencyMs,
    statusCode: args.statusCode,
    rateLimitRemaining: obs.rateLimitRemaining ?? -1,
    traceId: args.traceId,
  });
}

interface ErrorPathArgs extends AnalyticsArgs {
  code: ErrorCode;
  message: string;
  upstream: 'congress' | 'senate' | 'census' | null;
}

function emitLogAndAnalyticsOnError(
  obs: ServeCachedObservability | undefined,
  ctx: WaitUntilLike,
  args: Omit<ErrorPathArgs, 'cacheTier' | 'errorCode'>,
): void {
  if (!obs) return;
  const logCtx: LogContext = {
    env: obs.env,
    traceId: args.traceId,
    ...(obs.redactList ? { redactList: obs.redactList } : {}),
  };
  logEvent(logCtx, {
    event: args.code,
    level: isRetryable(args.code) ? 'warn' : 'error',
    upstream: args.upstream,
    message: args.message,
    status: args.statusCode,
    routeClass: obs.routeClass,
  });
  emitAnalytics(obs, ctx, {
    cacheTier: 'n/a',
    errorCode: args.code,
    statusCode: args.statusCode,
    totalLatencyMs: args.totalLatencyMs,
    upstreamLatencyMs: args.upstreamLatencyMs,
    traceId: args.traceId,
  });
}

function responseFromEntry<V extends string>(
  entry: { value: V; contentType: string },
  opts: {
    cacheStatus: 'HIT' | 'MISS';
    cacheTier: 'edge' | 'kv' | 'r2' | 'upstream';
    traceId: string;
    extraHeaders?: HeadersInit;
  },
): Response {
  const headers = new Headers(opts.extraHeaders);
  headers.set('Content-Type', entry.contentType);
  headers.set('X-Cache', opts.cacheStatus);
  headers.set('X-Cache-Tier', opts.cacheTier);
  headers.set('X-Trace-Id', opts.traceId);
  return new Response(entry.value, { status: 200, headers });
}
