/**
 * useNameSearch \u2014 debounced name-search hook.
 * Traces to: FR-31 AC-31.2 (150ms debounce), AC-31.8 (truncated), AC-31.9 (503 unavailable).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useNameSearch, type NameSearchResult } from '../../src/hooks/useNameSearch';

const DURBIN: NameSearchResult = {
  bioguideId: 'D000563',
  displayName: 'Richard Durbin',
  first: 'Richard',
  last: 'Durbin',
  state: 'IL',
  chamber: 'Senate',
  district: null,
  party: 'D',
  photoUrl: null,
  searchKeys: ['richard', 'durbin'],
};

function mockFetch(impl: Parameters<typeof globalThis.fetch>[0] extends string ? typeof fetch : typeof fetch) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(impl);
}

describe('useNameSearch', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('is idle initially with empty results', () => {
    const { result } = renderHook(() => useNameSearch(''));
    expect(result.current.status).toBe('idle');
    expect(result.current.results).toHaveLength(0);
  });

  it('AC-31.2: short queries (<2 chars) do NOT fire a fetch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ results: [], truncated: false }), { status: 200 }),
    );
    const { result } = renderHook(() => useNameSearch(''));
    act(() => result.current.setQuery('d'));
    // Wait past the debounce window to confirm no call happened.
    await new Promise((r) => setTimeout(r, 250));
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('returns results from /api/name-search on a 200 response', async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({ results: [DURBIN], truncated: false }),
        { status: 200 },
      ),
    );
    const { result } = renderHook(() => useNameSearch(''));
    act(() => result.current.setQuery('durb'));
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.results).toHaveLength(1);
    expect(result.current.results[0]!.bioguideId).toBe('D000563');
    expect(result.current.truncated).toBe(false);
  });

  it('AC-31.8: sets truncated=true when the Worker flags it', async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({ results: [DURBIN], truncated: true }),
        { status: 200 },
      ),
    );
    const { result } = renderHook(() => useNameSearch(''));
    act(() => result.current.setQuery('j'));
    act(() => result.current.setQuery('jo'));
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.truncated).toBe(true);
  });

  it('AC-31.9: 503 \u2192 status=unavailable with fallback message', async () => {
    mockFetch(async () => new Response('{}', { status: 503 }));
    const { result } = renderHook(() => useNameSearch(''));
    act(() => result.current.setQuery('x'));
    act(() => result.current.setQuery('xx'));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.error).toMatch(/temporarily unavailable/i);
    expect(result.current.results).toHaveLength(0);
  });

  it('non-ok non-503 response \u2192 status=error with code-bearing message', async () => {
    mockFetch(async () => new Response('nope', { status: 500 }));
    const { result } = renderHook(() => useNameSearch(''));
    act(() => result.current.setQuery('du'));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toMatch(/Search failed \(500\)/);
  });

  it('fetch rejection surfaces as status=error with the rejection message', async () => {
    mockFetch(async () => {
      throw new Error('network down');
    });
    const { result } = renderHook(() => useNameSearch(''));
    act(() => result.current.setQuery('du'));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toMatch(/network down/);
  });

  it('clear() resets query, results, status, and error back to idle', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ results: [DURBIN], truncated: false }), { status: 200 }),
    );
    const { result } = renderHook(() => useNameSearch(''));
    act(() => result.current.setQuery('durb'));
    await waitFor(() => expect(result.current.status).toBe('success'));
    act(() => result.current.clear());
    expect(result.current.query).toBe('');
    expect(result.current.status).toBe('idle');
    expect(result.current.results).toHaveLength(0);
    expect(result.current.error).toBeNull();
  });

  it('clearing the query (back to <2 chars) resets status to idle', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ results: [DURBIN], truncated: false }), { status: 200 }),
    );
    const { result } = renderHook(() => useNameSearch(''));
    act(() => result.current.setQuery('durb'));
    await waitFor(() => expect(result.current.status).toBe('success'));
    act(() => result.current.setQuery('d')); // back to short
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.results).toHaveLength(0);
  });
});
