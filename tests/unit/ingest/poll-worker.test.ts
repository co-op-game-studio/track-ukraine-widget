/**
 * Poll worker — orchestrator tests with faked deps.
 *
 * Traces: FR-59 — cron poll loop.
 */
import { describe, it, expect } from 'vitest';
import { pollPlatform, type PollDeps, type PollHandle, type EnqueueInput } from '../../../src/ingest/poll-worker';
import type { SocialAdapter, IngestedPost } from '../../../src/ingest/types';
import type { KeywordWatch } from '../../../src/ingest/keyword-matcher';

/* ---------- Helpers ---------- */

function makePost(id: string, text: string, postedAt: string): IngestedPost {
  return {
    platform: 'bluesky',
    platformPostId: `at://did:plc:abc/app.bsky.feed.post/${id}`,
    authorHandle: 'test.bsky.social',
    authorPlatformId: 'did:plc:abc',
    postedAt,
    url: `https://bsky.app/profile/test.bsky.social/post/${id}`,
    bodyText: text,
    mediaRefs: [],
    rawPayload: {},
  };
}

function fakeAdapter(posts: IngestedPost[]): SocialAdapter {
  return {
    platform: 'bluesky',
    matchesUrl: () => false,
    resolveAccount: async () => ({ platformId: 'x', handle: 'x', displayName: 'x' }),
    listAuthorPosts: async () => ({ posts }),
    fetchPostByUrl: async () => posts[0]!,
  };
}

function makeHandle(overrides?: Partial<PollHandle>): PollHandle {
  return {
    id: 'h1',
    bioguideId: 'D000563',
    platformId: 'did:plc:abc',
    handle: 'test.bsky.social',
    displayName: 'Senator Test',
    lastSeenPostId: null,
    ...overrides,
  };
}

const UKRAINE_WATCH: KeywordWatch = { watchName: 'ukraine', pattern: 'ukraine', isRegex: false };

/* ---------- Tests ---------- */

describe('pollPlatform', () => {
  it('enqueues new posts and updates poll state', async () => {
    const posts = [
      makePost('aaa', 'Hello world', '2026-05-01T12:00:00Z'),
      makePost('bbb', 'Good morning', '2026-05-01T11:00:00Z'),
    ];
    const enqueued: EnqueueInput[] = [];
    const pollUpdates: Array<{ id: string; lastSeenPostId: string | null }> = [];

    const deps: PollDeps = {
      adapter: fakeAdapter(posts),
      handles: [makeHandle()],
      keywords: [],
      enqueue: async (input) => { enqueued.push(input); return { id: 'q1' }; },
      updatePollState: async (id, _polledAt, lastSeenPostId) => {
        pollUpdates.push({ id, lastSeenPostId });
      },
    };

    const result = await pollPlatform(deps);
    expect(result.handlesPolled).toBe(1);
    expect(result.newPosts).toBe(2);
    expect(result.duplicates).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]!.bodyText).toBe('Hello world');
    expect(pollUpdates).toHaveLength(1);
    expect(pollUpdates[0]!.lastSeenPostId).toContain('aaa'); // newest by postedAt
  });

  it('counts duplicates when enqueue returns null', async () => {
    const posts = [makePost('aaa', 'Hello', '2026-05-01T12:00:00Z')];
    const deps: PollDeps = {
      adapter: fakeAdapter(posts),
      handles: [makeHandle()],
      keywords: [],
      enqueue: async () => null, // already exists
      updatePollState: async () => {},
    };

    const result = await pollPlatform(deps);
    expect(result.newPosts).toBe(0);
    expect(result.duplicates).toBe(1);
  });

  it('runs keyword matcher and reports matches', async () => {
    const posts = [
      makePost('aaa', 'Stand with Ukraine!', '2026-05-01T12:00:00Z'),
      makePost('bbb', 'Happy birthday team', '2026-05-01T11:00:00Z'),
    ];
    const enqueued: EnqueueInput[] = [];
    const deps: PollDeps = {
      adapter: fakeAdapter(posts),
      handles: [makeHandle()],
      keywords: [UKRAINE_WATCH],
      enqueue: async (input) => { enqueued.push(input); return { id: 'q1' }; },
      updatePollState: async () => {},
    };

    const result = await pollPlatform(deps);
    expect(result.keywordMatches).toBe(1);
    // The Ukraine-matching post should carry the keyword in enqueue input.
    expect(enqueued[0]!.matchedKeywords).toEqual(['ukraine']);
    expect(enqueued[1]!.matchedKeywords).toBeUndefined();
  });

  it('fires notify callback for keyword matches', async () => {
    const posts = [makePost('aaa', 'Ukraine aid bill', '2026-05-01T12:00:00Z')];
    const notified: Array<{ text: string; kw: string[] }> = [];
    const deps: PollDeps = {
      adapter: fakeAdapter(posts),
      handles: [makeHandle()],
      keywords: [UKRAINE_WATCH],
      enqueue: async () => ({ id: 'q1' }),
      updatePollState: async () => {},
      notify: async (post, kw) => { notified.push({ text: post.bodyText, kw }); },
    };

    await pollPlatform(deps);
    expect(notified).toHaveLength(1);
    expect(notified[0]!.kw).toEqual(['ukraine']);
  });

  it('captures per-handle errors without aborting the batch', async () => {
    const failAdapter: SocialAdapter = {
      platform: 'bluesky',
      matchesUrl: () => false,
      resolveAccount: async () => ({ platformId: 'x', handle: 'x', displayName: 'x' }),
      listAuthorPosts: async () => { throw new Error('rate limited'); },
      fetchPostByUrl: async () => ({ } as IngestedPost),
    };
    const deps: PollDeps = {
      adapter: failAdapter,
      handles: [makeHandle({ id: 'h1' }), makeHandle({ id: 'h2', handle: 'other.bsky.social' })],
      keywords: [],
      enqueue: async () => ({ id: 'q1' }),
      updatePollState: async () => {},
    };

    const result = await pollPlatform(deps);
    expect(result.handlesPolled).toBe(2);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]!.error).toMatch(/rate limited/);
  });

  it('handles empty handle list gracefully', async () => {
    const deps: PollDeps = {
      adapter: fakeAdapter([]),
      handles: [],
      keywords: [],
      enqueue: async () => ({ id: 'q1' }),
      updatePollState: async () => {},
    };

    const result = await pollPlatform(deps);
    expect(result.handlesPolled).toBe(0);
    expect(result.newPosts).toBe(0);
  });

  it('processes multiple handles in sequence', async () => {
    const postsByHandle: Record<string, IngestedPost[]> = {
      'did:plc:a': [makePost('p1', 'Post from A', '2026-05-01T12:00:00Z')],
      'did:plc:b': [makePost('p2', 'Post from B', '2026-05-01T11:00:00Z')],
    };
    const adapter: SocialAdapter = {
      platform: 'bluesky',
      matchesUrl: () => false,
      resolveAccount: async () => ({ platformId: 'x', handle: 'x', displayName: 'x' }),
      listAuthorPosts: async (input) => ({
        posts: postsByHandle[input.account.platformId] ?? [],
      }),
      fetchPostByUrl: async () => ({} as IngestedPost),
    };
    const enqueued: EnqueueInput[] = [];
    const deps: PollDeps = {
      adapter,
      handles: [
        makeHandle({ id: 'h1', platformId: 'did:plc:a', handle: 'a.bsky.social' }),
        makeHandle({ id: 'h2', platformId: 'did:plc:b', handle: 'b.bsky.social' }),
      ],
      keywords: [],
      enqueue: async (input) => { enqueued.push(input); return { id: 'q' }; },
      updatePollState: async () => {},
    };

    const result = await pollPlatform(deps);
    expect(result.handlesPolled).toBe(2);
    expect(result.newPosts).toBe(2);
    expect(enqueued.map((e) => e.bodyText)).toEqual(['Post from A', 'Post from B']);
  });
});
