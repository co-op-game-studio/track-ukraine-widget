/**
 * Tests for proxy/upstreams/house-vote-detail-fetcher.ts.
 * Traces: FR-40 AC-40.7, FR-41 AC-41.4.
 */
import { describe, expect, it, vi } from 'vitest';
import { HouseVoteDetailFetcher } from '../../../proxy/upstreams/house-vote-detail-fetcher';

const NOW = new Date('2026-04-19T00:00:00Z');
const BODY = JSON.stringify({ houseRollCallVote: { voteQuestion: 'On Passage' } });

describe('HouseVoteDetailFetcher', () => {
  it('canHandle house-vote-detail → true; senate-xml → false', () => {
    const f = new HouseVoteDetailFetcher({ apiKey: 'k', fetch: vi.fn(), now: () => NOW });
    expect(f.canHandle({ kind: 'house-vote-detail', params: {} })).toBe(true);
    expect(f.canHandle({ kind: 'senate-xml', params: {} })).toBe(false);
  });

  it('composes /v3/house-vote/{c}/{s}/{rc} with api_key', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(BODY, { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const f = new HouseVoteDetailFetcher({ apiKey: 'K', fetch: mock, now: () => NOW });
    await f.fetch({ kind: 'house-vote-detail', params: { congress: 117, session: 2, rollCall: 78 } }, { traceId: 'tr_0123456789abcdef' });
    const u = new URL(mock.mock.calls[0]![0] as string);
    expect(u.pathname).toBe('/v3/house-vote/117/2/78');
    expect(u.searchParams.get('api_key')).toBe('K');
  });

  it('forwards X-Trace-Id', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(BODY, { status: 200 }));
    const f = new HouseVoteDetailFetcher({ apiKey: 'k', fetch: mock, now: () => NOW });
    await f.fetch({ kind: 'house-vote-detail', params: { congress: 117, session: 2, rollCall: 78 } }, { traceId: 'tr_cafebabedeadbeef' });
    const h = new Headers((mock.mock.calls[0]![1] as RequestInit).headers);
    expect(h.get('X-Trace-Id')).toBe('tr_cafebabedeadbeef');
  });

  it('stamps sessionStatus=frozen for past Congress', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(BODY, { status: 200 }));
    const f = new HouseVoteDetailFetcher({ apiKey: 'k', fetch: mock, now: () => NOW });
    const e = await f.fetch({ kind: 'house-vote-detail', params: { congress: 117, session: 2, rollCall: 78 } }, { traceId: 'tr_0123456789abcdef' });
    expect(e.sessionStatus).toBe('frozen');
    expect(e.sourceUpstream).toBe('congress');
  });

  it('throws on non-OK upstream', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    const f = new HouseVoteDetailFetcher({ apiKey: 'k', fetch: mock, now: () => NOW });
    await expect(f.fetch({ kind: 'house-vote-detail', params: { congress: 117, session: 2, rollCall: 78 } }, { traceId: 'tr_0123456789abcdef' })).rejects.toThrow(/500/);
  });
});
