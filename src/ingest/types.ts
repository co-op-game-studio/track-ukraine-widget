/**
 * Social-ingest domain types — platform-agnostic contract.
 *
 * Every adapter returns `IngestedPost`; every consumer reads only this shape.
 * The factory picks adapters by `PlatformSlug`; URL-routing sniffs via
 * `matchesUrl`.
 *
 * Traces: FR-59 (social ingest infrastructure).
 */

export type PlatformSlug =
  | 'bluesky'
  | 'youtube'
  | 'mastodon'
  | 'twitter';

export const ALL_PLATFORMS: readonly PlatformSlug[] = [
  'bluesky',
  'youtube',
  'mastodon',
  'twitter',
] as const;

export interface MediaRef {
  kind: 'image' | 'video' | 'audio' | 'link';
  url: string;
  alt?: string;
}

/**
 * Platform-agnostic post record. Adapters produce this; everything downstream
 * (queue, dedup, scoring, widget) consumes only this.
 */
export interface IngestedPost {
  platform: PlatformSlug;
  platformPostId: string;
  authorHandle: string;
  authorPlatformId: string;
  postedAt: string; // ISO 8601 UTC
  url: string;
  bodyText: string;
  mediaRefs: MediaRef[];
  rawPayload: unknown;
  language?: string;
}

export interface ResolvedAccount {
  platformId: string;
  handle: string;
  displayName: string;
  avatarUrl?: string;
}

export interface ListAuthorPostsInput {
  account: ResolvedAccount;
  sinceId?: string;
  cursor?: string;
  maxPosts?: number;
}

export interface ListAuthorPostsResult {
  posts: IngestedPost[];
  nextCursor?: string;
}

/**
 * Every platform adapter implements this interface.
 */
export interface SocialAdapter {
  readonly platform: PlatformSlug;

  /** Resolve a handle / URL fragment to a stable account ID. */
  resolveAccount(handleOrUrl: string): Promise<ResolvedAccount>;

  /** Pull recent posts for an account. */
  listAuthorPosts(input: ListAuthorPostsInput): Promise<ListAuthorPostsResult>;

  /** Fetch a single post by its canonical URL. */
  fetchPostByUrl(url: string): Promise<IngestedPost>;

  /** Does this URL look like it belongs to this platform? */
  matchesUrl(url: string): boolean;

  /**
   * Optional liveness check. Adapters that require auth should implement
   * a tiny no-op call to verify the token works (Twitter `/2/users/me`,
   * Meta `/me?fields=id`, YouTube `/channels?part=id&id=UC_x5XG1OV2P6uZZ5FSM9Ttw`).
   * Returns nothing on success; throws on failure (any error — bad token,
   * rate-limit, network).
   *
   * Free / no-auth adapters (Bluesky, Mastodon) can omit this; the platform
   * registry treats absence as "always available."
   */
  healthCheck?(): Promise<void>;
}

/* ----- Errors ----- */

export class PostNotFoundError extends Error {
  constructor(url: string) {
    super(`Post not found or inaccessible: ${url}`);
    this.name = 'PostNotFoundError';
  }
}

export class UnknownPlatformError extends Error {
  constructor(platform: string) {
    super(`No adapter registered for platform: ${platform}`);
    this.name = 'UnknownPlatformError';
  }
}

export class UnsupportedUrlError extends Error {
  constructor(url: string) {
    super(`No adapter recognises URL: ${url}`);
    this.name = 'UnsupportedUrlError';
  }
}

/**
 * Thrown by adapters when the upstream API rejects us for rate-limit reasons.
 *
 * Two shapes, with different recovery strategies:
 *
 *   - `kind: 'transient'` — short backoff window, resume after retryAfterSec.
 *     Bluesky, Mastodon, and most Twitter 429s. The poll UI pauses the platform
 *     for the window and resumes automatically (or on next manual click).
 *
 *   - `kind: 'quota'` — daily/monthly cap exhausted. No amount of waiting in
 *     the current run will help; the platform is dead until the cap resets.
 *     YouTube daily quota (resets midnight Pacific) and Twitter monthly cap
 *     (resets first of month) both fall here.
 *
 * Operators can lift quota caps with money: YouTube via "extended quota"
 * application in Google Cloud Console (free, ~7 day approval); Twitter via
 * paid tier subscription. Bluesky/Mastodon are not paywalled.
 */
export type RateLimitKind = 'transient' | 'quota';

export class RateLimitError extends Error {
  readonly platform: PlatformSlug;
  readonly status: number;
  readonly retryAfterSec: number | null;
  readonly kind: RateLimitKind;
  constructor(
    platform: PlatformSlug,
    status: number,
    message: string,
    retryAfterSec: number | null = null,
    kind: RateLimitKind = 'transient',
  ) {
    super(`${platform} rate-limited (${status}, ${kind}): ${message}`);
    this.name = 'RateLimitError';
    this.platform = platform;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
    this.kind = kind;
  }
}

/** True when an error should be treated as a rate-limit (vs a real failure
 *  worth logging + retrying immediately). Adapters throw RateLimitError
 *  directly; this helper handles raw errors that bubbled past the wrapper. */
export function isRateLimit(e: unknown): e is RateLimitError {
  return e instanceof RateLimitError;
}
