/**
 * YouTube adapter unit tests.
 *
 * Traces: FR-59 — YouTube connector.
 */
import { describe, it, expect } from 'vitest';
import { YouTubeAdapter } from '../../../src/ingest/adapters/youtube';
import { PostNotFoundError, RateLimitError } from '../../../src/ingest/types';
import type { Fetcher } from '../../../src/ingest/adapters/youtube';
import type { AdapterLogger, AdapterLogEntry } from '../../../src/ingest/adapter-logger';

/* ---------- Fixtures ---------- */

const CHANNEL_FIXTURE = {
  items: [
    {
      id: 'UC_channel_123',
      snippet: {
        title: 'Sen. Durbin',
        customUrl: '@SenDurbin',
        thumbnails: { default: { url: 'https://yt.com/avatar.jpg' } },
      },
    },
  ],
};

const SEARCH_FIXTURE = {
  items: [
    {
      id: { kind: 'youtube#video', videoId: 'vid_aaa_xyz' },
      snippet: {
        publishedAt: '2026-05-01T12:00:00Z',
        title: 'Floor speech on Ukraine aid',
        description: 'Full remarks from the Senate floor.',
        channelId: 'UC_channel_123',
        channelTitle: 'Sen. Durbin',
        thumbnails: { high: { url: 'https://i.ytimg.com/vi/vid_aaa_xyz/hqdefault.jpg' } },
      },
    },
    {
      id: { kind: 'youtube#video', videoId: 'vid_bbb_xyz' },
      snippet: {
        publishedAt: '2026-04-28T08:00:00Z',
        title: 'Town hall recap',
        description: 'Q&A with constituents.',
        channelId: 'UC_channel_123',
        channelTitle: 'Sen. Durbin',
      },
    },
  ],
  nextPageToken: 'CDIQAA',
};

const VIDEO_FIXTURE = {
  items: [
    {
      id: 'vid_zzz_abc',
      snippet: {
        publishedAt: '2026-05-02T15:00:00Z',
        title: 'Press conference',
        description: 'Joint presser on foreign aid.',
        channelId: 'UC_channel_123',
        channelTitle: 'Sen. Durbin',
        thumbnails: { high: { url: 'https://i.ytimg.com/vi/vid_zzz_abc/hqdefault.jpg' } },
        defaultAudioLanguage: 'en',
      },
    },
  ],
};

/* ---------- Stub ---------- */

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

describe('YouTubeAdapter.matchesUrl', () => {
  const adapter = new YouTubeAdapter('test-key', async () => new Response());

  it('matches youtube.com/watch URLs', () => {
    expect(adapter.matchesUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
  });

  it('matches youtu.be short URLs', () => {
    expect(adapter.matchesUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
  });

  it('matches youtube.com/shorts URLs', () => {
    expect(adapter.matchesUrl('https://youtube.com/shorts/abc12345678')).toBe(true);
  });

  it('rejects non-youtube URLs', () => {
    expect(adapter.matchesUrl('https://bsky.app/profile/x/post/y')).toBe(false);
  });
});

describe('YouTubeAdapter.resolveAccount', () => {
  it('resolves a @handle to a channel ID', async () => {
    const fetcher = stubFetcher({ '/channels?': CHANNEL_FIXTURE });
    const adapter = new YouTubeAdapter('test-key', fetcher);

    const acct = await adapter.resolveAccount('@SenDurbin');
    expect(acct.platformId).toBe('UC_channel_123');
    expect(acct.handle).toBe('@SenDurbin');
    expect(acct.displayName).toBe('Sen. Durbin');
  });

  it('resolves a channel URL', async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(CHANNEL_FIXTURE), { status: 200 });
    };
    const adapter = new YouTubeAdapter('test-key', fetcher);
    await adapter.resolveAccount('https://youtube.com/@SenDurbin');
    expect(calls[0]).toMatch(/forHandle=%40SenDurbin/);
  });

  it('falls back to forUsername when forHandle returns empty', async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      // forHandle returns empty items; forUsername succeeds.
      if (url.includes('forHandle=')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (url.includes('forUsername=')) {
        return new Response(JSON.stringify(CHANNEL_FIXTURE), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };
    const adapter = new YouTubeAdapter('test-key', fetcher);
    const acct = await adapter.resolveAccount('senatorsanders');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/forHandle=%40senatorsanders/);
    expect(calls[1]).toMatch(/forUsername=senatorsanders/);
    expect(acct.platformId).toBe('UC_channel_123');
  });

  it('falls back to channel search when forHandle and forUsername both fail', async () => {
    const calls: string[] = [];
    const searchResult = {
      items: [{
        id: { channelId: 'UC_channel_123' },
        snippet: { title: 'Sen. Sanders', thumbnails: { default: { url: 'https://yt.com/avatar.jpg' } } },
      }],
    };
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      if (url.includes('forHandle=')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (url.includes('forUsername=')) {
        return new Response('bad request', { status: 400 });
      }
      if (url.includes('/search?')) {
        return new Response(JSON.stringify(searchResult), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };
    const adapter = new YouTubeAdapter('test-key', fetcher);
    const acct = await adapter.resolveAccount('senatorsanders');
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatch(/forHandle=%40senatorsanders/);
    expect(calls[1]).toMatch(/forUsername=senatorsanders/);
    expect(calls[2]).toMatch(/\/search\?.*type=channel/);
    expect(acct.platformId).toBe('UC_channel_123');
  });

  it('throws on 404', async () => {
    const adapter = new YouTubeAdapter('test-key', async () =>
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    await expect(adapter.resolveAccount('@nobody')).rejects.toThrow(/not found/i);
  });
});

describe('YouTubeAdapter.listAuthorPosts', () => {
  const account = { platformId: 'UC_channel_123', handle: '@SenDurbin', displayName: 'Sen. Durbin' };

  it('returns videos as IngestedPosts', async () => {
    const fetcher = stubFetcher({ '/search?': SEARCH_FIXTURE });
    const adapter = new YouTubeAdapter('test-key', fetcher);

    const result = await adapter.listAuthorPosts({ account });
    expect(result.posts).toHaveLength(2);
    expect(result.nextCursor).toBe('CDIQAA');

    const first = result.posts[0]!;
    expect(first.platform).toBe('youtube');
    expect(first.platformPostId).toBe('vid_aaa_xyz');
    expect(first.url).toBe('https://www.youtube.com/watch?v=vid_aaa_xyz');
    expect(first.bodyText).toContain('Floor speech on Ukraine aid');
    expect(first.bodyText).toContain('Full remarks from the Senate floor.');
    expect(first.mediaRefs).toHaveLength(1);
    expect(first.mediaRefs[0]!.kind).toBe('video');
  });

  it('respects sinceId', async () => {
    const fetcher = stubFetcher({ '/search?': SEARCH_FIXTURE });
    const adapter = new YouTubeAdapter('test-key', fetcher);

    const result = await adapter.listAuthorPosts({ account, sinceId: 'vid_bbb_xyz' });
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0]!.platformPostId).toBe('vid_aaa_xyz');
  });

  it('auto-resolves handle-style platformId to channel ID before search', async () => {
    // When seeded from congress-legislators, platformId is the vanity handle,
    // not a UC... channel ID. The adapter should resolve it on-the-fly.
    const handleAccount = { platformId: 'SenSanders', handle: 'SenSanders', displayName: 'Sen. Sanders' };
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      if (url.includes('/channels?')) {
        return new Response(JSON.stringify(CHANNEL_FIXTURE), { status: 200 });
      }
      if (url.includes('/search?')) {
        return new Response(JSON.stringify(SEARCH_FIXTURE), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };
    const adapter = new YouTubeAdapter('test-key', fetcher);

    const result = await adapter.listAuthorPosts({ account: handleAccount });
    // First call should be to /channels to resolve the handle.
    expect(calls[0]).toMatch(/\/channels\?/);
    // Second call should be to /search with the resolved UC channel ID.
    expect(calls[1]).toMatch(/channelId=UC_channel_123/);
    expect(result.posts).toHaveLength(2);
  });

  it('passes pageToken for pagination', async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    };
    const adapter = new YouTubeAdapter('test-key', fetcher);
    await adapter.listAuthorPosts({ account, cursor: 'CDIQAA' });
    expect(calls[0]).toMatch(/pageToken=CDIQAA/);
  });
});

describe('YouTubeAdapter.fetchPostByUrl', () => {
  it('fetches a single video by URL', async () => {
    const fetcher = stubFetcher({ '/videos?': VIDEO_FIXTURE });
    const adapter = new YouTubeAdapter('test-key', fetcher);

    const post = await adapter.fetchPostByUrl('https://www.youtube.com/watch?v=vid_zzz_abc');
    expect(post.platform).toBe('youtube');
    expect(post.platformPostId).toBe('vid_zzz_abc');
    expect(post.bodyText).toContain('Press conference');
    expect(post.language).toBe('en');
  });

  it('handles youtu.be short URL', async () => {
    const fetcher = stubFetcher({ '/videos?': VIDEO_FIXTURE });
    const adapter = new YouTubeAdapter('test-key', fetcher);

    const post = await adapter.fetchPostByUrl('https://youtu.be/vid_zzz_abc');
    expect(post.platformPostId).toBe('vid_zzz_abc');
  });

  it('throws PostNotFoundError for non-youtube URL', async () => {
    const adapter = new YouTubeAdapter('test-key', async () => new Response());
    await expect(
      adapter.fetchPostByUrl('https://bsky.app/profile/x/post/y'),
    ).rejects.toThrow(PostNotFoundError);
  });

  it('throws PostNotFoundError when video not found', async () => {
    const fetcher: Fetcher = async () =>
      new Response(JSON.stringify({ items: [] }), { status: 200 });
    const adapter = new YouTubeAdapter('test-key', fetcher);
    await expect(
      adapter.fetchPostByUrl('https://www.youtube.com/watch?v=nonexistent'),
    ).rejects.toThrow(PostNotFoundError);
  });

  it('throws PostNotFoundError when /videos returns non-OK', async () => {
    const fetcher: Fetcher = async () => new Response('forbidden', { status: 403 });
    const adapter = new YouTubeAdapter('test-key', fetcher);
    await expect(
      adapter.fetchPostByUrl('https://www.youtube.com/watch?v=vid_aaa_xyz'),
    ).rejects.toThrow(PostNotFoundError);
  });
});

/* ---------- Additional coverage: setLogger, healthCheck, branches ---------- */

describe('YouTubeAdapter.setLogger', () => {
  it('attaches a logger after construction and emits adapter log entries', async () => {
    const entries: AdapterLogEntry[] = [];
    const logger: AdapterLogger = { log: (e) => entries.push(e) };
    const fetcher = stubFetcher({ '/videos?': VIDEO_FIXTURE });
    const adapter = new YouTubeAdapter('test-key', fetcher);
    adapter.setLogger(logger);
    await adapter.fetchPostByUrl('https://www.youtube.com/watch?v=vid_zzz_abc');
    // withAdapterLog emits start + success entries when a logger is attached.
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.platform === 'youtube')).toBe(true);
  });
});

describe('YouTubeAdapter.healthCheck', () => {
  it('resolves when the upstream channels endpoint returns 200', async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ items: [{ id: 'UCBR8-60-B28hp2BmDPdntcQ' }] }), {
        status: 200,
      });
    };
    const adapter = new YouTubeAdapter('test-key', fetcher);
    await expect(adapter.healthCheck()).resolves.toBeUndefined();
    expect(calls[0]).toMatch(/\/channels\?part=id&id=UCBR8/);
    expect(calls[0]).toMatch(/key=test-key/);
  });

  it('throws with status + body snippet on non-OK', async () => {
    const fetcher: Fetcher = async () =>
      new Response('quota exhausted for the day', { status: 403 });
    const adapter = new YouTubeAdapter('test-key', fetcher);
    await expect(adapter.healthCheck()).rejects.toThrow(/health check failed \(403\)/);
  });
});

describe('YouTubeAdapter.resolveAccount — channel-id branch', () => {
  it('resolves a raw UC... channel id via /channels?id=', async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(CHANNEL_FIXTURE), { status: 200 });
    };
    const adapter = new YouTubeAdapter('test-key', fetcher);
    const acct = await adapter.resolveAccount('UC_channel_123');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/[?&]id=UC_channel_123/);
    expect(acct.platformId).toBe('UC_channel_123');
    expect(acct.displayName).toBe('Sen. Durbin');
  });

  it('throws non-rate-limit upstream errors when looking up by channel id', async () => {
    // 500 is not a rate-limit; checkResponse returns the body, then the
    // adapter wraps it as a generic Error with the status.
    const fetcher: Fetcher = async () => new Response('boom', { status: 500 });
    const adapter = new YouTubeAdapter('test-key', fetcher);
    await expect(adapter.resolveAccount('UC_channel_500')).rejects.toThrow(/lookup failed \(500\)/);
  });

  it('short-circuits on 429 from forHandle (rate-limit)', async () => {
    // forHandle returns 429 — must throw RateLimitError WITHOUT falling through
    // to forUsername (the whole point of the rate-limit guard).
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      return new Response('rate limited', {
        status: 429,
        headers: { 'retry-after': '30' },
      });
    };
    const adapter = new YouTubeAdapter('test-key', fetcher);
    await expect(adapter.resolveAccount('senatorsanders')).rejects.toThrow(RateLimitError);
    // Only one upstream call: forHandle. forUsername must NOT have been tried.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/forHandle=/);
  });

  it('short-circuits on 429 from forUsername after empty forHandle', async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      if (url.includes('forHandle=')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      // forUsername now returns 429.
      return new Response('rate limited', {
        status: 429,
        headers: { 'retry-after': '60' },
      });
    };
    const adapter = new YouTubeAdapter('test-key', fetcher);
    await expect(adapter.resolveAccount('senatorsanders')).rejects.toThrow(RateLimitError);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatch(/forUsername=/);
  });

  it('re-throws RateLimitError from the search fallback (last-resort path)', async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      if (url.includes('forHandle=')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (url.includes('forUsername=')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      // /search hits the daily quota.
      return new Response('quota exhausted', { status: 403 });
    };
    const adapter = new YouTubeAdapter('test-key', fetcher);
    await expect(adapter.resolveAccount('senatorsanders')).rejects.toThrow(RateLimitError);
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatch(/\/search\?/);
  });
});

describe('YouTubeAdapter.listAuthorPosts — error branches', () => {
  it('wraps resolveAccount failures with a clear "cannot resolve" error', async () => {
    // Handle-style platformId triggers the on-the-fly resolveAccount() call,
    // which then fails because every /channels lookup returns 404.
    const handleAccount = {
      platformId: 'NotAChannelId',
      handle: '@unknown',
      displayName: 'Unknown',
    };
    const fetcher: Fetcher = async () =>
      new Response(JSON.stringify({ items: [] }), { status: 200 });
    const adapter = new YouTubeAdapter('test-key', fetcher);
    await expect(adapter.listAuthorPosts({ account: handleAccount })).rejects.toThrow(
      /Cannot resolve YouTube channel/,
    );
  });

  it('throws when /search returns non-OK (non-rate-limit)', async () => {
    const account = { platformId: 'UC_channel_123', handle: '@SenDurbin', displayName: 'Sen. Durbin' };
    const fetcher: Fetcher = async () => new Response('boom', { status: 500 });
    const adapter = new YouTubeAdapter('test-key', fetcher);
    await expect(adapter.listAuthorPosts({ account })).rejects.toThrow(
      /YouTube search failed \(500\)/,
    );
  });

  it('short-circuits with RateLimitError when /search hits quota', async () => {
    const account = { platformId: 'UC_channel_123', handle: '@SenDurbin', displayName: 'Sen. Durbin' };
    const fetcher: Fetcher = async () =>
      new Response('quota exhausted', { status: 403 });
    const adapter = new YouTubeAdapter('test-key', fetcher);
    await expect(adapter.listAuthorPosts({ account })).rejects.toThrow(RateLimitError);
  });

  it('throws "not a valid UC channel ID" when resolution returns a non-UC id', async () => {
    // resolveAccount path returns success but with a non-UC platformId — the
    // search-fallback branch returns the username verbatim as platformId when
    // no UC id is found. The adapter must refuse to call /search with that.
    const handleAccount = {
      platformId: 'plainhandle',
      handle: 'plainhandle',
      displayName: 'Plain Handle',
    };
    const fetcher: Fetcher = async (url) => {
      // forHandle empty, forUsername empty, /search returns a hit but the
      // result has NO channelId in id, so adapter falls through to the
      // generic "channel not found" — wait, that throws too. Need a path
      // that returns success with non-UC id. Easiest: construct one
      // through forUsername returning a channel whose id doesn't start
      // with "UC".
      if (url.includes('forUsername=')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 'NotAUC123',
                snippet: { title: 'Plain', customUrl: 'plain', thumbnails: {} },
              },
            ],
          }),
          { status: 200 },
        );
      }
      // forHandle empty
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    };
    const adapter = new YouTubeAdapter('test-key', fetcher);
    await expect(adapter.listAuthorPosts({ account: handleAccount })).rejects.toThrow(
      /is not a valid UC channel ID/,
    );
  });
});
