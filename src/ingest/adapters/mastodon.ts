/**
 * Mastodon adapter — public REST API.
 *
 * Fully free, no auth required for public timelines. Each Mastodon
 * account lives on a specific instance (e.g. mastodon.social) which
 * must be part of the handle.
 *
 * Traces: FR-59 (social ingest — Mastodon connector).
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

/* ---------- Mastodon API response shapes ---------- */

interface MastoAccount {
  id: string;
  acct: string;
  username: string;
  display_name: string;
  avatar: string;
  url: string;
}

interface MastoStatus {
  id: string;
  created_at: string;
  content: string; // HTML
  url: string | null;
  reblog: MastoStatus | null;
  account: MastoAccount;
  language: string | null;
  media_attachments: Array<{
    type: string; // 'image' | 'video' | 'gifv' | 'audio'
    url: string;
    description: string | null;
  }>;
}

/* ---------- Helpers ---------- */

/** Strip HTML tags to get plain text. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** Parse a Mastodon handle like @user@instance.social → { username, instance }. */
function parseHandle(input: string): { username: string; instance: string } | null {
  // https://instance.social/@user  (check URL format first — the handle regex
  // would false-positive on URLs because the path contains an @)
  const urlM = input.match(/https?:\/\/([^/]+)\/@([^/]+)/);
  if (urlM) return { username: urlM[2]!, instance: urlM[1]! };
  // @user@instance.social
  const m = input.match(/^@?([^@]+)@([^@/]+)$/);
  if (m) return { username: m[1]!, instance: m[2]! };
  return null;
}

/** Parse a Mastodon status URL → { instance, statusId }. */
function parseStatusUrl(url: string): { instance: string; statusId: string } | null {
  // https://mastodon.social/@user/123456789
  // https://mastodon.social/@user@other.instance/123456789
  const m = url.match(/https?:\/\/([^/]+)\/@[^/]+\/(\d+)/);
  if (m) return { instance: m[1]!, statusId: m[2]! };
  return null;
}

/* ---------- Adapter ---------- */

export class MastodonAdapter implements SocialAdapter {
  readonly platform = 'mastodon' as const;
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
    // Mastodon status URLs: https://instance/@user/123456
    return /https?:\/\/[^/]+\/@[^/]+\/\d+/.test(url);
  }

  async resolveAccount(handleOrUrl: string): Promise<ResolvedAccount> {
    return withAdapterLog(this.logger, { platform: 'mastodon', operation: 'resolveAccount', handle: handleOrUrl }, async () => {
      const parsed = parseHandle(handleOrUrl);
      if (!parsed) throw new Error(`Cannot parse Mastodon handle: ${handleOrUrl}`);

      const lookupUrl = `https://${parsed.instance}/api/v1/accounts/lookup?acct=${encodeURIComponent(parsed.username)}`;
      const res = await this.fetch(lookupUrl);
      if (!res.ok) {
        const body = await checkResponse('mastodon', res, `account ${parsed.username}@${parsed.instance}`);
        throw new Error(`Mastodon account lookup failed (${res.status}): ${body.slice(0, 200)}`);
      }

      const acct = (await res.json()) as MastoAccount;
      return {
        platformId: acct.id,
        handle: `@${acct.acct}@${parsed.instance}`,
        displayName: acct.display_name || acct.username,
        avatarUrl: acct.avatar,
      };
    });
  }

  async listAuthorPosts(input: ListAuthorPostsInput): Promise<ListAuthorPostsResult> {
    return withAdapterLog(this.logger, { platform: 'mastodon', operation: 'listAuthorPosts', handle: input.account.handle }, async () => {
      // The handle should be in format @user@instance
      const parsed = parseHandle(input.account.handle);
      if (!parsed) {
        return { posts: [], nextCursor: undefined };
      }

      const maxResults = Math.min(input.maxPosts ?? 25, 40);
      const params = new URLSearchParams({
        limit: String(maxResults),
        exclude_replies: 'true',
        exclude_reblogs: 'true',
      });
      if (input.cursor) params.set('max_id', input.cursor);

      const timelineUrl = `https://${parsed.instance}/api/v1/accounts/${input.account.platformId}/statuses?${params}`;
      const res = await this.fetch(timelineUrl);
      if (!res.ok) {
        const body = await checkResponse('mastodon', res, `timeline ${input.account.handle}`);
        throw new Error(`Mastodon timeline failed (${res.status}): ${body.slice(0, 200)}`);
      }

      const statuses = (await res.json()) as MastoStatus[];
      const posts: IngestedPost[] = [];

      for (const s of statuses) {
        if (s.reblog) continue; // Skip boosts

        const post: IngestedPost = {
          platform: 'mastodon',
          platformPostId: s.id,
          authorHandle: input.account.handle,
          authorPlatformId: input.account.platformId,
          postedAt: s.created_at,
          url: s.url ?? `https://${parsed.instance}/@${parsed.username}/${s.id}`,
          bodyText: stripHtml(s.content),
          mediaRefs: s.media_attachments.map((a) => ({
            kind: (a.type === 'image' ? 'image' : 'video') as 'image' | 'video',
            url: a.url,
            alt: a.description ?? undefined,
          })),
          rawPayload: s,
          language: s.language ?? undefined,
        };

        if (input.sinceId && post.platformPostId === input.sinceId) break;
        posts.push(post);
      }

      // Mastodon uses max_id pagination — the cursor is the last status ID.
      const nextCursor = statuses.length >= maxResults
        ? statuses[statuses.length - 1]?.id
        : undefined;

      return { posts, nextCursor };
    });
  }

  async fetchPostByUrl(url: string): Promise<IngestedPost> {
    return withAdapterLog(this.logger, { platform: 'mastodon', operation: 'fetchPostByUrl', url }, async () => {
      const parsed = parseStatusUrl(url);
      if (!parsed) throw new PostNotFoundError(url);

      const statusUrl = `https://${parsed.instance}/api/v1/statuses/${parsed.statusId}`;
      const res = await this.fetch(statusUrl);
      if (!res.ok) throw new PostNotFoundError(url);

      const s = (await res.json()) as MastoStatus;
      return {
        platform: 'mastodon',
        platformPostId: s.id,
        authorHandle: `@${s.account.acct}@${parsed.instance}`,
        authorPlatformId: s.account.id,
        postedAt: s.created_at,
        url: s.url ?? url,
        bodyText: stripHtml(s.content),
        mediaRefs: s.media_attachments.map((a) => ({
          kind: (a.type === 'image' ? 'image' : 'video') as 'image' | 'video',
          url: a.url,
          alt: a.description ?? undefined,
        })),
        rawPayload: s,
        language: s.language ?? undefined,
      };
    });
  }
}
