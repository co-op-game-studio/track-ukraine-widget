/**
 * Mastodon adapter unit tests — uses injected fetcher (no global mock).
 *
 * Traces: FR-59 — Mastodon connector.
 */
import { describe, it, expect } from 'vitest';
import { MastodonAdapter } from '../../../src/ingest/adapters/mastodon';
import { PostNotFoundError } from '../../../src/ingest/types';
import type { Fetcher } from '../../../src/ingest/adapters/mastodon';

/* ---------- Fixtures ---------- */

const ACCOUNT_FIXTURE = {
  id: '12345',
  acct: 'senatortest',
  username: 'senatortest',
  display_name: 'Senator Test',
  avatar: 'https://mastodon.social/avatars/12345.jpg',
  url: 'https://mastodon.social/@senatortest',
};

function makeStatus(
  id: string,
  content: string,
  createdAt: string,
  extras?: Record<string, unknown>,
) {
  return {
    id,
    created_at: createdAt,
    content: `<p>${content}</p>`,
    url: `https://mastodon.social/@senatortest/${id}`,
    reblog: null,
    account: ACCOUNT_FIXTURE,
    language: 'en',
    media_attachments: [],
    ...extras,
  };
}

const TIMELINE_PAGE_1 = [
  makeStatus('111', 'Stand with Ukraine', '2026-05-01T12:00:00Z'),
  makeStatus('222', 'Support our allies', '2026-04-30T12:00:00Z'),
];

const REBLOG_TIMELINE = [
  makeStatus('333', 'Original post', '2026-05-01T12:00:00Z'),
  makeStatus('444', 'Boosted content', '2026-05-01T11:00:00Z', {
    reblog: makeStatus('555', 'Someone else said this', '2026-05-01T10:00:00Z'),
  }),
];

const IMAGE_STATUS = makeStatus('img1', 'Look at this', '2026-05-01T12:00:00Z', {
  media_attachments: [
    { type: 'image', url: 'https://mastodon.social/media/img1.jpg', description: 'Photo of rally' },
  ],
});

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

describe('MastodonAdapter.matchesUrl', () => {
  const adapter = new MastodonAdapter(() => Promise.resolve(new Response()));

  it('matches mastodon status URLs', () => {
    expect(adapter.matchesUrl('https://mastodon.social/@senatortest/123456789')).toBe(true);
  });

  it('matches any instance URL with @user/digits pattern', () => {
    expect(adapter.matchesUrl('https://fosstodon.org/@testuser/999888777')).toBe(true);
  });

  it('matches cross-instance URLs with @user@instance/digits', () => {
    expect(adapter.matchesUrl('https://mastodon.social/@user@other.social/123456')).toBe(true);
  });

  it('rejects non-mastodon URLs', () => {
    expect(adapter.matchesUrl('https://bsky.app/profile/test/post/abc')).toBe(false);
    expect(adapter.matchesUrl('https://youtube.com/watch?v=abc')).toBe(false);
    expect(adapter.matchesUrl('https://x.com/senator/status/123')).toBe(false);
  });
});

describe('MastodonAdapter.resolveAccount', () => {
  it('resolves @user@instance handle via account lookup', async () => {
    const fetcher = stubFetcher({ 'accounts/lookup': ACCOUNT_FIXTURE });
    const adapter = new MastodonAdapter(fetcher);

    const acct = await adapter.resolveAccount('@senatortest@mastodon.social');
    expect(acct.platformId).toBe('12345');
    expect(acct.handle).toBe('@senatortest@mastodon.social');
    expect(acct.displayName).toBe('Senator Test');
    expect(acct.avatarUrl).toMatch(/mastodon\.social/);
  });

  it('resolves handle without leading @', async () => {
    const fetcher = stubFetcher({ 'accounts/lookup': ACCOUNT_FIXTURE });
    const adapter = new MastodonAdapter(fetcher);

    const acct = await adapter.resolveAccount('senatortest@mastodon.social');
    expect(acct.platformId).toBe('12345');
  });

  it('resolves from a profile URL', async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(ACCOUNT_FIXTURE), { status: 200 });
    };
    const adapter = new MastodonAdapter(fetcher);
    await adapter.resolveAccount('https://mastodon.social/@senatortest');
    expect(calls[0]).toMatch(/mastodon\.social.*accounts\/lookup/);
  });

  it('throws on unparseable handle', async () => {
    const adapter = new MastodonAdapter(async () => new Response('', { status: 200 }));
    await expect(adapter.resolveAccount('just-a-name')).rejects.toThrow(/Cannot parse Mastodon handle/);
  });

  it('throws on 404 account lookup', async () => {
    const fetcher: Fetcher = async () => new Response('nope', { status: 404 });
    const adapter = new MastodonAdapter(fetcher);
    await expect(adapter.resolveAccount('@nobody@mastodon.social')).rejects.toThrow(/account lookup failed/i);
  });
});

describe('MastodonAdapter.listAuthorPosts', () => {
  const account = { platformId: '12345', handle: '@senatortest@mastodon.social', displayName: 'Senator Test' };

  it('returns posts with correct IngestedPost shape', async () => {
    const fetcher = stubFetcher({ '/statuses': TIMELINE_PAGE_1 });
    const adapter = new MastodonAdapter(fetcher);

    const result = await adapter.listAuthorPosts({ account });
    expect(result.posts).toHaveLength(2);

    const first = result.posts[0]!;
    expect(first.platform).toBe('mastodon');
    expect(first.platformPostId).toBe('111');
    expect(first.authorHandle).toBe('@senatortest@mastodon.social');
    expect(first.authorPlatformId).toBe('12345');
    expect(first.bodyText).toBe('Stand with Ukraine');
    expect(first.url).toContain('/111');
    expect(first.language).toBe('en');
  });

  it('strips HTML from content', async () => {
    const htmlStatus = makeStatus('666', '', '2026-05-01T12:00:00Z');
    htmlStatus.content = '<p>Hello <strong>world</strong>!</p><br/><p>New paragraph</p>';
    const fetcher = stubFetcher({ '/statuses': [htmlStatus] });
    const adapter = new MastodonAdapter(fetcher);

    const result = await adapter.listAuthorPosts({ account });
    expect(result.posts[0]!.bodyText).toBe('Hello world!\n\nNew paragraph');
  });

  it('skips boosts (reblogs)', async () => {
    const fetcher = stubFetcher({ '/statuses': REBLOG_TIMELINE });
    const adapter = new MastodonAdapter(fetcher);

    const result = await adapter.listAuthorPosts({ account });
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0]!.bodyText).toBe('Original post');
  });

  it('respects sinceId — stops when it hits the known post', async () => {
    const fetcher = stubFetcher({ '/statuses': TIMELINE_PAGE_1 });
    const adapter = new MastodonAdapter(fetcher);

    const result = await adapter.listAuthorPosts({
      account,
      sinceId: '222',
    });
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0]!.platformPostId).toBe('111');
  });

  it('extracts media refs from attachments', async () => {
    const fetcher = stubFetcher({ '/statuses': [IMAGE_STATUS] });
    const adapter = new MastodonAdapter(fetcher);

    const result = await adapter.listAuthorPosts({ account });
    expect(result.posts[0]!.mediaRefs).toHaveLength(1);
    expect(result.posts[0]!.mediaRefs[0]!.kind).toBe('image');
    expect(result.posts[0]!.mediaRefs[0]!.alt).toBe('Photo of rally');
  });

  it('uses max_id pagination when page is full', async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(TIMELINE_PAGE_1), { status: 200 });
    };
    const adapter = new MastodonAdapter(fetcher);

    await adapter.listAuthorPosts({ account, cursor: 'prev-cursor-id' });
    expect(calls[0]).toMatch(/max_id=prev-cursor-id/);
  });

  it('returns nextCursor when page is full', async () => {
    // Return exactly maxResults items to trigger pagination cursor.
    const fullPage = Array.from({ length: 25 }, (_, i) =>
      makeStatus(String(1000 + i), `Post ${i}`, '2026-05-01T12:00:00Z'),
    );
    const fetcher = stubFetcher({ '/statuses': fullPage });
    const adapter = new MastodonAdapter(fetcher);

    const result = await adapter.listAuthorPosts({ account, maxPosts: 25 });
    expect(result.nextCursor).toBe('1024');
  });
});

describe('MastodonAdapter.fetchPostByUrl', () => {
  it('fetches a single post by URL', async () => {
    const status = makeStatus('789', 'A single post', '2026-05-02T08:00:00Z');
    const fetcher = stubFetcher({ '/api/v1/statuses/789': status });
    const adapter = new MastodonAdapter(fetcher);

    const post = await adapter.fetchPostByUrl('https://mastodon.social/@senatortest/789');
    expect(post.platform).toBe('mastodon');
    expect(post.bodyText).toBe('A single post');
    expect(post.platformPostId).toBe('789');
    expect(post.authorHandle).toBe('@senatortest@mastodon.social');
  });

  it('throws PostNotFoundError for non-mastodon URL', async () => {
    const adapter = new MastodonAdapter(async () => new Response('', { status: 200 }));
    await expect(
      adapter.fetchPostByUrl('https://x.com/test/status/123'),
    ).rejects.toThrow(PostNotFoundError);
  });

  it('throws PostNotFoundError when API returns 404', async () => {
    const fetcher: Fetcher = async () => new Response('gone', { status: 404 });
    const adapter = new MastodonAdapter(fetcher);
    await expect(
      adapter.fetchPostByUrl('https://mastodon.social/@senatortest/gone999'),
    ).rejects.toThrow(PostNotFoundError);
  });

  it('decodes HTML entities in fetched post', async () => {
    const status = makeStatus('12345', '', '2026-05-02T08:00:00Z');
    status.content = '<p>AT&amp;T &gt; Others &quot;quoted&quot;</p>';
    const fetcher = stubFetcher({ '/api/v1/statuses/12345': status });
    const adapter = new MastodonAdapter(fetcher);

    const post = await adapter.fetchPostByUrl('https://mastodon.social/@senatortest/12345');
    expect(post.bodyText).toBe('AT&T > Others "quoted"');
  });
});

describe('MastodonAdapter HTML entity decoding', () => {
  const account = { platformId: '12345', handle: '@senatortest@mastodon.social', displayName: 'Senator Test' };

  it('decodes &amp; &lt; &gt; &quot; &#39;', async () => {
    const status = makeStatus('ent2', '', '2026-05-02T08:00:00Z');
    status.content = '<p>AT&amp;T says &lt;hello&gt; &quot;world&quot; it&#39;s fine</p>';
    const fetcher = stubFetcher({ '/statuses': [status] });
    const adapter = new MastodonAdapter(fetcher);

    const result = await adapter.listAuthorPosts({ account });
    expect(result.posts[0]!.bodyText).toBe('AT&T says <hello> "world" it\'s fine');
  });

  it('converts <br> to newlines', async () => {
    const status = makeStatus('br1', '', '2026-05-02T08:00:00Z');
    status.content = '<p>Line one<br/>Line two<br>Line three</p>';
    const fetcher = stubFetcher({ '/statuses': [status] });
    const adapter = new MastodonAdapter(fetcher);

    const result = await adapter.listAuthorPosts({ account });
    expect(result.posts[0]!.bodyText).toBe('Line one\nLine two\nLine three');
  });
});
