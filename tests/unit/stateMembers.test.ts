/**
 * fetchStateMembers service \u2014 error / null / url-shape branches.
 * Traces to: FR-32 AC-32.16.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchStateMembers } from '../../src/services/stateMembers';

afterEach(() => vi.restoreAllMocks());

describe('fetchStateMembers', () => {
  it('returns the state record on 200', async () => {
    const record = {
      stateCode: 'IL',
      senators: [],
      house: [],
      generatedAt: '2026-04-19T02:00:00Z',
      schemaVersion: 1 as const,
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(record), { status: 200 }),
    );
    await expect(fetchStateMembers('IL', '')).resolves.toEqual(record);
  });

  it('returns null on 404 (curator has not written this state)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{}', { status: 404 }),
    );
    await expect(fetchStateMembers('ZZ', '')).resolves.toBeNull();
  });

  it('throws with the status code when upstream returns non-404 non-OK', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('boom', { status: 500 }),
    );
    await expect(fetchStateMembers('IL', '')).rejects.toThrow(/500/);
  });

  it('normalizes stateCode to uppercase in the request URL', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ stateCode: 'IL', senators: [], house: [], generatedAt: '', schemaVersion: 1 }), { status: 200 }),
    );
    await fetchStateMembers('il', '/proxy');
    const url = spy.mock.calls[0]?.[0] as string;
    expect(url).toMatch(/\/proxy\/api\/state-members\/IL$/);
  });

  it('strips trailing slashes from the apiBase', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ stateCode: 'IL', senators: [], house: [], generatedAt: '', schemaVersion: 1 }), { status: 200 }),
    );
    await fetchStateMembers('IL', 'https://host.example.com/');
    const url = spy.mock.calls[0]?.[0] as string;
    expect(url).toBe('https://host.example.com/api/state-members/IL');
  });
});
