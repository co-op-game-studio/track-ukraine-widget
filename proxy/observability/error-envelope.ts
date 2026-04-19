/**
 * Canonical error envelope — FR-37 (spec.md v2.6.0).
 *
 * Every non-2xx, non-304 Worker response with a body uses this envelope:
 *
 *   {
 *     "error": {
 *       "code":       <closed enum of 9 values>,
 *       "message":    <operator-facing detail>,
 *       "userMessage":<end-user-safe message>,
 *       "upstream":   "congress" | "senate" | "census" | null,
 *       "retryable":  boolean (derived from code),
 *       "traceId":    "tr_<16hex>"
 *     }
 *   }
 *
 * Legacy shape `{ error: 'upstream_error', status, upstream }` is removed —
 * no dual-shape compat window (AC-37.6).
 *
 * Traces: FR-37 AC-37.1..AC-37.8.
 */

export const ERROR_CODES = [
  'bad_request',
  'origin_not_allowed',
  'rate_limited',
  'not_found',
  'upstream_4xx',
  'upstream_5xx',
  'upstream_timeout',
  'upstream_parse_error',
  'internal_error',
] as const;

export type ErrorCode = typeof ERROR_CODES[number];

export type Upstream = 'congress' | 'senate' | 'census' | null;

export interface ErrorEnvelope {
  readonly code: ErrorCode;
  readonly message: string;
  readonly userMessage: string;
  readonly upstream: Upstream;
  readonly retryable: boolean;
  readonly traceId: string;
}

/** AC-37.3 — retryable-flag derivation. */
const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set([
  'rate_limited',
  'upstream_5xx',
  'upstream_timeout',
  'internal_error',
]);

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

/** AC-37.3 — HTTP status-code mapping. */
const STATUS_FOR_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  origin_not_allowed: 403,
  rate_limited: 429,
  not_found: 404,
  upstream_4xx: 502,
  upstream_5xx: 502,
  upstream_timeout: 504,
  upstream_parse_error: 502,
  internal_error: 500,
};

export interface BuildErrorResponseInput {
  code: ErrorCode;
  message: string;
  userMessage: string;
  upstream: Upstream;
  traceId: string;
  /** Override for rate-limited 429s. Defaults to 60. (AC-37.7) */
  retryAfterSeconds?: number;
  /** Extra headers to merge onto the response (e.g. CORS reflection). */
  extraHeaders?: HeadersInit;
}

/**
 * Build the Response for a Worker error. Caller supplies code + messages +
 * trace ID; this helper fills in retryable, status, content-type, and the
 * standard X-Trace-Id + optional Retry-After headers.
 */
export function asErrorResponse(input: BuildErrorResponseInput): Response {
  const envelope: ErrorEnvelope = {
    code: input.code,
    message: input.message,
    userMessage: input.userMessage,
    upstream: input.upstream,
    retryable: isRetryable(input.code),
    traceId: input.traceId,
  };

  const headers = new Headers(input.extraHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('X-Trace-Id', input.traceId);
  if (input.code === 'rate_limited') {
    headers.set('Retry-After', String(input.retryAfterSeconds ?? 60));
  }

  return new Response(JSON.stringify({ error: envelope }), {
    status: STATUS_FOR_CODE[input.code],
    headers,
  });
}
