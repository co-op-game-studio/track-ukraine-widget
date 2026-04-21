/**
 * Tests for proxy/observability/log.ts — structured log helper.
 *
 * Traces to FR-39 AC-39.1 through AC-39.5 (spec.md v2.6.0).
 * Traces to FR-36 AC-36.4 (trace ID threading into every log line).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logEvent, type LogContext } from '../../../proxy/observability/log';

const ctx: LogContext = {
  env: 'prod',
  traceId: 'tr_0123456789abcdef',
};

let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  consoleLogSpy.mockRestore();
});

function lastLine(): Record<string, unknown> {
  const calls = consoleLogSpy.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) throw new Error('no console.log call recorded');
  const arg = call[0];
  if (typeof arg !== 'string') throw new Error(`expected string, got ${typeof arg}`);
  return JSON.parse(arg) as Record<string, unknown>;
}

describe('logEvent — AC-39.1: JSON-per-line shape', () => {
  it('emits one console.log call per invocation', () => {
    logEvent(ctx, { event: 'rate_limit_denied', level: 'warn' });
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });

  it('emits a single JSON object as a string', () => {
    logEvent(ctx, { event: 'rate_limit_denied', level: 'warn' });
    const line = lastLine();
    expect(typeof line).toBe('object');
    expect(line.event).toBe('rate_limit_denied');
  });

  it('includes iso ts, env, traceId as top-level fields', () => {
    logEvent(ctx, { event: 'x', level: 'info' });
    const line = lastLine();
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(line.env).toBe('prod');
    expect(line.traceId).toBe('tr_0123456789abcdef');
  });

  it('preserves level field', () => {
    logEvent(ctx, { event: 'x', level: 'error' });
    expect(lastLine().level).toBe('error');
  });

  it('spreads arbitrary extra fields', () => {
    logEvent(ctx, { event: 'upstream_5xx', level: 'warn', upstream: 'senate', status: 503 });
    const line = lastLine();
    expect(line.upstream).toBe('senate');
    expect(line.status).toBe(503);
  });
});

describe('logEvent — AC-39.4: never throws', () => {
  it('replaces circular-ref payloads with a fallback error line', () => {
    const circular: Record<string, unknown> = { name: 'bad' };
    circular.self = circular;
    // must not throw
    expect(() => logEvent(ctx, { event: 'circ', level: 'warn', data: circular })).not.toThrow();
    const line = lastLine();
    expect(line.event).toBe('log_serialization_error');
    expect(line.original_event).toBe('circ');
  });

  it('emits fallback line if console.log itself throws', () => {
    consoleLogSpy.mockImplementationOnce(() => { throw new Error('boom'); });
    expect(() => logEvent(ctx, { event: 'e', level: 'info' })).not.toThrow();
  });
});

describe('logEvent — AC-39.5: secret redaction', () => {
  it('redacts values matching a known API-key shape in nested fields', () => {
    logEvent(
      { ...ctx, redactList: ['SECRET_KEY_12345'] },
      { event: 'upstream_ok', level: 'info', detail: 'called https://x?api_key=SECRET_KEY_12345' },
    );
    const line = lastLine();
    expect(String(line.detail)).not.toContain('SECRET_KEY_12345');
    expect(String(line.detail)).toContain('[REDACTED]');
  });

  it('redacts across nested object field values', () => {
    logEvent(
      { ...ctx, redactList: ['abc123'] },
      { event: 'x', level: 'info', deep: { k: 'my abc123 key' } },
    );
    const line = lastLine();
    expect(JSON.stringify(line)).not.toContain('abc123');
  });

  it('applies no redaction when redactList is absent', () => {
    logEvent(ctx, { event: 'x', level: 'info', note: 'abc123' });
    const line = lastLine();
    expect(line.note).toBe('abc123');
  });
});

describe('logEvent — AC-39.1: level enumeration', () => {
  it.each(['debug', 'info', 'warn', 'error'] as const)('accepts level=%s', (level) => {
    logEvent(ctx, { event: 'x', level });
    expect(lastLine().level).toBe(level);
  });
});

describe('logEvent — structure stability (regression guard)', () => {
  it('does not log internal redactList or other ctx-helper fields', () => {
    logEvent({ ...ctx, redactList: ['s'] }, { event: 'x', level: 'info' });
    const line = lastLine();
    expect(Object.keys(line)).not.toContain('redactList');
  });

  it('does not log the raw LogContext object under any key', () => {
    logEvent(ctx, { event: 'x', level: 'info' });
    expect(Object.keys(lastLine()).sort()).toEqual(
      expect.arrayContaining(['ts', 'env', 'traceId', 'event', 'level']),
    );
  });
});
