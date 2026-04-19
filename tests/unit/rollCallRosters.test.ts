/**
 * rollCallRosters service \u2014 error / null / normalizeVoteCast.
 * Traces to: FR-12 (REVISED v2.5.2), FR-32 AC-32.15.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchRollCallRoster, normalizeVoteCast } from '../../src/services/rollCallRosters';

afterEach(() => vi.restoreAllMocks());

describe('fetchRollCallRoster', () => {
  it('returns the roster on 200', async () => {
    const record = {
      rollCallId: 'house:118:2:151',
      chamber: 'house' as const,
      congress: 118,
      session: 2,
      rollCall: 151,
      casts: { J000289: 'Nay' },
      generatedAt: '2026-04-19T02:00:00Z',
      schemaVersion: 1 as const,
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(record), { status: 200 }),
    );
    const r = await fetchRollCallRoster('House', 118, 2, 151, '');
    expect(r).toEqual(record);
  });

  it('returns null on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 404 }));
    await expect(fetchRollCallRoster('Senate', 118, 2, 99, '')).resolves.toBeNull();
  });

  it('throws with the status code when upstream returns non-404 non-OK', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(fetchRollCallRoster('House', 118, 2, 151, '')).rejects.toThrow(/500/);
  });

  it('maps House \u2192 house and Senate \u2192 senate in the URL', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({}), { status: 200 }),
    );
    await fetchRollCallRoster('House', 118, 2, 1, '/p');
    await fetchRollCallRoster('Senate', 118, 2, 1, '/p');
    const urls = spy.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toBe('/p/api/roll-call-rosters/house/118/2/1');
    expect(urls[1]).toBe('/p/api/roll-call-rosters/senate/118/2/1');
  });
});

describe('normalizeVoteCast', () => {
  it('Yea and Aye both map to Aye', () => {
    expect(normalizeVoteCast('Yea')).toBe('Aye');
    expect(normalizeVoteCast('Aye')).toBe('Aye');
  });
  it('Nay maps to Nay', () => {
    expect(normalizeVoteCast('Nay')).toBe('Nay');
  });
  it('Present maps to Present', () => {
    expect(normalizeVoteCast('Present')).toBe('Present');
  });
  it('anything else maps to "Not Voting"', () => {
    expect(normalizeVoteCast('Not Voting')).toBe('Not Voting');
    expect(normalizeVoteCast('')).toBe('Not Voting');
    expect(normalizeVoteCast('weird')).toBe('Not Voting');
  });
});
