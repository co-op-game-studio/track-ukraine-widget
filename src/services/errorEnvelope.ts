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

/**
 * Error subclass that carries an FR-37 envelope alongside the standard
 * `message` field. Services throw these via `throwFromResponse` so hooks
 * and components can surface `userMessage` + `traceId` + `retryable`
 * without reparsing the body.
 *
 * The `message` we pass to `super()` is the ENVELOPE's `userMessage` when
 * available so `err.message` is always safe to show (AC-37.8). Operator
 * context (the envelope's `message` field) stays inside `.envelope`.
 *
 * Traces: FR-37 AC-37.1, AC-37.5, AC-37.8.
 */
export class EnvelopedError extends Error {
  public readonly envelope: ErrorEnvelope;
  constructor(envelope: ErrorEnvelope) {
    super(envelope.userMessage);
    this.name = 'EnvelopedError';
    this.envelope = envelope;
  }
}

/**
 * Retrieve the envelope attached to an Error (via `EnvelopedError`) or
 * null if no envelope is present. Accepts `unknown` because `catch`
 * clauses inherit type unknown in strict mode; narrows internally.
 */
export function getEnvelopeFromError(err: unknown): ErrorEnvelope | null {
  if (err instanceof EnvelopedError) return err.envelope;
  return null;
}

/**
 * Turn a non-ok Response into a thrown Error. Best-effort attempt to
 * parse an FR-37 envelope from the body; on success, throws an
 * `EnvelopedError` carrying the envelope. On failure (non-JSON body,
 * shape mismatch, empty body), throws a plain `Error` with a fallback
 * message like "Senate.gov returned 502" — preserving the pre-v2.6.0
 * error-message contract for upstream surfaces that don't speak FR-37.
 *
 * Always returns never (throws). Never resolves.
 *
 * Traces: FR-37 AC-37.5.
 */
export async function throwFromResponse(
  res: Response,
  upstreamLabel: string,
): Promise<never> {
  let envelope: ErrorEnvelope | null = null;
  try {
    const text = await res.text();
    if (text) {
      const parsed = JSON.parse(text);
      envelope = parseErrorEnvelope(parsed);
    }
  } catch {
    // body wasn't JSON; fall through to plain Error.
  }
  if (envelope) throw new EnvelopedError(envelope);
  throw new Error(`${upstreamLabel} returned ${res.status}`);
}
