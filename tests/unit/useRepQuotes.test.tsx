/**
 * useRepQuotes — fetch curated quotes for a representative.
 * Covers FR-51 AC-51.6, FR-53 AC-53.2 / AC-53.5.
 *
 * Mocks fetchRepBundle by swapping globalThis.fetch and resetting the
 * inflight + cache map between cases.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useRepQuotes, type QuotesRecord } from '../../src/hooks/useRepQuotes';
import { _resetRepBundleCache } from '../../src/services/repBundle';

const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function bundleWithQuotes(record: QuotesRecord | null) {
  return {
    bioguideId: 'D000563',
    member: {},
    bills: {},
    rollCalls: {},
    comments: {},
    socialPosts: null,
    quotes: record,
    bundledAt: '2026-05-06T00:00:00Z',
  };
}

beforeEach(() => {
  _resetRepBundleCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  _resetRepBundleCache();
});

describe('useRepQuotes', () => {
  it('returns idle status when bioguideId is null and never calls fetch', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse({});
    }) as typeof globalThis.fetch;

    const { result } = renderHook(() => useRepQuotes(null, ''));
    // Initial render = idle, empty list, no fetch.
    expect(result.current.status).toBe('idle');
    expect(result.current.quotes).toEqual([]);
    expect(calls).toBe(0);
  });

  it('returns success when the bundle has quotes', async () => {
    const record: QuotesRecord = {
      bioguideId: 'D000563',
      schemaVersion: 1,
      generatedAt: '2026-05-02T00:00:00Z',
      quotes: [
        {
          id: 'q1',
          mediaKind: 'video',
          sourceUrl: 'https://www.c-span.org/video/?123',
          sourceLabel: 'C-SPAN floor speech',
          quotedAt: '2024-02-13',
          bodyText: 'I support Ukraine.',
          weight: 0.25,
          direction: 1,
          comment: null,
          authorEmail: 'alice@example.com',
          createdAt: '2026-05-02T00:00:00Z',
        },
      ],
    };
    globalThis.fetch = (async () =>
      jsonResponse(bundleWithQuotes(record))) as typeof globalThis.fetch;

    const { result } = renderHook(() => useRepQuotes('D000563', ''));
    await waitFor(
      () => expect(result.current.status).toBe('success'),
      { timeout: 3000 },
    );
    expect(result.current.quotes).toHaveLength(1);
    expect(result.current.quotes[0]!.id).toBe('q1');
  });

  it('returns empty status when the bundle has no quotes record', async () => {
    globalThis.fetch = (async () =>
      jsonResponse(bundleWithQuotes(null))) as typeof globalThis.fetch;

    const { result } = renderHook(() => useRepQuotes('D000563', ''));
    await waitFor(
      () => expect(result.current.status).toBe('empty'),
      { timeout: 3000 },
    );
    expect(result.current.quotes).toEqual([]);
  });

  it('returns empty when the bundle quotes record has zero quotes', async () => {
    const record: QuotesRecord = {
      bioguideId: 'D000563',
      schemaVersion: 1,
      generatedAt: '2026-05-02T00:00:00Z',
      quotes: [],
    };
    globalThis.fetch = (async () =>
      jsonResponse(bundleWithQuotes(record))) as typeof globalThis.fetch;

    const { result } = renderHook(() => useRepQuotes('D000563', ''));
    await waitFor(
      () => expect(result.current.status).toBe('empty'),
      { timeout: 3000 },
    );
    expect(result.current.quotes).toEqual([]);
  });

  it('AC-53.5 — returns empty (not error) on fetch failure (404)', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: 'not_found' }, 404)) as typeof globalThis.fetch;

    const { result } = renderHook(() => useRepQuotes('D000563', ''));
    await waitFor(
      () => expect(result.current.status).toBe('empty'),
      { timeout: 3000 },
    );
    expect(result.current.quotes).toEqual([]);
  });

  it('AC-53.5 — returns empty on 500 error too (never bricks the embed)', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: 'oops' }, 500)) as typeof globalThis.fetch;

    const { result } = renderHook(() => useRepQuotes('D000563', ''));
    await waitFor(
      () => expect(result.current.status).toBe('empty'),
      { timeout: 3000 },
    );
    expect(result.current.quotes).toEqual([]);
  });

  it('ignores a late success after unmount (cancelled flag)', async () => {
    let resolveFetch!: (r: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    globalThis.fetch = (async () => pending) as typeof globalThis.fetch;
    const { result, unmount } = renderHook(() => useRepQuotes('D000563', ''));
    expect(result.current.status).toBe('loading');
    unmount();
    resolveFetch(jsonResponse(bundleWithQuotes(null)));
    // Microtask drain — without throwing on the late update, this is fine.
    await pending.then(() => undefined);
  });

  it('ignores a late error after unmount (cancelled flag)', async () => {
    let rejectFetch!: (e: Error) => void;
    const pending = new Promise<Response>((_, reject) => {
      rejectFetch = reject;
    });
    globalThis.fetch = (async () => pending) as typeof globalThis.fetch;
    const { unmount } = renderHook(() => useRepQuotes('D000563', ''));
    unmount();
    rejectFetch(new Error('boom'));
    await pending.catch(() => undefined);
  });

  it('resets to idle when the bioguideId switches to null after a successful load', async () => {
    const record: QuotesRecord = {
      bioguideId: 'D000563',
      schemaVersion: 1,
      generatedAt: '2026-05-02T00:00:00Z',
      quotes: [
        {
          id: 'q1',
          mediaKind: 'video',
          sourceUrl: 'https://example.com',
          sourceLabel: null,
          quotedAt: null,
          bodyText: 'hello',
          weight: 0.1,
          direction: 1,
          comment: null,
          authorEmail: 'a@b',
          createdAt: '2026-05-02T00:00:00Z',
        },
      ],
    };
    globalThis.fetch = (async () =>
      jsonResponse(bundleWithQuotes(record))) as typeof globalThis.fetch;

    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useRepQuotes(id, ''),
      { initialProps: { id: 'D000563' as string | null } },
    );
    await waitFor(
      () => expect(result.current.status).toBe('success'),
      { timeout: 3000 },
    );
    rerender({ id: null });
    await waitFor(
      () => expect(result.current.status).toBe('idle'),
      { timeout: 3000 },
    );
    expect(result.current.quotes).toEqual([]);
  });
});
