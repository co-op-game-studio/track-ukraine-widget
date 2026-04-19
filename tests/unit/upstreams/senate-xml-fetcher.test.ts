/**
 * Tests for proxy/upstreams/senate-xml-fetcher.ts.
 *
 * Traces to FR-40 AC-40.7, FR-41 AC-41.4 (session-status stamping),
 *            FR-36 AC-36.3 (trace-ID forwarding to upstream).
 */
import { describe, expect, it, vi } from 'vitest';
import { SenateXmlFetcher } from '../../../proxy/upstreams/senate-xml-fetcher';
import type { CacheKey } from '../../../proxy/cache/key';

const FIXTURE_XML = `<?xml version="1.0"?>
<roll_call_vote>
  <congress>117</congress>
  <session>2</session>
  <vote_number>00078</vote_number>
  <members><member><last_name>X</last_name><state>IL</state><vote_cast>Yea</vote_cast></member></members>
</roll_call_vote>`;

const NOW = new Date('2026-04-19T00:00:00Z');

describe('SenateXmlFetcher — canHandle', () => {
  it('returns true for senate-xml keys', () => {
    const fetcher = new SenateXmlFetcher();
    const k: CacheKey = { kind: 'senate-xml', params: { congress: 117, session: 2, rollCall: 78 } };
    expect(fetcher.canHandle(k)).toBe(true);
  });

  it('returns false for other kinds', () => {
    const fetcher = new SenateXmlFetcher();
    expect(fetcher.canHandle({ kind: 'house-roster', params: {} })).toBe(false);
  });
});

describe('SenateXmlFetcher.fetch — URL composition', () => {
  it('requests vote_{c}_{s}_{rc}.xml with zero-padded rollCall', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(FIXTURE_XML, { status: 200, headers: { 'Content-Type': 'application/xml' } }),
    );
    const fetcher = new SenateXmlFetcher({ fetch: mockFetch, now: () => NOW });
    const k: CacheKey = { kind: 'senate-xml', params: { congress: 117, session: 2, rollCall: 78 } };
    await fetcher.fetch(k, { traceId: 'tr_0123456789abcdef' });

    const url = new URL(mockFetch.mock.calls[0]![0] as string);
    expect(url.host).toBe('www.senate.gov');
    expect(url.pathname).toBe(
      '/legislative/LIS/roll_call_votes/vote1172/vote_117_2_00078.xml',
    );
  });

  it('forwards trace ID on the outbound request (AC-36.3)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(FIXTURE_XML, { status: 200, headers: { 'Content-Type': 'application/xml' } }),
    );
    const fetcher = new SenateXmlFetcher({ fetch: mockFetch, now: () => NOW });
    const k: CacheKey = { kind: 'senate-xml', params: { congress: 117, session: 2, rollCall: 78 } };
    await fetcher.fetch(k, { traceId: 'tr_deadbeefcafebabe' });

    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('X-Trace-Id')).toBe('tr_deadbeefcafebabe');
    expect(headers.get('Accept')).toMatch(/xml/i);
  });
});

describe('SenateXmlFetcher.fetch — CacheEntry output', () => {
  it('returns entry with XML body verbatim + contentType', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(FIXTURE_XML, { status: 200, headers: { 'Content-Type': 'application/xml' } }),
    );
    const fetcher = new SenateXmlFetcher({ fetch: mockFetch, now: () => NOW });
    const k: CacheKey = { kind: 'senate-xml', params: { congress: 117, session: 2, rollCall: 78 } };
    const entry = await fetcher.fetch(k, { traceId: 'tr_0123456789abcdef' });

    expect(entry.value).toBe(FIXTURE_XML);
    expect(entry.contentType).toBe('application/xml');
    expect(entry.sourceUpstream).toBe('senate');
  });

  it('stamps sessionStatus=frozen for closed sessions (past Congress)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(FIXTURE_XML, { status: 200, headers: { 'Content-Type': 'application/xml' } }),
    );
    const fetcher = new SenateXmlFetcher({ fetch: mockFetch, now: () => NOW });
    const k: CacheKey = { kind: 'senate-xml', params: { congress: 117, session: 2, rollCall: 78 } };
    const entry = await fetcher.fetch(k, { traceId: 'tr_0123456789abcdef' });
    expect(entry.sessionStatus).toBe('frozen');
  });

  it('stamps sessionStatus=live for current Congress + current session', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(FIXTURE_XML, { status: 200, headers: { 'Content-Type': 'application/xml' } }),
    );
    const fetcher = new SenateXmlFetcher({ fetch: mockFetch, now: () => NOW });
    // 2026 → 119th/session 2, which matches NOW.
    const k: CacheKey = { kind: 'senate-xml', params: { congress: 119, session: 2, rollCall: 100 } };
    const entry = await fetcher.fetch(k, { traceId: 'tr_0123456789abcdef' });
    expect(entry.sessionStatus).toBe('live');
  });

  it('stamps fetchedAt from injected clock', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(FIXTURE_XML, { status: 200, headers: { 'Content-Type': 'application/xml' } }),
    );
    const fetcher = new SenateXmlFetcher({ fetch: mockFetch, now: () => NOW });
    const k: CacheKey = { kind: 'senate-xml', params: { congress: 117, session: 2, rollCall: 78 } };
    const entry = await fetcher.fetch(k, { traceId: 'tr_0123456789abcdef' });
    expect(entry.fetchedAt).toBe(NOW.getTime());
  });
});

describe('SenateXmlFetcher.fetch — error paths', () => {
  it('throws on non-2xx upstream response', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('not found', { status: 404 }),
    );
    const fetcher = new SenateXmlFetcher({ fetch: mockFetch, now: () => NOW });
    const k: CacheKey = { kind: 'senate-xml', params: { congress: 117, session: 2, rollCall: 78 } };
    await expect(fetcher.fetch(k, { traceId: 'tr_0123456789abcdef' })).rejects.toThrow(/404/);
  });

  it('throws for non-senate-xml kind (fail-loud)', async () => {
    const fetcher = new SenateXmlFetcher({ fetch: vi.fn(), now: () => NOW });
    const k: CacheKey = { kind: 'house-roster', params: {} };
    await expect(fetcher.fetch(k, { traceId: 'tr_0123456789abcdef' })).rejects.toThrow();
  });
});
