/**
 * Tests for proxy/observability/trace.ts — per-request trace ID.
 *
 * Traces to FR-36 AC-36.1 through AC-36.7 (spec.md v2.6.0).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  TRACE_ID_PATTERN,
  TRACE_HEADER,
  generateTraceId,
  resolveTraceId,
  applyTraceHeaderToUpstream,
} from '../../../proxy/observability/trace';

describe('TRACE_ID_PATTERN — AC-36.1: canonical shape', () => {
  it('matches tr_ + 16 lowercase hex', () => {
    expect('tr_0123456789abcdef').toMatch(TRACE_ID_PATTERN);
  });

  it('rejects uppercase hex', () => {
    expect('tr_0123456789ABCDEF').not.toMatch(TRACE_ID_PATTERN);
  });

  it('rejects wrong length', () => {
    expect('tr_0123').not.toMatch(TRACE_ID_PATTERN);
    expect('tr_0123456789abcdefaa').not.toMatch(TRACE_ID_PATTERN);
  });

  it('rejects wrong prefix', () => {
    expect('xy_0123456789abcdef').not.toMatch(TRACE_ID_PATTERN);
  });

  it('rejects empty + random strings', () => {
    expect('').not.toMatch(TRACE_ID_PATTERN);
    expect('not-a-trace-id-at-all').not.toMatch(TRACE_ID_PATTERN);
    expect('tr_g123456789abcdef').not.toMatch(TRACE_ID_PATTERN); // g is not hex
  });
});

describe('generateTraceId — AC-36.1: derivation from crypto.randomUUID', () => {
  it('returns a value matching the canonical pattern', () => {
    const id = generateTraceId();
    expect(id).toMatch(TRACE_ID_PATTERN);
  });

  it('returns distinct values across calls', () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateTraceId()));
    expect(ids.size).toBe(10);
  });

  it('strips dashes + truncates UUID to 16 hex chars after prefix', () => {
    const spy = vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-90ab-cdef-1234-567890abcdef' as `${string}-${string}-${string}-${string}-${string}`);
    expect(generateTraceId()).toBe('tr_1234567890abcdef');
    spy.mockRestore();
  });
});

describe('resolveTraceId — AC-36.1: echo-or-generate', () => {
  it('echoes a client-supplied header matching the canonical pattern', () => {
    const req = new Request('https://example.com/', { headers: { [TRACE_HEADER]: 'tr_deadbeefcafebabe' } });
    expect(resolveTraceId(req)).toBe('tr_deadbeefcafebabe');
  });

  it('is case-insensitive on the header name (HTTP header names are)', () => {
    // Browsers normalize anyway but exercise explicitly.
    const req = new Request('https://example.com/', { headers: { 'x-trace-id': 'tr_1234567890abcdef' } });
    expect(resolveTraceId(req)).toBe('tr_1234567890abcdef');
  });

  it('generates a fresh ID when the client header is absent', () => {
    const req = new Request('https://example.com/');
    const id = resolveTraceId(req);
    expect(id).toMatch(TRACE_ID_PATTERN);
  });

  it('generates a fresh ID when the client header is malformed', () => {
    const req = new Request('https://example.com/', { headers: { [TRACE_HEADER]: 'nonsense' } });
    const id = resolveTraceId(req);
    expect(id).toMatch(TRACE_ID_PATTERN);
    expect(id).not.toBe('nonsense');
  });

  it('generates a fresh ID when the client header has uppercase hex', () => {
    // AC-36.1 is strict on shape — uppercase is replaced.
    const req = new Request('https://example.com/', { headers: { [TRACE_HEADER]: 'tr_0123456789ABCDEF' } });
    const id = resolveTraceId(req);
    expect(id).toMatch(TRACE_ID_PATTERN);
    expect(id).not.toBe('tr_0123456789ABCDEF');
  });

  it('ignores extra whitespace and rejects the value (does not trim silently)', () => {
    const req = new Request('https://example.com/', { headers: { [TRACE_HEADER]: '  tr_0123456789abcdef  ' } });
    const id = resolveTraceId(req);
    // Strict match — leading/trailing whitespace is not a valid canonical trace ID.
    expect(id).not.toBe('  tr_0123456789abcdef  ');
    expect(id).toMatch(TRACE_ID_PATTERN);
  });
});

describe('applyTraceHeaderToUpstream — AC-36.3: outbound propagation', () => {
  it('adds X-Trace-Id to a plain Headers init', () => {
    const merged = applyTraceHeaderToUpstream({ Accept: 'application/json' }, 'tr_0123456789abcdef');
    expect(merged.get(TRACE_HEADER)).toBe('tr_0123456789abcdef');
    expect(merged.get('Accept')).toBe('application/json');
  });

  it('overwrites any existing X-Trace-Id on the outbound init', () => {
    const merged = applyTraceHeaderToUpstream({ [TRACE_HEADER]: 'tr_cafebabe12345678' }, 'tr_0123456789abcdef');
    expect(merged.get(TRACE_HEADER)).toBe('tr_0123456789abcdef');
  });

  it('accepts an existing Headers object and preserves its entries', () => {
    const base = new Headers({ Accept: 'application/xml' });
    const merged = applyTraceHeaderToUpstream(base, 'tr_deadbeefcafebabe');
    expect(merged.get('Accept')).toBe('application/xml');
    expect(merged.get(TRACE_HEADER)).toBe('tr_deadbeefcafebabe');
  });

  it('does not mutate the caller-supplied Headers instance', () => {
    const base = new Headers({ Accept: 'application/xml' });
    applyTraceHeaderToUpstream(base, 'tr_deadbeefcafebabe');
    expect(base.get(TRACE_HEADER)).toBeNull();
  });
});

describe('TRACE_HEADER constant', () => {
  it('is the literal X-Trace-Id', () => {
    expect(TRACE_HEADER).toBe('X-Trace-Id');
  });
});
