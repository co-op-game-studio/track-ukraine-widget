/**
 * Twitter (X) adapter — API v2.
 *
 * Requires a Bearer token (TWITTER_BEARER_TOKEN env var, registered conditionally
 * at worker boot just like YouTube). Without the token, the adapter is not
 * registered and Twitter handles will report "no_adapter" via the platform check.
 *
 * Endpoints used:
 *   - GET /2/users/by/username/{handle}      → resolve handle → user ID
 *   - GET /2/users/{id}/tweets               → list author timeline (most-recent
 *                                              first, paginated)
 *   - GET /2/tweets/{id}                     → single tweet by ID for direct-add
 *
 * Rate limits (Free / Basic tiers): 1 user lookup per 15 min/user; 1500 tweet
 * pulls per month (Free), 10k/month (Basic). Operators must size the cron + the
 * staleness window to fit. The poll worker's per-handle cursor (`sinceId`) keeps
 * actual fetches tiny once a handle is warmed up.
 *
 * Traces: FR-59 (social ingest — Twitter/X connector).
 */
import type {
  SocialAdapter,
  IngestedPost,
  ResolvedAccount,
  ListAuthorPostsInput,
  ListAuthorPostsResult,
} from '../types';
import { PostNotFoundError } from '../types';
import { checkResponse } from '../http-status';
import type { AdapterLogger } from '../adapter-logger';
import { withAdapterLog } from '../adapter-logger';

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const X_API = 'https://api.twitter.com/2';

interface XUser {
  id: string;
  username: string;
  name: string;
  profile_image_url?: string;
}

interface XTweet {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  attachments?: { media_keys?: string[] };
  referenced_tweets?: Array<{ type: 'retweeted' | 'quoted' | 'replied_to'; id: string }>;
  lang?: string;
}

interface XMedia {
  media_key: string;
  type: 'photo' | 'video' | 'animated_gif';
  url?: string;       // photo only
  preview_image_url?: string; // video / gif
  alt_text?: string;
}

interface XTweetsResponse {
  data?: XTweet[];
  includes?: { media?: XMedia[]; users?: XUser[] };
  meta?: { next_token?: string };
}

interface XSingleTweetResponse {
  data?: XTweet;
  includes?: { media?: XMedia[]; users?: XUser[] };
}

/** Strip the leading @ from a handle if present. */
function stripAt(s: string): string {
  return s.replace(/^@+/, '');
}

/** Parse a tweet URL → tweet ID. */
function parseTweetUrl(url: string): { tweetId: string } | null {
  const m = url.match(/^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[^/]+\/status\/(\d+)/i);
  if (!m) return null;
  return { tweetId: m[1]! };
}

export class TwitterAdapter implements SocialAdapter {
  readonly platform = 'twitter' as const;
  private bearerToken: string;
  private fetch: Fetcher;
  private logger?: AdapterLogger;

  constructor(bearerToken: string, fetcher?: Fetcher, logger?: AdapterLogger) {
    this.bearerToken = bearerToken;
    this.fetch = fetcher ?? globalThis.fetch.bind(globalThis);
    this.logger = logger;
  }

  setLogger(logger: AdapterLogger): void {
    this.logger = logger;
  }

  matchesUrl(url: string): boolean {
    return /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[^/]+\/status\/\d+/i.test(url);
  }

  /** Cheapest authenticated call: lookup the public @twitter user (1 read).
   *  Verifies the bearer token actually works against the live API. */
  async healthCheck(): Promise<void> {
    const res = await this.fetch(`${X_API}/users/by/username/twitter?user.fields=id`, { headers: this.headers() });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`twitter health check failed (${res.status}): ${body.slice(0, 200)}`);
    }
  }

  private headers(): HeadersInit {
    return { Authorization: `Bearer ${this.bearerToken}` };
  }

  async resolveAccount(handleOrUrl: string): Promise<ResolvedAccount> {
    return withAdapterLog(this.logger, { platform: 'twitter', operation: 'resolveAccount', handle: handleOrUrl }, async () => {
      const username = stripAt(handleOrUrl.trim());
      if (!username) throw new Error(`empty Twitter handle`);
      const url = `${X_API}/users/by/username/${encodeURIComponent(username)}?user.fields=profile_image_url`;
      const res = await this.fetch(url, { headers: this.headers() });
      if (!res.ok) {
        // Throws RateLimitError on 429/403-quota; otherwise returns body for context.
        const body = await checkResponse('twitter', res, `user lookup ${username}`);
        throw new Error(`Twitter user lookup failed (${res.status}): ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as { data?: XUser };
      if (!data.data) throw new Error(`Twitter handle not found: @${username}`);
      return {
        platformId: data.data.id,
        handle: `@${data.data.username}`,
        displayName: data.data.name || data.data.username,
        avatarUrl: data.data.profile_image_url,
      };
    });
  }

  async listAuthorPosts(input: ListAuthorPostsInput): Promise<ListAuthorPostsResult> {
    return withAdapterLog(this.logger, { platform: 'twitter', operation: 'listAuthorPosts', handle: input.account.handle }, async () => {
      const userId = input.account.platformId;
      const maxResults = Math.min(input.maxPosts ?? 25, 100); // X API allows 5-100.
      const params = new URLSearchParams({
        max_results: String(Math.max(5, maxResults)),
        'tweet.fields': 'created_at,attachments,referenced_tweets,lang',
        'media.fields': 'url,preview_image_url,type,alt_text',
        expansions: 'attachments.media_keys',
        exclude: 'replies,retweets',
      });
      if (input.cursor) params.set('pagination_token', input.cursor);
      if (input.sinceId) params.set('since_id', input.sinceId);

      const url = `${X_API}/users/${encodeURIComponent(userId)}/tweets?${params}`;
      const res = await this.fetch(url, { headers: this.headers() });
      if (!res.ok) {
        const body = await checkResponse('twitter', res, `timeline ${input.account.handle}`);
        throw new Error(`Twitter timeline failed (${res.status}): ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as XTweetsResponse;
      const mediaByKey = new Map<string, XMedia>();
      for (const m of data.includes?.media ?? []) mediaByKey.set(m.media_key, m);

      const posts: IngestedPost[] = [];
      for (const t of data.data ?? []) {
        const mediaRefs = (t.attachments?.media_keys ?? [])
          .map((k) => mediaByKey.get(k))
          .filter((m): m is XMedia => Boolean(m))
          .map((m) => ({
            kind: (m.type === 'photo' ? 'image' : 'video') as 'image' | 'video',
            url: m.url ?? m.preview_image_url ?? '',
            alt: m.alt_text ?? undefined,
          }));

        const post: IngestedPost = {
          platform: 'twitter',
          platformPostId: t.id,
          authorHandle: input.account.handle,
          authorPlatformId: userId,
          postedAt: t.created_at ?? new Date().toISOString(),
          url: `https://twitter.com/${stripAt(input.account.handle)}/status/${t.id}`,
          bodyText: t.text,
          mediaRefs,
          rawPayload: t,
          language: t.lang ?? undefined,
        };
        posts.push(post);
      }

      return { posts, nextCursor: data.meta?.next_token };
    });
  }

  async fetchPostByUrl(url: string): Promise<IngestedPost> {
    return withAdapterLog(this.logger, { platform: 'twitter', operation: 'fetchPostByUrl', url }, async () => {
      const parsed = parseTweetUrl(url);
      if (!parsed) throw new PostNotFoundError(url);
      const params = new URLSearchParams({
        'tweet.fields': 'created_at,attachments,referenced_tweets,lang,author_id',
        'media.fields': 'url,preview_image_url,type,alt_text',
        'user.fields': 'username,name',
        expansions: 'attachments.media_keys,author_id',
      });
      const apiUrl = `${X_API}/tweets/${parsed.tweetId}?${params}`;
      const res = await this.fetch(apiUrl, { headers: this.headers() });
      if (!res.ok) throw new PostNotFoundError(url);
      const data = (await res.json()) as XSingleTweetResponse;
      if (!data.data) throw new PostNotFoundError(url);
      const t = data.data;
      const author = data.includes?.users?.[0];
      const mediaByKey = new Map<string, XMedia>();
      for (const m of data.includes?.media ?? []) mediaByKey.set(m.media_key, m);
      const mediaRefs = (t.attachments?.media_keys ?? [])
        .map((k) => mediaByKey.get(k))
        .filter((m): m is XMedia => Boolean(m))
        .map((m) => ({
          kind: (m.type === 'photo' ? 'image' : 'video') as 'image' | 'video',
          url: m.url ?? m.preview_image_url ?? '',
          alt: m.alt_text ?? undefined,
        }));

      return {
        platform: 'twitter',
        platformPostId: t.id,
        authorHandle: author ? `@${author.username}` : '',
        authorPlatformId: t.author_id ?? author?.id ?? '',
        postedAt: t.created_at ?? new Date().toISOString(),
        url: author ? `https://twitter.com/${author.username}/status/${t.id}` : url,
        bodyText: t.text,
        mediaRefs,
        rawPayload: t,
        language: t.lang ?? undefined,
      };
    });
  }
}
