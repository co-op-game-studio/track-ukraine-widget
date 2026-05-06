/**
 * Bluesky adapter unit tests — uses injected fetcher (no global mock).
 *
 * Traces: FR-59 — Bluesky connector.
 */
import { describe, it, expect } from 'vitest';
import { BlueskyAdapter } from '../../../src/ingest/adapters/bluesky';
import { PostNotFoundError } from '../../../src/ingest/types';
import type { Fetcher } from '../../../src/ingest/adapters/bluesky';

/* ---------- Fixtures ---------- */

const PROFILE_FIXTURE = {
  did: 'did:plc:abc123',
  handle: 'senatortest.bsky.social',
  displayName: 'Senator Test',
  avatar: 'https://cdn.bsky.app/img/avatar/plain/did:plc:abc123/test@jpeg',
};

function makePost(rkey: string, text: string, createdAt: string, extras?: Record<string, unknown>) {
  return {
    uri: `at://did:plc:abc123/app.bsky.feed.post/${rkey}`,
    cid: `cid-${rkey}`,
    author: PROFILE_FIXTURE,
    record: { text, createdAt, langs: ['en'], ...extras },
    indexedAt: createdAt,
  };
}

const FEED_PAGE_1 = {
  feed: [
    { post: makePost('aaa', 'Stand with Ukraine', '2026-05-01T12:00:00Z') },
    { post: makePost('bbb', 'Support our allies', '2026-04-30T12:00:00Z') },
  ],
  cursor: 'cursor-page-2',
};

const FEED_PAGE_2 = {
  feed: [
    { post: makePost('ccc', 'Democracy matters', '2026-04-29T12:00:00Z') },
  ],
  // no cursor = last page
};

const REPOST_FEED = {
  feed: [
    { post: makePost('ddd', 'Original post', '2026-05-01T12:00:00Z') },
    {
      post: makePost('eee', 'Someone else said this', '2026-05-01T11:00:00Z'),
      reason: { $type: 'app.bsky.feed.defs#reasonRepost' },
    },
  ],
};

const IMAGE_POST = makePost('img1', 'Look at this', '2026-05-01T12:00:00Z');
(IMAGE_POST as Record<string, unknown>).embed = {
  $type: 'app.bsky.embed.images#view',
  images: [
    { alt: 'Photo of rally', fullsize: 'https://cdn.bsky.app/img/1.jpg', thumb: 'https://cdn.bsky.app/img/1_thumb.jpg' },
  ],
};

const THREAD_FIXTURE = {
  thread: {
    $type: 'app.bsky.feed.defs#threadViewPost',
    post: makePost('zzz', 'A single post', '2026-05-02T08:00:00Z'),
  },
};

/* ---------- Fetcher stub ---------- */

function stubFetcher(routes: Record<string, unknown>): Fetcher {
  return async (url: string) => {
    for (const [pattern, body] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(body), { status: 200 });
      }
    }
    return new Response('not found', { status: 404 });
  };
}

/* ---------- Tests ---------- */

describe('BlueskyAdapter.matchesUrl', () => {
  const adapter = new BlueskyAdapter(() => Promise.resolve(new Response()));

  it('matches bsky.app post URLs', () => {
    expect(adapter.matchesUrl('https://bsky.app/profile/senatortest.bsky.social/post/abc123')).toBe(true);
  });

  it('matches bsky.social post URLs', () => {
    expect(adapter.matchesUrl('https://bsky.social/profile/test.bsky.social/post/abc123')).toBe(true);
  });

  it('rejects non-bluesky URLs', () => {
    expect(adapter.matchesUrl('https://x.com/senator/status/123')).toBe(false);
    expect(adapter.matchesUrl('https://youtube.com/watch?v=abc')).toBe(false);
  });
});

describe('BlueskyAdapter.resolveAccount', () => {
  it('resolves a handle to a DID via getProfile', async () => {
    const fetcher = stubFetcher({ 'app.bsky.actor.getProfile': PROFILE_FIXTURE });
    const adapter = new BlueskyAdapter(fetcher);

    const acct = await adapter.resolveAccount('senatortest.bsky.social');
    expect(acct.platformId).toBe('did:plc:abc123');
    expect(acct.handle).toBe('senatortest.bsky.social');
    expect(acct.displayName).toBe('Senator Test');
    expect(acct.avatarUrl).toMatch(/cdn\.bsky\.app/);
  });

  it('strips leading @ from handle', async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(PROFILE_FIXTURE), { status: 200 });
    };
    const adapter = new BlueskyAdapter(fetcher);
    await adapter.resolveAccount('@senatortest.bsky.social');
    expect(calls[0]).toMatch(/actor=senatortest\.bsky\.social/);
  });

  it('extracts handle from a web URL', async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(PROFILE_FIXTURE), { status: 200 });
    };
    const adapter = new BlueskyAdapter(fetcher);
    await adapter.resolveAccount('https://bsky.app/profile/senatortest.bsky.social/post/abc');
    expect(calls[0]).toMatch(/actor=senatortest\.bsky\.social/);
  });

  it('throws on 404', async () => {
    const fetcher: Fetcher = async () => new Response('nope', { status: 404 });
    const adapter = new BlueskyAdapter(fetcher);
    await expect(adapter.resolveAccount('nobody')).rejects.toThrow(/profile lookup failed/i);
  });
});

describe('BlueskyAdapter.listAuthorPosts', () => {
  const account = { platformId: 'did:plc:abc123', handle: 'senatortest.bsky.social', displayName: 'Senator Test' };

  it('returns posts with correct IngestedPost shape', async () => {
    const fetcher = stubFetcher({ 'app.bsky.feed.getAuthorFeed': FEED_PAGE_1 });
    const adapter = new BlueskyAdapter(fetcher);

    const result = await adapter.listAuthorPosts({ account });
    expect(result.posts).toHaveLength(2);
    expect(result.nextCursor).toBe('cursor-page-2');

    const first = result.posts[0]!;
    expect(first.platform).toBe('bluesky');
    expect(first.platformPostId).toBe('at://did:plc:abc123/app.bsky.feed.post/aaa');
    expect(first.authorHandle).toBe('senatortest.bsky.social');
    expect(first.authorPlatformId).toBe('did:plc:abc123');
    expect(first.bodyText).toBe('Stand with Ukraine');
    expect(first.url).toBe('https://bsky.app/profile/senatortest.bsky.social/post/aaa');
    expect(first.language).toBe('en');
  });

  it('respects sinceId — stops when it hits the known post', async () => {
    const fetcher = stubFetcher({ 'app.bsky.feed.getAuthorFeed': FEED_PAGE_1 });
    const adapter = new BlueskyAdapter(fetcher);

    const result = await adapter.listAuthorPosts({
      account,
      sinceId: 'at://did:plc:abc123/app.bsky.feed.post/bbb',
    });
    // Should only return the first post (aaa), stopping before bbb.
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0]!.platformPostId).toContain('aaa');
  });

  it('skips reposts', async () => {
    const fetcher = stubFetcher({ 'app.bsky.feed.getAuthorFeed': REPOST_FEED });
    const adapter = new BlueskyAdapter(fetcher);

    const result = await adapter.listAuthorPosts({ account });
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0]!.bodyText).toBe('Original post');
  });

  it('extracts media refs from image embeds', async () => {
    const feed = { feed: [{ post: IMAGE_POST }] };
    const fetcher = stubFetcher({ 'app.bsky.feed.getAuthorFeed': feed });
    const adapter = new BlueskyAdapter(fetcher);

    const result = await adapter.listAuthorPosts({ account });
    expect(result.posts[0]!.mediaRefs).toHaveLength(1);
    expect(result.posts[0]!.mediaRefs[0]!.kind).toBe('image');
    expect(result.posts[0]!.mediaRefs[0]!.alt).toBe('Photo of rally');
  });

  it('passes cursor for pagination', async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(FEED_PAGE_2), { status: 200 });
    };
    const adapter = new BlueskyAdapter(fetcher);

    await adapter.listAuthorPosts({ account, cursor: 'cursor-page-2' });
    expect(calls[0]).toMatch(/cursor=cursor-page-2/);
  });
});

describe('BlueskyAdapter.fetchPostByUrl', () => {
  it('fetches a single post by web URL', async () => {
    const fetcher = stubFetcher({
      'app.bsky.actor.getProfile': PROFILE_FIXTURE,
      'app.bsky.feed.getPostThread': THREAD_FIXTURE,
    });
    const adapter = new BlueskyAdapter(fetcher);

    const post = await adapter.fetchPostByUrl(
      'https://bsky.app/profile/senatortest.bsky.social/post/zzz',
    );
    expect(post.platform).toBe('bluesky');
    expect(post.bodyText).toBe('A single post');
    expect(post.url).toContain('/post/zzz');
  });

  it('throws PostNotFoundError for non-bluesky URL', async () => {
    const adapter = new BlueskyAdapter(async () => new Response('', { status: 200 }));
    await expect(
      adapter.fetchPostByUrl('https://x.com/test/status/123'),
    ).rejects.toThrow(PostNotFoundError);
  });

  it('throws PostNotFoundError when API returns 404', async () => {
    const fetcher: Fetcher = async (url) => {
      if (url.includes('getProfile')) {
        return new Response(JSON.stringify(PROFILE_FIXTURE), { status: 200 });
      }
      return new Response('gone', { status: 404 });
    };
    const adapter = new BlueskyAdapter(fetcher);
    await expect(
      adapter.fetchPostByUrl('https://bsky.app/profile/senatortest.bsky.social/post/gone'),
    ).rejects.toThrow(PostNotFoundError);
  });
});
