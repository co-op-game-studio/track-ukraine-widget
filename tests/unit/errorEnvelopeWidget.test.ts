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
