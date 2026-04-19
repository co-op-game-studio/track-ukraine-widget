/**
 * Tests for proxy/observability/error-envelope.ts — canonical error envelope.
 *
 * Traces to FR-37 AC-37.1..AC-37.8 (spec.md v2.6.0).
 */
import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  isRetryable,
  asErrorResponse,
  type ErrorCode,
  type ErrorEnvelope,
} from '../../../proxy/observability/error-envelope';

const TRACE = 'tr_0123456789abcdef';

describe('ERROR_CODES — AC-37.2: closed enumeration', () => {
  it('contains exactly the 9 specified codes', () => {
    expect([...ERROR_CODES].sort()).toEqual(
      [
        'bad_request',
        'origin_not_allowed',
        'rate_limited',
        'not_found',
        'upstream_4xx',
        'upstream_5xx',
        'upstream_timeout',
        'upstream_parse_error',
        'internal_error',
      ].sort(),
    );
  });
});

describe('isRetryable — AC-37.3: retryable-flag matrix', () => {
  it.each([
    ['rate_limited', true],
    ['upstream_5xx', true],
    ['upstream_timeout', true],
    ['internal_error', true],
    ['bad_request', false],
    ['origin_not_allowed', false],
    ['not_found', false],
    ['upstream_4xx', false],
    ['upstream_parse_error', false],
  ] as const)('code=%s → retryable=%s', (code, expected) => {
    expect(isRetryable(code)).toBe(expected);
  });
});

describe('asErrorResponse — AC-37.1: envelope shape', () => {
  it('wraps envelope under top-level `error` key', async () => {
    const resp = asErrorResponse({
      code: 'bad_request',
      message: 'Malformed path',
      userMessage: 'Please try again.',
      traceId: TRACE,
      upstream: null,
    });
    const body = (await resp.json()) as { error: ErrorEnvelope };
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toBe('Malformed path');
    expect(body.error.userMessage).toBe('Please try again.');
    expect(body.error.traceId).toBe(TRACE);
    expect(body.error.upstream).toBeNull();
    expect(body.error.retryable).toBe(false);
  });

  it('sets Content-Type: application/json; charset=utf-8', () => {
    const resp = asErrorResponse({
      code: 'internal_error',
      message: 'x',
      userMessage: 'y',
      traceId: TRACE,
      upstream: null,
    });
    expect(resp.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
  });

  it('echoes the trace ID in X-Trace-Id response header', () => {
    const resp = asErrorResponse({
      code: 'bad_request',
      message: 'x',
      userMessage: 'y',
      traceId: TRACE,
      upstream: null,
    });
    expect(resp.headers.get('X-Trace-Id')).toBe(TRACE);
  });

  it('auto-derives retryable from code', async () => {
    const resp = asErrorResponse({
      code: 'upstream_5xx',
      message: 'x',
      userMessage: 'y',
      traceId: TRACE,
      upstream: 'congress',
    });
    const body = (await resp.json()) as { error: ErrorEnvelope };
    expect(body.error.retryable).toBe(true);
  });
});

describe('asErrorResponse — AC-37.3: status-code mapping', () => {
  it.each([
    ['bad_request', 400],
    ['origin_not_allowed', 403],
    ['not_found', 404],
    ['rate_limited', 429],
    ['upstream_4xx', 502],
    ['upstream_5xx', 502],
    ['upstream_parse_error', 502],
    ['upstream_timeout', 504],
    ['internal_error', 500],
  ] as const)('%s → HTTP %d', (code, status) => {
    const resp = asErrorResponse({
      code,
      message: 'x',
      userMessage: 'y',
      traceId: TRACE,
      upstream: null,
    });
    expect(resp.status).toBe(status);
  });
});

describe('asErrorResponse — AC-37.7: rate-limit carries Retry-After', () => {
  it('defaults Retry-After to 60 seconds on rate_limited', () => {
    const resp = asErrorResponse({
      code: 'rate_limited',
      message: 'x',
      userMessage: 'y',
      traceId: TRACE,
      upstream: null,
    });
    expect(resp.headers.get('Retry-After')).toBe('60');
  });

  it('honors caller-supplied retryAfterSeconds', () => {
    const resp = asErrorResponse({
      code: 'rate_limited',
      message: 'x',
      userMessage: 'y',
      traceId: TRACE,
      upstream: null,
      retryAfterSeconds: 120,
    });
    expect(resp.headers.get('Retry-After')).toBe('120');
  });

  it('does NOT set Retry-After on non-rate-limit codes', () => {
    const resp = asErrorResponse({
      code: 'bad_request',
      message: 'x',
      userMessage: 'y',
      traceId: TRACE,
      upstream: null,
    });
    expect(resp.headers.get('Retry-After')).toBeNull();
  });
});

describe('asErrorResponse — extra header passthrough', () => {
  it('merges caller-supplied extraHeaders onto the response', () => {
    const resp = asErrorResponse({
      code: 'origin_not_allowed',
      message: 'x',
      userMessage: 'y',
      traceId: TRACE,
      upstream: null,
      extraHeaders: { 'X-Custom': 'value-1' },
    });
    expect(resp.headers.get('X-Custom')).toBe('value-1');
  });
});

describe('ErrorCode type — spec-as-truth (compile-time regression guard)', () => {
  it('rejects a value outside the enum at construction time', () => {
    // Runtime check — TS compile-time already prevents this at callsites that
    // use the ErrorCode type. This test guards the runtime ERROR_CODES constant.
    const stray = 'upstream_error' as ErrorCode;
    expect(ERROR_CODES).not.toContain(stray);
  });
});
