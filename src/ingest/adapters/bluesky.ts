/**
 * Bluesky adapter — AT Protocol public AppView.
 *
 * No auth, no API key, no cost. Public posts are readable via the AppView
 * at `api.bsky.app` without any credential.
 *
 * Rate limits: ~3,000 requests / 5 min per IP. We're polite (cron every
 * 30 min across ~120 accounts ≈ ~250 calls/cycle).
 *
 * Traces: FR-59 (social ingest — Bluesky connector).
 */
import type {
  SocialAdapter,
  IngestedPost,
  ResolvedAccount,
  ListAuthorPostsInput,
  ListAuthorPostsResult,
  MediaRef,
} from '../types';
import { PostNotFoundError } from '../types';
import { checkResponse } from '../http-status';
import type { AdapterLogger } from '../adapter-logger';
import { withAdapterLog } from '../adapter-logger';

const APPVIEW = 'https://public.api.bsky.app';

/* ---------- AT Protocol response shapes (subset we use) ---------- */

interface BskyProfile {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
}

interface BskyImage {
  alt?: string;
  fullsize?: string;
  thumb?: string;
}

interface BskyExternal {
  uri?: string;
  title?: string;
  description?: string;
}

interface BskyEmbed {
  $type?: string;
  images?: BskyImage[];
  external?: BskyExternal;
  media?: BskyEmbed; // for recordWithMedia
}

interface BskyRecord {
  text?: string;
  createdAt?: string;
  langs?: string[];
}

interface BskyPost {
  uri: string; // at://did:plc:xxx/app.bsky.feed.post/rkey
  cid: string;
  author: BskyProfile;
  record: BskyRecord;
  embed?: BskyEmbed;
  indexedAt?: string;
}

interface BskyFeedItem {
  post: BskyPost;
  reason?: { $type?: string }; // repost reason — skip these
}

interface AuthorFeedResponse {
  feed: BskyFeedItem[];
  cursor?: string;
}

interface PostThreadResponse {
  thread: {
    $type: string;
    post: BskyPost;
  };
}

/* ---------- Helpers ---------- */

/** Extract the rkey from an AT URI (`at://did/collection/rkey`). */
function rkeyFromUri(atUri: string): string {
  const parts = atUri.split('/');
  return parts[parts.length - 1]!;
}

/** Build a canonical web URL from an AT URI or profile+rkey. */
function webUrl(handle: string, rkey: string): string {
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

/** Parse a `bsky.app/profile/…/post/…` URL into (handle, rkey). */
function parseWebUrl(url: string): { handle: string; rkey: string } | null {
  const m = url.match(
    /bsky\.app\/profile\/([^/]+)\/post\/([a-z0-9]+)/i,
  );
  if (!m) return null;
  return { handle: m[1]!, rkey: m[2]! };
}

function extractMediaRefs(embed?: BskyEmbed): MediaRef[] {
  if (!embed) return [];
  const refs: MediaRef[] = [];

  // images
  if (embed.images) {
    for (const img of embed.images) {
      if (img.fullsize || img.thumb) {
        refs.push({
          kind: 'image',
          url: img.fullsize ?? img.thumb!,
          alt: img.alt,
        });
      }
    }
  }

  // external link card
  if (embed.external?.uri) {
    refs.push({ kind: 'link', url: embed.external.uri });
  }

  // recordWithMedia — recurse into the media sub-embed
  if (embed.media) {
    refs.push(...extractMediaRefs(embed.media));
  }

  return refs;
}

function postToIngested(post: BskyPost): IngestedPost {
  const rkey = rkeyFromUri(post.uri);
  return {
    platform: 'bluesky',
    platformPostId: post.uri,
    authorHandle: post.author.handle,
    authorPlatformId: post.author.did,
    postedAt: post.record.createdAt ?? post.indexedAt ?? new Date().toISOString(),
    url: webUrl(post.author.handle, rkey),
    bodyText: post.record.text ?? '',
    mediaRefs: extractMediaRefs(post.embed),
    rawPayload: post,
    language: post.record.langs?.[0],
  };
}

/* ---------- Adapter ---------- */

/**
 * Optional fetcher injection for testing (avoids globalThis.fetch mocks in
 * unit tests).
 */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export class BlueskyAdapter implements SocialAdapter {
  readonly platform = 'bluesky' as const;
  private fetch: Fetcher;
  private logger?: AdapterLogger;

  constructor(fetcher?: Fetcher, logger?: AdapterLogger) {
    this.fetch = fetcher ?? globalThis.fetch.bind(globalThis);
    this.logger = logger;
  }

  /** Attach or replace the logger after construction. */
  setLogger(logger: AdapterLogger): void {
    this.logger = logger;
  }

  matchesUrl(url: string): boolean {
    return /bsky\.(app|social)\/profile\/[^/]+\/post\/[a-z0-9]+/i.test(url);
  }

  async resolveAccount(handleOrUrl: string): Promise<ResolvedAccount> {
    return withAdapterLog(this.logger, { platform: 'bluesky', operation: 'resolveAccount', handle: handleOrUrl }, async () => {
      // Accept both raw handles and at:// URIs / web URLs.
      let handle = handleOrUrl.replace(/^@/, '');
      const webParsed = parseWebUrl(handleOrUrl);
      if (webParsed) handle = webParsed.handle;

      const res = await this.fetch(
        `${APPVIEW}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`,
      );
      if (!res.ok) {
        const body = await checkResponse('bluesky', res, `profile ${handle}`);
        throw new Error(`Bluesky profile lookup failed (${res.status}): ${body.slice(0, 200)}`);
      }
      const p = (await res.json()) as BskyProfile;
      return {
        platformId: p.did,
        handle: p.handle,
        displayName: p.displayName ?? p.handle,
        avatarUrl: p.avatar,
      };
    });
  }

  async listAuthorPosts(input: ListAuthorPostsInput): Promise<ListAuthorPostsResult> {
    return withAdapterLog(this.logger, { platform: 'bluesky', operation: 'listAuthorPosts', handle: input.account.handle }, async () => {
      const params = new URLSearchParams({
        actor: input.account.platformId,
        limit: String(Math.min(input.maxPosts ?? 50, 100)),
        filter: 'posts_no_replies',
      });
      if (input.cursor) params.set('cursor', input.cursor);

      const res = await this.fetch(
        `${APPVIEW}/xrpc/app.bsky.feed.getAuthorFeed?${params}`,
      );
      if (!res.ok) {
        const body = await checkResponse('bluesky', res, `feed ${input.account.handle}`);
        throw new Error(`Bluesky getAuthorFeed failed (${res.status}): ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as AuthorFeedResponse;

      const posts: IngestedPost[] = [];
      for (const item of data.feed) {
        // Skip reposts — we only want original posts.
        if (item.reason?.$type === 'app.bsky.feed.defs#reasonRepost') continue;

        const ingested = postToIngested(item.post);

        // sinceId stop — if we've seen this post before, halt.
        if (input.sinceId && ingested.platformPostId === input.sinceId) break;

        posts.push(ingested);
      }

      return {
        posts,
        nextCursor: data.cursor,
      };
    });
  }

  async fetchPostByUrl(url: string): Promise<IngestedPost> {
    return withAdapterLog(this.logger, { platform: 'bluesky', operation: 'fetchPostByUrl', url }, async () => {
      const parsed = parseWebUrl(url);
      if (!parsed) throw new PostNotFoundError(url);

      // Resolve handle to DID first (needed for the AT URI).
      const profile = await this.resolveAccount(parsed.handle);
      const atUri = `at://${profile.platformId}/app.bsky.feed.post/${parsed.rkey}`;

      const res = await this.fetch(
        `${APPVIEW}/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(atUri)}&depth=0`,
      );
      if (!res.ok) throw new PostNotFoundError(url);

      const data = (await res.json()) as PostThreadResponse;
      if (!data.thread?.post) throw new PostNotFoundError(url);

      return postToIngested(data.thread.post);
    });
  }
}
