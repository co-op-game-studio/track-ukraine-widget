/**
 * Widget-side tests for src/services/errorEnvelope.ts — parser for the
 * canonical error envelope coming back from the Worker.
 *
 * Traces to FR-37 AC-37.1, AC-37.5, AC-37.8 (spec.md v2.6.0).
 */
import { describe, expect, it } from 'vitest';
import { parseErrorEnvelope, toUserFacingError } from '../../src/services/errorEnvelope';

describe('parseErrorEnvelope — canonical shape acceptance', () => {
  it('parses a well-formed envelope', () => {
    const raw = {
      error: {
        code: 'rate_limited',
        message: 'In-Worker rate limit exceeded',
        userMessage: 'Too many requests. Please wait a moment and try again.',
        upstream: 'congress',
        retryable: true,
        traceId: 'tr_0123456789abcdef',
      },
    };
    const parsed = parseErrorEnvelope(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.code).toBe('rate_limited');
    expect(parsed?.retryable).toBe(true);
    expect(parsed?.traceId).toBe('tr_0123456789abcdef');
  });

  it('returns null on missing error wrapper', () => {
    expect(parseErrorEnvelope({ code: 'bad_request' } as unknown)).toBeNull();
  });

  it('returns null on missing required fields', () => {
    expect(parseErrorEnvelope({ error: { code: 'bad_request' } } as unknown)).toBeNull();
  });

  it('returns null on unrecognized code', () => {
    expect(
      parseErrorEnvelope({
        error: {
          code: 'totally_made_up',
          message: 'x',
          userMessage: 'y',
          upstream: null,
          retryable: false,
          traceId: 'tr_0123456789abcdef',
        },
      } as unknown),
    ).toBeNull();
  });

  it('returns null on non-object input', () => {
    expect(parseErrorEnvelope(null)).toBeNull();
    expect(parseErrorEnvelope('oops')).toBeNull();
    expect(parseErrorEnvelope(42)).toBeNull();
  });
});

describe('toUserFacingError — AC-37.8: operator context never reaches UI', () => {
  it('returns userMessage + traceId + retryable for rendering', () => {
    const view = toUserFacingError({
      code: 'upstream_5xx',
      message: 'Operator internal: congress.gov 503',
      userMessage: 'Something went wrong. Try again.',
      upstream: 'congress',
      retryable: true,
      traceId: 'tr_0123456789abcdef',
    });
    expect(view.userMessage).toBe('Something went wrong. Try again.');
    expect(view.traceId).toBe('tr_0123456789abcdef');
    expect(view.retryable).toBe(true);
  });

  it('does NOT expose the operator-facing message', () => {
    const view = toUserFacingError({
      code: 'upstream_5xx',
      message: 'Operator internal: congress.gov 503',
      userMessage: 'Something went wrong.',
      upstream: 'congress',
      retryable: true,
      traceId: 'tr_0123456789abcdef',
    });
    expect(Object.values(view)).not.toContain('Operator internal: congress.gov 503');
  });
});

describe('EnvelopedError + throwFromResponse (T-097)', () => {
  it('throwFromResponse awaits envelope JSON body and attaches it to the Error', async () => {
    const { throwFromResponse, getEnvelopeFromError } = await import(
      '../../src/services/errorEnvelope'
    );
    const body = {
      error: {
        code: 'rate_limited',
        message: 'op detail',
        userMessage: 'Too many requests. Wait a moment.',
        upstream: 'congress',
        retryable: true,
        traceId: 'tr_0123456789abcdef',
      },
    };
    const res = new Response(JSON.stringify(body), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });
    let caught: Error | undefined;
    try {
      await throwFromResponse(res, 'Census geocoder');
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toContain('Too many requests');
    const env = getEnvelopeFromError(caught!);
    expect(env?.code).toBe('rate_limited');
    expect(env?.retryable).toBe(true);
    expect(env?.traceId).toBe('tr_0123456789abcdef');
  });

  it('throwFromResponse falls back to a plain Error when body is not FR-37 shaped', async () => {
    const { throwFromResponse, getEnvelopeFromError } = await import(
      '../../src/services/errorEnvelope'
    );
    const res = new Response('<html>oops</html>', {
      status: 502,
      headers: { 'Content-Type': 'text/html' },
    });
    let caught: Error | undefined;
    try {
      await throwFromResponse(res, 'Senate.gov');
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/Senate\.gov.*502/);
    expect(getEnvelopeFromError(caught!)).toBeNull();
  });

  it('getEnvelopeFromError returns null for a plain Error', async () => {
    const { getEnvelopeFromError } = await import('../../src/services/errorEnvelope');
    expect(getEnvelopeFromError(new Error('nothing here'))).toBeNull();
  });

  it('getEnvelopeFromError returns null for non-Error values', async () => {
    const { getEnvelopeFromError } = await import('../../src/services/errorEnvelope');
    expect(getEnvelopeFromError('string')).toBeNull();
    expect(getEnvelopeFromError(undefined)).toBeNull();
    expect(getEnvelopeFromError(null)).toBeNull();
  });
});
