/**
 * Tests for proxy/upstreams/bill-summaries-fetcher.ts.
 * Traces: FR-40 AC-40.7, FR-41 AC-41.4 (age-gated).
 */
import { describe, expect, it, vi } from 'vitest';
import { BillSummariesFetcher, extractLatestSummaryUpdate } from '../../../proxy/upstreams/bill-summaries-fetcher';

const NOW = new Date('2026-04-19T00:00:00Z');

describe('extractLatestSummaryUpdate', () => {
  it('picks the latest updateDate across summary entries', () => {
    const body = JSON.stringify({ summaries: [
      { updateDate: '2024-06-01', text: 'v1' },
      { updateDate: '2024-11-15', text: 'v2' },
    ] });
    const d = extractLatestSummaryUpdate(body);
    expect(d?.toISOString()).toBe('2024-11-15T00:00:00.000Z');
  });

  it('returns null when no updateDate present', () => {
    expect(extractLatestSummaryUpdate('{"x":1}')).toBeNull();
  });
});

describe('BillSummariesFetcher', () => {
  const OLD = JSON.stringify({ summaries: [{ updateDate: '2024-01-01' }] });
  const RECENT = JSON.stringify({ summaries: [{ updateDate: '2026-03-01' }] });

  it('canHandle bill-summaries → true; bill-actions → false', () => {
    const f = new BillSummariesFetcher({ apiKey: 'k', fetch: vi.fn(), now: () => NOW });
    expect(f.canHandle({ kind: 'bill-summaries', params: {} })).toBe(true);
    expect(f.canHandle({ kind: 'bill-actions', params: {} })).toBe(false);
  });

  it('composes /v3/bill/{c}/{type}/{num}/summaries URL', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(OLD, { status: 200 }));
    const f = new BillSummariesFetcher({ apiKey: 'k', fetch: mock, now: () => NOW });
    await f.fetch({ kind: 'bill-summaries', params: { congress: 117, type: 's', number: 17 } }, { traceId: 'tr_0123456789abcdef' });
    const u = new URL(mock.mock.calls[0]![0] as string);
    expect(u.pathname).toBe('/v3/bill/117/s/17/summaries');
  });

  it('age gates to frozen when >180d', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(OLD, { status: 200 }));
    const f = new BillSummariesFetcher({ apiKey: 'k', fetch: mock, now: () => NOW });
    const e = await f.fetch({ kind: 'bill-summaries', params: { congress: 117, type: 's', number: 17 } }, { traceId: 'tr_0123456789abcdef' });
    expect(e.sessionStatus).toBe('frozen');
  });

  it('age gates to live when <180d', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(RECENT, { status: 200 }));
    const f = new BillSummariesFetcher({ apiKey: 'k', fetch: mock, now: () => NOW });
    const e = await f.fetch({ kind: 'bill-summaries', params: { congress: 119, type: 'hr', number: 5 } }, { traceId: 'tr_0123456789abcdef' });
    expect(e.sessionStatus).toBe('live');
  });
});
