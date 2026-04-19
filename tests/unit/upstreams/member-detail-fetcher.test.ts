/**
 * Tests for proxy/upstreams/member-detail-fetcher.ts.
 *
 * Member detail is NOT R2-eligible — mid-Congress rotation (death,
 * party switch, photo URL change). `sessionStatus` MUST NOT be stamped.
 *
 * Traces: FR-40 AC-40.7, FR-41 data-type matrix (member-detail row).
 */
import { describe, expect, it, vi } from 'vitest';
import { MemberDetailFetcher } from '../../../proxy/upstreams/member-detail-fetcher';

const NOW = new Date('2026-04-19T00:00:00Z');
const BODY = JSON.stringify({ member: { bioguideId: 'D000563', firstName: 'Dick' } });

describe('MemberDetailFetcher', () => {
  it('canHandle member-detail → true; member-profile → false', () => {
    const f = new MemberDetailFetcher({ apiKey: 'k', fetch: vi.fn(), now: () => NOW });
    expect(f.canHandle({ kind: 'member-detail', params: {} })).toBe(true);
    expect(f.canHandle({ kind: 'member-profile', params: {} })).toBe(false);
  });

  it('composes /v3/member/{bioguideId}', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(BODY, { status: 200 }));
    const f = new MemberDetailFetcher({ apiKey: 'K', fetch: mock, now: () => NOW });
    await f.fetch({ kind: 'member-detail', params: { bioguideId: 'D000563' } }, { traceId: 'tr_0123456789abcdef' });
    const u = new URL(mock.mock.calls[0]![0] as string);
    expect(u.pathname).toBe('/v3/member/D000563');
    expect(u.searchParams.get('api_key')).toBe('K');
  });

  it('does NOT stamp sessionStatus (so R2Tier rejects)', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(BODY, { status: 200 }));
    const f = new MemberDetailFetcher({ apiKey: 'k', fetch: mock, now: () => NOW });
    const e = await f.fetch({ kind: 'member-detail', params: { bioguideId: 'D000563' } }, { traceId: 'tr_0123456789abcdef' });
    expect(e.sessionStatus).toBeUndefined();
    expect(e.sourceUpstream).toBe('congress');
  });

  it('throws on upstream error', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    const f = new MemberDetailFetcher({ apiKey: 'k', fetch: mock, now: () => NOW });
    await expect(f.fetch({ kind: 'member-detail', params: { bioguideId: 'D000563' } }, { traceId: 'tr_0123456789abcdef' })).rejects.toThrow(/404/);
  });
});
