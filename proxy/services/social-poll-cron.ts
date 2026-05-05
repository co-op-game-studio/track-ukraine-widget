/**
 * Social feed polling cron — polls all supported platforms for new posts.
 *
 * Runs hourly via the scheduled handler. For each registered adapter,
 * fetches all active handles and polls for new posts since the last
 * seen post ID. New posts are enqueued in social_post_queue and matched
 * against active keyword watches.
 *
 * Traces: FR-59 (social ingest infrastructure).
 */
import type { ProxyEnv } from '../env';
import * as ingestStore from '../d1/ingest-store';
import { getSocialPollStalenessMin } from './cron-interval';
import { listPlatforms, getAdapter } from '../../src/ingest/factory';
import { pollPlatform } from '../../src/ingest/poll-worker';
import type { PollResult } from '../../src/ingest/poll-worker';
import type { KeywordWatch } from '../../src/ingest/keyword-matcher';
import type { PlatformSlug } from '../../src/ingest/types';
// Ensure adapters are registered at import time.
import '../../src/ingest/register';
import { registerYouTube, registerTwitter } from '../../src/ingest/register';

let youtubeRegistered = false;
let twitterRegistered = false;

export interface SocialPollCronResult {
  platforms: PollResult[];
  totalHandles: number;
  totalNew: number;
  totalErrors: number;
}

/**
 * Poll all registered platforms for new social posts.
 * Called from the scheduled handler on every cron tick.
 */
export async function runSocialPollCron(env: ProxyEnv): Promise<SocialPollCronResult> {
  // D1 is optional in the env type because some preview/test envs lack it,
  // but the cron literally has nothing to do without the editable backend —
  // exit cleanly with a no-op result rather than crashing on every tick.
  if (!env.D1_VOTER_INFO) {
    return { platforms: [], totalHandles: 0, totalNew: 0, totalErrors: 0 };
  }
  const d1 = env.D1_VOTER_INFO;

  // Register YouTube adapter if API key is present.
  if (!youtubeRegistered && env.YOUTUBE_API_KEY) {
    registerYouTube(env.YOUTUBE_API_KEY);
    youtubeRegistered = true;
  }
  if (!twitterRegistered && env.TWITTER_BEARER_TOKEN) {
    registerTwitter(env.TWITTER_BEARER_TOKEN);
    twitterRegistered = true;
  }

  const platforms = listPlatforms();
  const keywords = await ingestStore.listKeywordWatches(d1, true);
  const kwList: KeywordWatch[] = keywords.map((k) => ({
    watchName: k.watch_name,
    pattern: k.pattern,
    isRegex: Boolean(k.is_regex),
  }));

  // Staleness derived from the cron schedule itself: skip handles polled
  // within (interval - safety_margin) so an in-flight prior cron or a manual
  // admin poll inside this cycle doesn't double-pull. Failures don't update
  // last_polled_at, so a failed handle naturally retries on the next tick.
  const minAgeMin = getSocialPollStalenessMin(env);
  const cutoffMs = minAgeMin > 0 ? Date.now() - minAgeMin * 60 * 1000 : Number.POSITIVE_INFINITY;

  const results: PollResult[] = [];
  let totalHandles = 0;
  let totalNew = 0;
  let totalErrors = 0;
  let totalSkipped = 0;

  for (const platform of platforms) {
    // YouTube is excluded from bulk polls — the default daily quota (10k units)
    // is too small to cover the full roster, and researchers can always re-poll
    // a single person from the profile "Re-poll" button. Twitter stays in bulk
    // (Basic tier monthly cap is large enough; per-handle `sinceId` cursoring
    // keeps fetches tiny once warmed up).
    //
    // TODO: turn this into a per-platform `bulk_eligible` setting in D1 so
    // operators can tune without a code change.
    if (platform === 'youtube') continue;

    try {
      const adapter = getAdapter(platform as PlatformSlug);
      const allHandles = await ingestStore.listHandles(d1, {
        platform: platform as PlatformSlug,
        activeOnly: true,
      });

      // Apply staleness gate: skip handles polled inside the cutoff window.
      const handles = allHandles.filter((h) => {
        if (!h.last_polled_at) return true; // Never polled — always include.
        const polledMs = Date.parse(h.last_polled_at);
        if (!Number.isFinite(polledMs)) return true;
        return polledMs <= cutoffMs;
      });
      totalSkipped += allHandles.length - handles.length;

      if (handles.length === 0) continue;

      // Cron uses a synthetic trace ID per platform-tick so a failed pull is
      // queryable in logs and surfaces on profile + Settings ▸ Poll Status.
      const cronTraceId = `cron-${platform}-${Date.now()}`;
      const handleByName = new Map(handles.map((h) => [h.handle, h]));

      const result = await pollPlatform({
        adapter,
        handles: handles.map((h) => ({
          id: h.id,
          bioguideId: h.bioguide_id,
          platformId: h.platform_id,
          handle: h.handle,
          displayName: h.display_name ?? h.handle,
          lastSeenPostId: h.last_seen_post_id,
        })),
        keywords: kwList,
        enqueue: async (input) => {
          const row = await ingestStore.enqueuePost(d1, input);
          return row ? { id: row.id } : null;
        },
        updatePollState: async (handleId, polledAt, lastSeenPostId) => {
          await ingestStore.updateHandlePollState(d1, handleId, polledAt, lastSeenPostId);
        },
      });

      // Persist failures so they outlive this cron invocation.
      for (const err of result.errors) {
        const h = handleByName.get(err.handle);
        if (h) {
          await ingestStore.recordHandlePollFailure(d1, h.id, err.error, cronTraceId);
        }
      }

      results.push(result);
      totalHandles += result.handlesPolled;
      totalNew += result.newPosts;
      totalErrors += result.errors.length;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        platform: platform as PlatformSlug,
        handlesPolled: 0,
        newPosts: 0,
        duplicates: 0,
        keywordMatches: 0,
        errors: [{ handle: '*', error: msg }],
      });
      totalErrors++;
    }
  }

  // eslint-disable-next-line no-console
  console.log('[social-poll-cron]', {
    platforms: platforms.length,
    totalHandles,
    totalNew,
    totalErrors,
    totalSkipped,
    minAgeMin,
  });

  return { platforms: results, totalHandles, totalNew, totalErrors };
}
