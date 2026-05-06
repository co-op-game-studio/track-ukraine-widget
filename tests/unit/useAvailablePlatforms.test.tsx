/**
 * Tests for src/admin/hooks/useAvailablePlatforms.ts.
 *
 * Verifies:
 *   - Initial render returns the empty array (or cached value).
 *   - After fetch resolves, hook returns the platform list.
 *   - On fetch error, hook degrades to [] (does not throw).
 *   - invalidatePlatformsCache() forces a re-fetch on next mount.
 *   - In-flight requests are deduped (single fetch for two simultaneous mounts).
 *
 * Trace: FR-59, AC-52.x (admin platform liveness).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  useAvailablePlatforms,
  invalidatePlatformsCache,
  type PlatformLiveness,
} from '../../src/admin/hooks/useAvailablePlatforms';

const realFetch = globalThis.fetch;

function makePlatform(slug: string, available = true): PlatformLiveness {
  return { slug, available, bulkEligible: available, checkedAt: '2026-05-04T00:00:00Z' };
}

beforeEach(() => {
  invalidatePlatformsCache();
  // Default URL the hook uses to derive the API base.
  // jsdom's location starts at http://localhost:3000/ — no `?env=`, so base is ''.
});

afterEach(() => {
  globalThis.fetch = realFetch;
  invalidatePlatformsCache();
});

describe('useAvailablePlatforms', () => {
  it('returns [] initially and populates after fetch resolves', async () => {
    const platforms = [makePlatform('bluesky'), makePlatform('mastodon', false)];
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ platforms }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    const { result } = renderHook(() => useAvailablePlatforms());
    expect(result.current).toEqual([]);
    await waitFor(() => expect(result.current.length).toBe(2));
    expect(result.current[0]!.slug).toBe('bluesky');
    expect(result.current[1]!.available).toBe(false);
  });

  it('degrades to [] on fetch error (no throw)', async () => {
    globalThis.fetch = async () => new Response('boom', { status: 500 });
    const { result } = renderHook(() => useAvailablePlatforms());
    // Wait through the microtask cycle.
    await waitFor(() => expect(result.current).toEqual([]));
    expect(result.current).toEqual([]);
  });

  it('caches across mounts (single fetch)', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ platforms: [makePlatform('bluesky')] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const first = renderHook(() => useAvailablePlatforms());
    await waitFor(() => expect(first.result.current.length).toBe(1));
    const second = renderHook(() => useAvailablePlatforms());
    await waitFor(() => expect(second.result.current.length).toBe(1));
    expect(calls).toBe(1);
  });

  it('invalidatePlatformsCache forces a re-fetch on next mount', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ platforms: [makePlatform('bluesky')] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const first = renderHook(() => useAvailablePlatforms());
    await waitFor(() => expect(first.result.current.length).toBe(1));
    invalidatePlatformsCache();
    const second = renderHook(() => useAvailablePlatforms());
    await waitFor(() => expect(second.result.current.length).toBe(1));
    expect(calls).toBe(2);
  });

  it('dedupes inflight: two simultaneous mounts share a single fetch', async () => {
    let calls = 0;
    let resolveFetch!: (r: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    globalThis.fetch = async () => {
      calls++;
      return pending;
    };
    const a = renderHook(() => useAvailablePlatforms());
    const b = renderHook(() => useAvailablePlatforms());
    // Both mounted before fetch resolves; only one underlying call.
    expect(calls).toBe(1);
    resolveFetch(
      new Response(JSON.stringify({ platforms: [makePlatform('bluesky')] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await waitFor(() => expect(a.result.current.length).toBe(1));
    await waitFor(() => expect(b.result.current.length).toBe(1));
  });
});
