/**
 * Per-request trace ID — FR-36 (spec.md v2.6.0).
 *
 * Every inbound request gets a trace ID of shape `tr_<16hex>`. If the client
 * supplies `X-Trace-Id` matching that pattern, the Worker echoes it; anything
 * else is silently replaced with a freshly-generated ID.
 *
 * The trace ID is:
 *   - echoed on every response (`X-Trace-Id`, AC-36.2)
 *   - forwarded on every upstream fetch the Worker makes (AC-36.3)
 *   - stamped into every structured log line + analytics data point (AC-36.4)
 *
 * Trace IDs are observability-only. They SHALL NOT be used as cache keys,
 * session tokens, or user identifiers (AC-36.7).
 *
 * Traces: FR-36 AC-36.1..AC-36.7.
 */

/** Canonical shape: `tr_` + 16 lowercase hex chars (64 bits of entropy). */
export const TRACE_ID_PATTERN = /^tr_[0-9a-f]{16}$/;
export const TRACE_HEADER = 'X-Trace-Id';

/**
 * Generate a fresh trace ID.
 *
 * Uses `crypto.randomUUID()` (Workers + browsers + modern Node all have it),
 * strips the dashes, and truncates to 16 hex chars. 16 chars = 64 bits of
 * randomness, which collides at ~2^32 IDs — more than enough for a per-
 * request observability handle.
 */
export function generateTraceId(): string {
  const uuid = crypto.randomUUID();
  const hex = uuid.replace(/-/g, '').slice(0, 16);
  return `tr_${hex}`;
}

/**
 * Resolve the trace ID for an inbound request: echo the client-supplied
 * `X-Trace-Id` if it matches the canonical pattern, else generate fresh.
 *
 * Strictly matches — leading/trailing whitespace, wrong case, wrong length,
 * wrong prefix all cause replacement. We never trim or normalize a client
 * value; if it doesn't match exactly, we don't trust it.
 */
export function resolveTraceId(request: Request): string {
  const supplied = request.headers.get(TRACE_HEADER);
  if (supplied && TRACE_ID_PATTERN.test(supplied)) {
    return supplied;
  }
  return generateTraceId();
}

/**
 * Build a Headers object for an outbound upstream fetch, carrying the given
 * trace ID. Accepts either a plain `HeadersInit` (object literal) or an
 * existing `Headers` instance.
 *
 * Does NOT mutate the input. Always overwrites any pre-existing `X-Trace-Id`
 * on the outbound init so we don't forward a stale or untrusted value.
 */
export function applyTraceHeaderToUpstream(init: HeadersInit, traceId: string): Headers {
  const out = new Headers(init);
  out.set(TRACE_HEADER, traceId);
  return out;
}
