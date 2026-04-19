/**
 * Widget-side canonical error envelope parser — FR-37 (spec.md v2.6.0).
 *
 * Mirrors the closed enumeration in proxy/observability/error-envelope.ts.
 * Parses an unknown JSON body into a typed envelope, or returns null if the
 * shape is wrong. Widget components consume the envelope via
 * `toUserFacingError(envelope)` which strips operator-only fields (AC-37.8).
 *
 * Traces: FR-37 AC-37.1, AC-37.5, AC-37.8.
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

export interface UserFacingError {
  readonly userMessage: string;
  readonly traceId: string;
  readonly retryable: boolean;
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

function isUpstream(value: unknown): value is Upstream {
  if (value === null) return true;
  return typeof value === 'string' && ['congress', 'senate', 'census'].includes(value);
}

/**
 * Attempt to parse an unknown JSON body as an error envelope. Returns null
 * on any shape mismatch — callers fall back to a generic error message.
 */
export function parseErrorEnvelope(raw: unknown): ErrorEnvelope | null {
  if (!raw || typeof raw !== 'object') return null;
  const outer = raw as Record<string, unknown>;
  if (!outer.error || typeof outer.error !== 'object') return null;
  const e = outer.error as Record<string, unknown>;
  if (
    isErrorCode(e.code) &&
    typeof e.message === 'string' &&
    typeof e.userMessage === 'string' &&
    isUpstream(e.upstream) &&
    typeof e.retryable === 'boolean' &&
    typeof e.traceId === 'string'
  ) {
    return {
      code: e.code,
      message: e.message,
      userMessage: e.userMessage,
      upstream: e.upstream,
      retryable: e.retryable,
      traceId: e.traceId,
    };
  }
  return null;
}

/**
 * Project an envelope down to the fields the widget SHALL render — AC-37.8
 * forbids exposing `error.message` (operator context) to the UI, so we strip
 * it here at the boundary.
 */
export function toUserFacingError(env: ErrorEnvelope): UserFacingError {
  return {
    userMessage: env.userMessage,
    traceId: env.traceId,
    retryable: env.retryable,
  };
}
