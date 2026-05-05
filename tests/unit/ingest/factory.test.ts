/**
 * Factory + adapter registry tests.
 *
 * Traces: FR-59 — social ingest factory/adapter contract.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerAdapter,
  getAdapter,
  adapterForUrl,
  listPlatforms,
  _resetRegistry,
} from '../../../src/ingest/factory';
import type { SocialAdapter, IngestedPost } from '../../../src/ingest/types';
import { UnknownPlatformError, UnsupportedUrlError } from '../../../src/ingest/types';

function fakeAdapter(platform: 'bluesky' | 'youtube', urlPattern: RegExp): SocialAdapter {
  return {
    platform,
    matchesUrl: (u) => urlPattern.test(u),
    resolveAccount: async () => ({ platformId: 'x', handle: 'x', displayName: 'x' }),
    listAuthorPosts: async () => ({ posts: [] }),
    fetchPostByUrl: async () => ({} as IngestedPost),
  };
}

beforeEach(() => {
  _resetRegistry();
});

describe('adapter factory', () => {
  it('registers and retrieves an adapter by slug', () => {
    const a = fakeAdapter('bluesky', /bsky/);
    registerAdapter(a);
    expect(getAdapter('bluesky')).toBe(a);
  });

  it('throws UnknownPlatformError for unregistered slug', () => {
    expect(() => getAdapter('youtube')).toThrow(UnknownPlatformError);
  });

  it('adapterForUrl routes to the right adapter', () => {
    const bsky = fakeAdapter('bluesky', /bsky\.app/);
    const yt = fakeAdapter('youtube', /youtube\.com/);
    registerAdapter(bsky);
    registerAdapter(yt);

    expect(adapterForUrl('https://bsky.app/profile/x/post/abc')).toBe(bsky);
    expect(adapterForUrl('https://youtube.com/watch?v=xyz')).toBe(yt);
  });

  it('adapterForUrl throws UnsupportedUrlError when nothing matches', () => {
    registerAdapter(fakeAdapter('bluesky', /bsky/));
    expect(() => adapterForUrl('https://unknown.example.com/post/1')).toThrow(UnsupportedUrlError);
  });

  it('listPlatforms returns registered slugs', () => {
    registerAdapter(fakeAdapter('bluesky', /bsky/));
    registerAdapter(fakeAdapter('youtube', /yt/));
    expect(listPlatforms()).toEqual(['bluesky', 'youtube']);
  });
});
