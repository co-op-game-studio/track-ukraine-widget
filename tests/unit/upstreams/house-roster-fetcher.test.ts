/**
 * Tests for proxy/upstreams/house-roster-fetcher.ts.
 *
 * House roll-call member rosters come from api.congress.gov:
 *   /v3/house-vote/{c}/{s}/{rc}/members?limit=500
 * returning JSON. Static after session close (AC-41.4).
 *
 * Traces: FR-40 AC-40.7, FR-41 AC-41.4, FR-36 AC-36.3.
 */
import { describe, expect, it, vi } from 'vitest';
import { HouseRosterFetcher } from '../../../proxy/upstreams/house-roster-fetcher';
import type { CacheKey } from '../../../proxy/cache/key';

const FIXTURE = JSON.stringify({
  houseRollCallVoteMemberVotes: {
    results: [
      { bioguideID: 'A000370', voteCast: 'Yea' },
      { bioguideID: 'B000444', voteCast: 'Nay' },
    ],
  },
});

const NOW = new Date('2026-04-19T00:00:00Z');

describe('HouseRosterFetcher', () => {
  it('canHandle senate keys → false, house-roster → true', () => {
    const f = new HouseRosterFetcher({ apiKey: 'k', fetch: vi.fn(), now: () => NOW });
    expect(f.canHandle({ kind: 'house-roster', params: {} })).toBe(true);
    expect(f.canHandle({ kind: 'senate-xml', params: {} })).toBe(false);
  });

  it('composes URL with injected api_key + limit=500', async () => {
    const mock = vi.fn().mockResolvedValue(
      new Response(FIXTURE, { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const f = new HouseRosterFetcher({ apiKey: 'SECRET', fetch: mock, now: () => NOW });
    const k: CacheKey = { kind: 'house-roster', params: { congress: 117, session: 2, rollCall: 78 } };
    await f.fetch(k, { traceId: 'tr_0123456789abcdef' });
    const u = new URL(mock.mock.calls[0]![0] as string);
    expect(u.host).toBe('api.congress.gov');
    expect(u.pathname).toBe('/v3/house-vote/117/2/78/members');
    expect(u.searchParams.get('api_key')).toBe('SECRET');
    expect(u.searchParams.get('limit')).toBe('500');
  });

  it('forwards trace ID + Accept header', async () => {
    const mock = vi.fn().mockResolvedValue(
      new Response(FIXTURE, { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const f = new HouseRosterFetcher({ apiKey: 'k', fetch: mock, now: () => NOW });
    await f.fetch(
      { kind: 'house-roster', params: { congress: 117, session: 2, rollCall: 78 } },
      { traceId: 'tr_deadbeefcafebabe' },
    );
    const headers = new Headers((mock.mock.calls[0]![1] as RequestInit).headers);
    expect(headers.get('X-Trace-Id')).toBe('tr_deadbeefcafebabe');
    expect(headers.get('Accept')).toMatch(/json/i);
  });

  it('stores body verbatim as JSON string', async () => {
    const mock = vi.fn().mockResolvedValue(
      new Response(FIXTURE, { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const f = new HouseRosterFetcher({ apiKey: 'k', fetch: mock, now: () => NOW });
    const entry = await f.fetch(
      { kind: 'house-roster', params: { congress: 117, session: 2, rollCall: 78 } },
      { traceId: 'tr_0123456789abcdef' },
    );
    expect(entry.value).toBe(FIXTURE);
    expect(entry.contentType).toBe('application/json');
    expect(entry.sourceUpstream).toBe('congress');
  });

  it('stamps sessionStatus=frozen for past Congress', async () => {
    const mock = vi.fn().mockResolvedValue(
      new Response(FIXTURE, { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const f = new HouseRosterFetcher({ apiKey: 'k', fetch: mock, now: () => NOW });
    const entry = await f.fetch(
      { kind: 'house-roster', params: { congress: 117, session: 2, rollCall: 78 } },
      { traceId: 'tr_0123456789abcdef' },
    );
    expect(entry.sessionStatus).toBe('frozen');
  });

  it('stamps sessionStatus=live for current session', async () => {
    const mock = vi.fn().mockResolvedValue(
      new Response(FIXTURE, { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const f = new HouseRosterFetcher({ apiKey: 'k', fetch: mock, now: () => NOW });
    const entry = await f.fetch(
      { kind: 'house-roster', params: { congress: 119, session: 2, rollCall: 5 } },
      { traceId: 'tr_0123456789abcdef' },
    );
    expect(entry.sessionStatus).toBe('live');
  });

  it('throws on upstream 429 (fail-loud; pipeline wraps into envelope)', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const f = new HouseRosterFetcher({ apiKey: 'k', fetch: mock, now: () => NOW });
    await expect(
      f.fetch(
        { kind: 'house-roster', params: { congress: 117, session: 2, rollCall: 78 } },
        { traceId: 'tr_0123456789abcdef' },
      ),
    ).rejects.toThrow(/429/);
  });
});
