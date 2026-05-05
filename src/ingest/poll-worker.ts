/**
 * Poll worker — the cron-triggered ingest loop.
 *
 * For each active handle in the roster for a given platform:
 *   1. Pull new posts via the adapter (since last seen ID).
 *   2. Run keyword matcher on each post.
 *   3. Enqueue into social_post_queue (dedup on platform+postId).
 *   4. Update the handle's poll state.
 *
 * Pure orchestrator — all I/O is injected. Testable without D1 or network.
 *
 * Traces: FR-59.
 */
import type { SocialAdapter, IngestedPost, PlatformSlug } from './types';
import type { KeywordWatch } from './keyword-matcher';
import { matchKeywords } from './keyword-matcher';

export interface PollDeps {
  adapter: SocialAdapter;
  /** Active handles for this platform. */
  handles: PollHandle[];
  /** Active keyword watches. */
  keywords: KeywordWatch[];
  /** Enqueue a post. Returns null if already exists (dedup). */
  enqueue: (input: EnqueueInput) => Promise<{ id: string } | null>;
  /** Update poll state on a handle after processing. */
  updatePollState: (handleId: string, polledAt: string, lastSeenPostId: string | null) => Promise<void>;
  /** Optional: fire a notification for keyword-matched posts. */
  notify?: (post: IngestedPost, matchedKeywords: string[]) => Promise<void>;
}

export interface PollHandle {
  id: string;
  bioguideId: string | null;
  platformId: string;
  handle: string;
  displayName: string;
  lastSeenPostId: string | null;
}

export interface EnqueueInput {
  bioguideId: string | null;
  platform: PlatformSlug;
  platformPostId: string;
  authorHandle: string;
  postedAt: string;
  url: string;
  bodyText: string;
  mediaRefsJson: string;
  rawPayloadJson: string;
  matchedKeywords?: string[];
}

export interface PollResult {
  platform: PlatformSlug;
  handlesPolled: number;
  newPosts: number;
  duplicates: number;
  keywordMatches: number;
  errors: Array<{ handle: string; error: string }>;
}

export async function pollPlatform(deps: PollDeps): Promise<PollResult> {
  const result: PollResult = {
    platform: deps.adapter.platform,
    handlesPolled: 0,
    newPosts: 0,
    duplicates: 0,
    keywordMatches: 0,
    errors: [],
  };

  const now = new Date().toISOString();

  for (const h of deps.handles) {
    result.handlesPolled++;
    try {
      const account = {
        platformId: h.platformId,
        handle: h.handle,
        displayName: h.displayName,
      };

      const feed = await deps.adapter.listAuthorPosts({
        account,
        sinceId: h.lastSeenPostId ?? undefined,
        maxPosts: 100,
      });

      let newestPostId: string | null = h.lastSeenPostId;
      let newestPostedAt: string | null = null;

      for (const post of feed.posts) {
        // Track the newest post for cursor state (compare timestamps).
        if (!newestPostedAt || post.postedAt > newestPostedAt) {
          newestPostedAt = post.postedAt;
          newestPostId = post.platformPostId;
        }

        // Keyword matching.
        const matched = matchKeywords(post.bodyText, deps.keywords);

        const enqueued = await deps.enqueue({
          bioguideId: h.bioguideId,
          platform: deps.adapter.platform,
          platformPostId: post.platformPostId,
          authorHandle: post.authorHandle,
          postedAt: post.postedAt,
          url: post.url,
          bodyText: post.bodyText,
          mediaRefsJson: JSON.stringify(post.mediaRefs),
          rawPayloadJson: JSON.stringify(post.rawPayload),
          matchedKeywords: matched.length ? matched : undefined,
        });

        if (enqueued) {
          result.newPosts++;
          if (matched.length) {
            result.keywordMatches++;
            if (deps.notify) {
              await deps.notify(post, matched);
            }
          }
        } else {
          result.duplicates++;
        }
      }

      await deps.updatePollState(h.id, now, newestPostId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push({ handle: h.handle, error: msg });
    }
  }

  return result;
}
