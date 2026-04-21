/**
 * Structured log helper — FR-39 (spec.md v2.6.0).
 *
 * Emits one JSON line per call via `console.log`. Workers Logs auto-indexes
 * top-level JSON fields, so `event:X AND env:prod` becomes a one-line filter
 * in the CF dashboard.
 *
 * Contract:
 *   logEvent(ctx, { event, level, ...fields })
 *
 * Every line carries `ts` (ISO), `env`, `traceId`, `event`, `level` plus any
 * caller-supplied fields. The helper never throws — circular references and
 * console.log failures fall through to a fixed-shape fallback line.
 *
 * Traces: FR-39 AC-39.1..AC-39.5, FR-36 AC-36.4.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  /** Short env label: 'dev' | 'uat' | 'stg' | 'prod' | 'preview'. */
  readonly env: string;
  /** Per-request trace ID (FR-36). */
  readonly traceId: string;
  /**
   * Optional list of literal strings to redact anywhere they appear in the
   * serialized payload. Used to scrub API keys + other secrets as
   * defense-in-depth (AC-39.5). Callers SHOULD pre-populate this from env
   * secrets (CONGRESS_API_KEY etc).
   */
  readonly redactList?: readonly string[];
}

export interface LogPayload {
  event: string;
  level: LogLevel;
  [field: string]: unknown;
}

/**
 * Serialize a payload to a single JSON line and write it.
 *
 * Never throws. On any serialization failure (circular refs, weird BigInts,
 * anything else `JSON.stringify` can't handle) emits a deterministic fallback
 * line so the operator still sees *something* tied to the trace ID.
 */
export function logEvent(ctx: LogContext, payload: LogPayload): void {
  const { event, level, ...extra } = payload;
  const base = {
    ts: new Date().toISOString(),
    env: ctx.env,
    traceId: ctx.traceId,
    event,
    level,
    ...extra,
  };

  let line: string;
  try {
    line = JSON.stringify(base);
    if (ctx.redactList && ctx.redactList.length > 0) {
      for (const secret of ctx.redactList) {
        if (secret) {
          line = line.split(secret).join('[REDACTED]');
        }
      }
    }
  } catch {
    line = JSON.stringify({
      ts: new Date().toISOString(),
      env: ctx.env,
      traceId: ctx.traceId,
      event: 'log_serialization_error',
      level: 'error',
      original_event: event,
    });
  }

  try {
    // eslint-disable-next-line no-console
    console.log(line);
  } catch {
    // Nothing we can do — swallow. The FR-39 AC-39.4 contract is "never throw."
  }
}
