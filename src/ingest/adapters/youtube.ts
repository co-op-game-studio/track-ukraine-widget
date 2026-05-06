/**
 * YouTube adapter — Google Data API v3.
 *
 * Free within 10,000 units/day. Channel uploads list = 1 unit/call,
 * video details = 1 unit/call. Polling 350 MoCs 4×/day = ~1,400 units.
 *
 * Requires a YouTube Data API key (injected via constructor). No OAuth
 * needed for public channel data.
 *
 * Traces: FR-59 (social ingest — YouTube connector).
 */
import type {
  SocialAdapter,
  IngestedPost,
  ResolvedAccount,
  ListAuthorPostsInput,
  ListAuthorPostsResult,
} from '../types';
import { PostNotFoundError, RateLimitError } from '../types';
import { checkResponse } from '../http-status';
import type { AdapterLogger } from '../adapter-logger';
import { withAdapterLog } from '../adapter-logger';

const YT_API = 'https://www.googleapis.com/youtube/v3';

/* ---------- YouTube API response shapes ---------- */

interface YTChannel {
  id: string;
  snippet: {
    title: string;
    customUrl?: string;
    thumbnails?: { default?: { url: string } };
  };
}

interface YTSearchItem {
  id: { kind: string; videoId?: string };
  snippet: {
    publishedAt: string;
    title: string;
    description: string;
    channelId: string;
    channelTitle: string;
    thumbnails?: { high?: { url: string } };
  };
}

interface YTVideoItem {
  id: string;
  snippet: {
    publishedAt: string;
    title: string;
    description: string;
    channelId: string;
    channelTitle: string;
    thumbnails?: { high?: { url: string } };
    defaultAudioLanguage?: string;
  };
}

/* ---------- Helpers ---------- */

function videoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function parseVideoId(url: string): string | null {
  // youtube.com/watch?v=XXX, youtu.be/XXX, youtube.com/shorts/XXX
  let m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (m) return m[1]!;
  m = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (m) return m[1]!;
  m = url.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/);
  if (m) return m[1]!;
  return null;
}

function parseChannelRef(input: string): { kind: 'id' | 'handle'; value: string } | null {
  // @handle, /channel/UCxxx, /@handle, or raw channel ID
  let m = input.match(/youtube\.com\/@([^/?]+)/);
  if (m) return { kind: 'handle', value: `@${m[1]}` };
  m = input.match(/youtube\.com\/channel\/([^/?]+)/);
  if (m) return { kind: 'id', value: m[1]! };
  if (input.startsWith('@')) return { kind: 'handle', value: input };
  if (input.startsWith('UC')) return { kind: 'id', value: input };
  return { kind: 'handle', value: `@${input}` };
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/* ---------- Adapter ---------- */

export class YouTubeAdapter implements SocialAdapter {
  readonly platform = 'youtube' as const;
  private apiKey: string;
  private fetch: Fetcher;
  private logger?: AdapterLogger;

  constructor(apiKey: string, fetcher?: Fetcher, logger?: AdapterLogger) {
    this.apiKey = apiKey;
    this.fetch = fetcher ?? globalThis.fetch.bind(globalThis);
    this.logger = logger;
  }

  /** Attach or replace the logger after construction. */
  setLogger(logger: AdapterLogger): void {
    this.logger = logger;
  }

  matchesUrl(url: string): boolean {
    return /youtube\.com\/(watch|shorts)|youtu\.be\//i.test(url);
  }

  /** Cheapest possible call: lookup the official YouTube channel by id (1 unit
   *  out of 10k daily). Verifies the API key and that YouTube Data API v3 is
   *  enabled on the GCP project. Quota errors here mean we're already cooked
   *  for the day, which is a legitimate "not available" signal. */
  async healthCheck(): Promise<void> {
    const res = await this.fetch(`${YT_API}/channels?part=id&id=UCBR8-60-B28hp2BmDPdntcQ&key=${this.apiKey}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`youtube health check failed (${res.status}): ${body.slice(0, 200)}`);
    }
  }

  async resolveAccount(handleOrUrl: string): Promise<ResolvedAccount> {
    return withAdapterLog(this.logger, { platform: 'youtube', operation: 'resolveAccount', handle: handleOrUrl }, async () => {
      const ref = parseChannelRef(handleOrUrl);
      if (!ref) throw new Error(`Cannot parse YouTube channel ref: ${handleOrUrl}`);

      if (ref.kind === 'id') {
        const res = await this.fetch(`${YT_API}/channels?part=snippet&id=${encodeURIComponent(ref.value)}&key=${this.apiKey}`);
        if (!res.ok) {
          // checkResponse throws RateLimitError on 429/403-quota, otherwise returns body.
          const body = await checkResponse('youtube', res, `channel id=${ref.value}`);
          throw new Error(`YouTube channel lookup failed (${res.status}): ${body.slice(0, 200)}`);
        }
        const data = (await res.json()) as { items?: YTChannel[] };
        if (!data.items?.length) throw new Error(`YouTube channel not found: ${handleOrUrl}`);
        const ch = data.items[0]!;
        return { platformId: ch.id, handle: ch.snippet.customUrl ?? ch.id, displayName: ch.snippet.title, avatarUrl: ch.snippet.thumbnails?.default?.url };
      }

      // Handle lookup — try forHandle first (@-style), fall back to forUsername.
      const handleVal = ref.value;
      const res = await this.fetch(`${YT_API}/channels?part=snippet&forHandle=${encodeURIComponent(handleVal)}&key=${this.apiKey}`);
      if (res.ok) {
        const data = (await res.json()) as { items?: YTChannel[] };
        if (data.items?.length) {
          const ch = data.items[0]!;
          return { platformId: ch.id, handle: ch.snippet.customUrl ?? ch.id, displayName: ch.snippet.title, avatarUrl: ch.snippet.thumbnails?.default?.url };
        }
      } else {
        // 429/403-quota MUST short-circuit — we don't want the next forUsername
        // call to immediately fail too, burning more quota / hitting the same limit.
        await checkResponse('youtube', res, `forHandle=${handleVal}`);
        // Other non-ok responses (404, 400) are fine to fall through and try forUsername.
      }

      const username = handleVal.replace(/^@/, '');
      const res2 = await this.fetch(`${YT_API}/channels?part=snippet&forUsername=${encodeURIComponent(username)}&key=${this.apiKey}`);
      if (res2.ok) {
        const data2 = (await res2.json()) as { items?: YTChannel[] };
        if (data2.items?.length) {
          const ch = data2.items[0]!;
          return { platformId: ch.id, handle: ch.snippet.customUrl ?? ch.id, displayName: ch.snippet.title, avatarUrl: ch.snippet.thumbnails?.default?.url };
        }
      } else {
        await checkResponse('youtube', res2, `forUsername=${username}`);
      }

      // Last resort: channel search (100 quota units vs 1). This is the path
      // most likely to push us over quota — handle the rate-limit cleanly.
      try {
        const res3 = await this.fetch(`${YT_API}/search?part=snippet&type=channel&q=${encodeURIComponent(username)}&maxResults=1&key=${this.apiKey}`);
        if (res3.ok) {
          const data3 = (await res3.json()) as { items?: Array<{ id: { channelId?: string }; snippet: { title: string; thumbnails?: { default?: { url: string } } } }> };
          const ch3 = data3.items?.[0];
          if (ch3?.id.channelId) {
            return { platformId: ch3.id.channelId, handle: username, displayName: ch3.snippet.title, avatarUrl: ch3.snippet.thumbnails?.default?.url };
          }
        } else {
          await checkResponse('youtube', res3, `search q=${username}`);
        }
      } catch (e) {
        // Don't swallow rate-limit signals — re-throw so the poll loop knows.
        if (e instanceof RateLimitError) throw e;
      }

      throw new Error(`YouTube channel not found: ${handleOrUrl}`);
    });
  }

  async listAuthorPosts(input: ListAuthorPostsInput): Promise<ListAuthorPostsResult> {
    return withAdapterLog(this.logger, { platform: 'youtube', operation: 'listAuthorPosts', handle: input.account.handle }, async () => {
      // The YouTube search API requires a real channel ID (UC...), not a vanity
      // handle.  Seeded roster entries store the handle string as platformId,
      // so resolve it on-the-fly when it doesn't look like a channel ID.
      let channelId = input.account.platformId;
      if (!channelId.startsWith('UC')) {
        try {
          const resolved = await this.resolveAccount(input.account.handle || channelId);
          channelId = resolved.platformId;
        } catch (e) {
          throw new Error(`Cannot resolve YouTube channel for ${input.account.handle || channelId}: ${e instanceof Error ? e.message : String(e)}`);
        }
        // If resolution still didn't produce a UC-style ID, bail with a clear message.
        if (!channelId.startsWith('UC')) {
          throw new Error(`YouTube resolved channel ID "${channelId}" for ${input.account.handle} is not a valid UC channel ID`);
        }
      }

      const maxResults = Math.min(input.maxPosts ?? 25, 50);
      const params = new URLSearchParams({
        part: 'snippet',
        channelId,
        order: 'date',
        type: 'video',
        maxResults: String(maxResults),
        key: this.apiKey,
      });
      if (input.cursor) params.set('pageToken', input.cursor);

      const res = await this.fetch(`${YT_API}/search?${params}`);
      if (!res.ok) {
        // Rate-limit / quota → RateLimitError so the poll loop short-circuits.
        const body = await checkResponse('youtube', res, `search channelId=${channelId}`);
        throw new Error(`YouTube search failed (${res.status}) for channelId=${channelId} — ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        items?: YTSearchItem[];
        nextPageToken?: string;
      };

      const posts: IngestedPost[] = [];
      for (const item of data.items ?? []) {
        if (!item.id.videoId) continue;

        const ingested: IngestedPost = {
          platform: 'youtube',
          platformPostId: item.id.videoId,
          authorHandle: input.account.handle,
          authorPlatformId: input.account.platformId,
          postedAt: item.snippet.publishedAt,
          url: videoUrl(item.id.videoId),
          bodyText: `${item.snippet.title}\n\n${item.snippet.description}`,
          mediaRefs: item.snippet.thumbnails?.high?.url
            ? [{ kind: 'video' as const, url: videoUrl(item.id.videoId), alt: item.snippet.title }]
            : [],
          rawPayload: item,
        };

        if (input.sinceId && ingested.platformPostId === input.sinceId) break;
        posts.push(ingested);
      }

      return { posts, nextCursor: data.nextPageToken };
    });
  }

  async fetchPostByUrl(url: string): Promise<IngestedPost> {
    return withAdapterLog(this.logger, { platform: 'youtube', operation: 'fetchPostByUrl', url }, async () => {
      const videoId = parseVideoId(url);
      if (!videoId) throw new PostNotFoundError(url);

      const params = `part=snippet&id=${videoId}&key=${this.apiKey}`;
      const res = await this.fetch(`${YT_API}/videos?${params}`);
      if (!res.ok) throw new PostNotFoundError(url);

      const data = (await res.json()) as { items?: YTVideoItem[] };
      if (!data.items?.length) throw new PostNotFoundError(url);

      const v = data.items[0]!;
      return {
        platform: 'youtube',
        platformPostId: v.id,
        authorHandle: v.snippet.channelTitle,
        authorPlatformId: v.snippet.channelId,
        postedAt: v.snippet.publishedAt,
        url: videoUrl(v.id),
        bodyText: `${v.snippet.title}\n\n${v.snippet.description}`,
        mediaRefs: [{ kind: 'video', url: videoUrl(v.id), alt: v.snippet.title }],
        rawPayload: v,
        language: v.snippet.defaultAudioLanguage,
      };
    });
  }
}
