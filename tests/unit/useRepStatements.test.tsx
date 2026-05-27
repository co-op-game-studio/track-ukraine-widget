/**
 * useRepStatements — fetch curated social posts for a representative.
 * Covers FR-51 AC-51.5, FR-53 AC-53.2 / AC-53.5.
 *
 * Mocks fetchRepBundle by swapping globalThis.fetch and resetting the
 * inflight + cache map between cases.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useRepStatements, type SocialPostsRecord } from '../../src/hooks/useRepStatements';
import { _resetRepBundleCache } from '../../src/services/repBundle';

const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function bundleWithPosts(record: SocialPostsRecord | null) {
  return {
    bioguideId: 'D000563',
    member: {},
    bills: {},
    rollCalls: {},
    comments: {},
    socialPosts: record,
    quotes: null,
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

describe('useRepStatements', () => {
  it('returns idle status and skips fetch when bioguideId is null', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse({});
    }) as typeof globalThis.fetch;

    const { result } = renderHook(() => useRepStatements(null, ''));
    expect(result.current.status).toBe('idle');
    expect(result.current.posts).toEqual([]);
    expect(calls).toBe(0);
  });

  it('returns success when the bundle has posts', async () => {
    const record: SocialPostsRecord = {
      bioguideId: 'D000563',
      schemaVersion: 1,
      generatedAt: '2026-05-02T00:00:00Z',
      posts: [
        {
          id: 'p1',
          platform: 'x',
          url: 'https://x.com/SenatorDurbin/status/123',
          postedAt: '2026-04-28T12:00:00Z',
          bodyText: 'Stand with Ukraine.',
          weight: 0.1,
          direction: 1,
          comment: null,
          authorEmail: 'alice@example.com',
          createdAt: '2026-05-02T00:00:00Z',
        },
      ],
    };
    globalThis.fetch = (async () =>
      jsonResponse(bundleWithPosts(record))) as typeof globalThis.fetch;

    const { result } = renderHook(() => useRepStatements('D000563', ''));
    await waitFor(
      () => expect(result.current.status).toBe('success'),
      { timeout: 3000 },
    );
    expect(result.current.posts).toHaveLength(1);
    expect(result.current.posts[0]!.platform).toBe('x');
  });

  it('returns empty when the bundle has no socialPosts record', async () => {
    globalThis.fetch = (async () =>
      jsonResponse(bundleWithPosts(null))) as typeof globalThis.fetch;

    const { result } = renderHook(() => useRepStatements('D000563', ''));
    await waitFor(
      () => expect(result.current.status).toBe('empty'),
      { timeout: 3000 },
    );
    expect(result.current.posts).toEqual([]);
  });

  it('returns empty when the socialPosts record contains zero posts', async () => {
    const record: SocialPostsRecord = {
      bioguideId: 'D000563',
      schemaVersion: 1,
      generatedAt: '2026-05-02T00:00:00Z',
      posts: [],
    };
    globalThis.fetch = (async () =>
      jsonResponse(bundleWithPosts(record))) as typeof globalThis.fetch;

    const { result } = renderHook(() => useRepStatements('D000563', ''));
    await waitFor(
      () => expect(result.current.status).toBe('empty'),
      { timeout: 3000 },
    );
    expect(result.current.posts).toEqual([]);
  });

  it('AC-53.5 — returns empty on a 404 response', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: 'not_found' }, 404)) as typeof globalThis.fetch;

    const { result } = renderHook(() => useRepStatements('D000563', ''));
    await waitFor(
      () => expect(result.current.status).toBe('empty'),
      { timeout: 3000 },
    );
    expect(result.current.posts).toEqual([]);
  });

  it('AC-53.5 — returns empty on a 500 response (never bricks the embed)', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: 'oops' }, 500)) as typeof globalThis.fetch;

    const { result } = renderHook(() => useRepStatements('D000563', ''));
    await waitFor(
      () => expect(result.current.status).toBe('empty'),
      { timeout: 3000 },
    );
    expect(result.current.posts).toEqual([]);
  });

  it('ignores a late success after unmount (cancelled flag)', async () => {
    let resolveFetch!: (r: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    globalThis.fetch = (async () => pending) as typeof globalThis.fetch;
    const { result, unmount } = renderHook(() => useRepStatements('D000563', ''));
    expect(result.current.status).toBe('loading');
    unmount();
    resolveFetch(jsonResponse(bundleWithPosts(null)));
    await pending.then(() => undefined);
  });

  it('ignores a late error after unmount (cancelled flag)', async () => {
    let rejectFetch!: (e: Error) => void;
    const pending = new Promise<Response>((_, reject) => {
      rejectFetch = reject;
    });
    globalThis.fetch = (async () => pending) as typeof globalThis.fetch;
    const { unmount } = renderHook(() => useRepStatements('D000563', ''));
    unmount();
    rejectFetch(new Error('boom'));
    await pending.catch(() => undefined);
  });

  it('resets to idle when bioguideId switches back to null', async () => {
    const record: SocialPostsRecord = {
      bioguideId: 'D000563',
      schemaVersion: 1,
      generatedAt: '2026-05-02T00:00:00Z',
      posts: [
        {
          id: 'p1',
          platform: 'x',
          url: 'https://x.com/x/1',
          postedAt: null,
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
      jsonResponse(bundleWithPosts(record))) as typeof globalThis.fetch;

    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useRepStatements(id, ''),
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
    expect(result.current.posts).toEqual([]);
  });
});
