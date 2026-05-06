/**
 * Type contract tests — ensure domain types are well-formed.
 *
 * Traces: FR-59 — IngestedPost / SocialAdapter shape integrity.
 */
import { describe, it, expect } from 'vitest';
import type {
  IngestedPost,
} from '../../../src/ingest/types';
import {
  ALL_PLATFORMS,
  PostNotFoundError,
  UnknownPlatformError,
  UnsupportedUrlError,
} from '../../../src/ingest/types';

describe('IngestedPost type contract', () => {
  it('ALL_PLATFORMS contains the expected slugs', () => {
    // FB/IG dropped 2026-05 (Meta API access for non-owned pages requires
    // partnership we don't have — see CLAUDE.md). Threads removed alongside.
    // Twitter added 2026-05 with health-check-gated availability.
    expect(ALL_PLATFORMS).toContain('bluesky');
    expect(ALL_PLATFORMS).toContain('youtube');
    expect(ALL_PLATFORMS).toContain('mastodon');
    expect(ALL_PLATFORMS).toContain('twitter');
    expect(ALL_PLATFORMS).toHaveLength(4);
  });

  it('IngestedPost conforms to the expected shape (compile-time + runtime)', () => {
    const post: IngestedPost = {
      platform: 'bluesky',
      platformPostId: 'at://did:plc:abc/app.bsky.feed.post/xyz',
      authorHandle: 'test.bsky.social',
      authorPlatformId: 'did:plc:abc',
      postedAt: '2026-05-01T12:00:00Z',
      url: 'https://bsky.app/profile/test.bsky.social/post/xyz',
      bodyText: 'Hello world',
      mediaRefs: [{ kind: 'image', url: 'https://cdn.example.com/img.jpg', alt: 'photo' }],
      rawPayload: { original: true },
      language: 'en',
    };
    expect(post.platform).toBe('bluesky');
    expect(post.mediaRefs).toHaveLength(1);
    expect(post.rawPayload).toEqual({ original: true });
  });

  it('error classes carry distinct names', () => {
    expect(new PostNotFoundError('x').name).toBe('PostNotFoundError');
    expect(new UnknownPlatformError('x').name).toBe('UnknownPlatformError');
    expect(new UnsupportedUrlError('x').name).toBe('UnsupportedUrlError');
  });
});
