/**
 * Tests for proxy/upstreams/bill-actions-fetcher.ts.
 * Traces: FR-40 AC-40.7, FR-41 AC-41.4 (age-gated).
 */
import { describe, expect, it, vi } from 'vitest';
import { BillActionsFetcher, extractLatestActionDate } from '../../../proxy/upstreams/bill-actions-fetcher';

const NOW = new Date('2026-04-19T00:00:00Z');

describe('extractLatestActionDate', () => {
  it('returns the latest actionDate across entries', () => {
    const body = JSON.stringify({ actions: { actions: [
      { actionDate: '2024-01-15', text: 'introduced' },
      { actionDate: '2024-11-30', text: 'signed' },
      { actionDate: '2024-06-01', text: 'voted' },
    ] } });
    const d = extractLatestActionDate(body);
    expect(d?.toISOString()).toBe('2024-11-30T00:00:00.000Z');
  });

  it('returns null on body with no actionDate fields', () => {
    expect(extractLatestActionDate('{"other":"data"}')).toBeNull();
  });

  it('tolerates unparseable JSON as long as actionDate regex still matches', () => {
    // Resilience: partial truncation / comments shouldn't block extraction
    const body = '{ broken "actionDate": "2025-01-01" }';
    expect(extractLatestActionDate(body)?.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });
});

describe('BillActionsFetcher', () => {
  const OLD_BODY = JSON.stringify({ actions: { actions: [{ actionDate: '2024-01-15' }] } }); // ~15 months old
  const RECENT_BODY = JSON.stringify({ actions: { actions: [{ actionDate: '2026-03-01' }] } }); // ~50 days old

  it('canHandle bill-actions → true; bill-summaries → false', () => {
    const f = new BillActionsFetcher({ apiKey: 'k', fetch: vi.fn(), now: () => NOW });
    expect(f.canHandle({ kind: 'bill-actions', params: {} })).toBe(true);
    expect(f.canHandle({ kind: 'bill-summaries', params: {} })).toBe(false);
  });

  it('composes /v3/bill/{c}/{type}/{num}/actions URL', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(OLD_BODY, { status: 200 }));
    const f = new BillActionsFetcher({ apiKey: 'k', fetch: mock, now: () => NOW });
    await f.fetch({ kind: 'bill-actions', params: { congress: 117, type: 'hr', number: 7691 } }, { traceId: 'tr_0123456789abcdef' });
    const u = new URL(mock.mock.calls[0]![0] as string);
    expect(u.pathname).toBe('/v3/bill/117/hr/7691/actions');
  });

  it('stamps sessionStatus=frozen when latestAction >180d before now', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(OLD_BODY, { status: 200 }));
    const f = new BillActionsFetcher({ apiKey: 'k', fetch: mock, now: () => NOW });
    const e = await f.fetch({ kind: 'bill-actions', params: { congress: 117, type: 'hr', number: 7691 } }, { traceId: 'tr_0123456789abcdef' });
    expect(e.sessionStatus).toBe('frozen');
  });

  it('stamps sessionStatus=live when latestAction <180d before now', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(RECENT_BODY, { status: 200 }));
    const f = new BillActionsFetcher({ apiKey: 'k', fetch: mock, now: () => NOW });
    const e = await f.fetch({ kind: 'bill-actions', params: { congress: 119, type: 'hr', number: 100 } }, { traceId: 'tr_0123456789abcdef' });
    expect(e.sessionStatus).toBe('live');
  });

  it('stamps live when no actionDate present (cannot gate)', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('{"no":"dates"}', { status: 200 }));
    const f = new BillActionsFetcher({ apiKey: 'k', fetch: mock, now: () => NOW });
    const e = await f.fetch({ kind: 'bill-actions', params: { congress: 119, type: 'hr', number: 100 } }, { traceId: 'tr_0123456789abcdef' });
    expect(e.sessionStatus).toBe('live');
  });
});
