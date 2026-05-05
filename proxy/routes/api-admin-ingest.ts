/**
 * Admin ingest API — `/api/admin/ingest/*`
 *
 * Endpoints for the social ingest infrastructure:
 *   - /api/admin/ingest/handles      — CRUD MoC social handles
 *   - /api/admin/ingest/queue        — list/review queue
 *   - /api/admin/ingest/keywords     — CRUD keyword watches
 *   - /api/admin/ingest/poll         — trigger a manual poll
 *   - /api/admin/ingest/fetch-post   — fetch a single post by URL (direct-add)
 *   - /api/admin/ingest/search       — search by congressperson
 *   - /api/admin/ingest/seed         — force re-sync roster + Bluesky + keywords
 *
 * Traces: FR-59.
 */
import type { ProxyEnv } from '../env';
import type { DispatchResult } from './common';
import { jsonResponse } from './common';
import * as ingestStore from '../d1/ingest-store';
import { getSocialPollStalenessMin } from '../services/cron-interval';
import { getAdapter, adapterForUrl, listPlatforms, setAdapterLoggers } from '../../src/ingest/factory';
import { pollPlatform } from '../../src/ingest/poll-worker';
import { createAdapterLogger } from '../../src/ingest/adapter-logger';
import type { KeywordWatch } from '../../src/ingest/keyword-matcher';
import type { PlatformSlug } from '../../src/ingest/types';
import { ensureIngestSeeded, resolveYouTubeChannelIds } from '../services/ingest-seed';
import { KV_PREFIXES } from '../kv/prefixes';
import type { NameIndexEntry } from '../kv/name-index';
// Ensure adapters are registered.
import '../../src/ingest/register';
import { registerYouTube } from '../../src/ingest/register';

let youtubeRegistered = false;

/** Platforms that are safe to bulk-poll (cron + Inbox "Poll all"). YouTube
 *  is excluded because the daily quota is small; researchers re-poll YouTube
 *  per-person from the profile. Source of truth for both backend and UI. */
const BULK_ELIGIBLE: ReadonlySet<string> = new Set(['bluesky', 'mastodon']);

interface PlatformLiveness {
  slug: string;
  /** True when the adapter is registered AND its healthCheck (if any) passed. */
  available: boolean;
  /** Eligible for bulk polling (cron + Inbox "Poll all"). False = on-demand only. */
  bulkEligible: boolean;
  /** Error message from healthCheck when available=false. */
  error?: string;
  /** When the cached liveness result was computed. */
  checkedAt: string;
}

let platformsCache: { computedAt: number; result: PlatformLiveness[] } | null = null;
const PLATFORMS_CACHE_TTL_MS = 5 * 60 * 1000;

/** Run liveness checks across every registered adapter. Cached for 5 min so
 *  every page load doesn't fan out a real HTTP call to each provider. */
async function getPlatformsLiveness(forceRefresh: boolean): Promise<PlatformLiveness[]> {
  if (!forceRefresh && platformsCache && Date.now() - platformsCache.computedAt < PLATFORMS_CACHE_TTL_MS) {
    return platformsCache.result;
  }
  const slugs = listPlatforms();
  const checkedAt = new Date().toISOString();
  const results = await Promise.all(slugs.map(async (slug): Promise<PlatformLiveness> => {
    try {
      const adapter = getAdapter(slug as PlatformSlug);
      // Adapters without a healthCheck are assumed always-available (Bluesky, Mastodon).
      if (typeof adapter.healthCheck === 'function') {
        await adapter.healthCheck();
      }
      return { slug, available: true, bulkEligible: BULK_ELIGIBLE.has(slug), checkedAt };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { slug, available: false, bulkEligible: BULK_ELIGIBLE.has(slug), error, checkedAt };
    }
  }));
  platformsCache = { computedAt: Date.now(), result: results };
  return results;
}

/**
 * Self-protective validator for admin-supplied regex / keyword patterns.
 *
 * The poll loop runs the compiled pattern against every body of every polled
 * post; a catastrophic-backtracking pattern would exhaust the Worker CPU
 * budget on every cron tick and roll a poll outage forward indefinitely.
 *
 * Two gates:
 *   1. Length cap (200 chars) — rejects the obvious "let me paste my whole
 *      regex book" attempt and bounds the worst-case match cost.
 *   2. Compile-and-time-test against a 50-char "trigger" string. If the
 *      pattern hasn't returned in 50ms, treat as ReDoS-shaped and reject.
 *      The threshold is generous; legit patterns finish in microseconds.
 *
 * Returns `null` on accept, or an error string on reject.
 */
const MAX_PATTERN_LEN = 200;
const REDOS_PROBE_BUDGET_MS = 30;
// Multiple probe inputs — different shapes catch different backtracking
// patterns. `aaaa…b` triggers `(a+)+$`-style; `xxxx…` triggers
// alternation-with-overlap; `0123…` triggers character-class explosion.
// Any one taking >budget is grounds for rejection. Falls under the Worker
// CPU limit (10ms typical) so the CPU killer is the second line of defense.
const REDOS_PROBES: readonly string[] = [
  'a'.repeat(30) + 'b',
  'aaaaaaaaaaaaaaaaaaab',
  'x'.repeat(40),
  '0123456789'.repeat(4),
];

function validateRegexPattern(pattern: string, isRegex: boolean): string | null {
  if (!pattern || pattern.trim().length === 0) return 'pattern must not be empty';
  if (pattern.length > MAX_PATTERN_LEN) return `pattern exceeds ${MAX_PATTERN_LEN}-char cap`;
  if (!isRegex) return null; // plain strings can't backtrack
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch (e) {
    return `invalid regex: ${e instanceof Error ? e.message : String(e)}`;
  }
  // Time-bound preflight across several probe inputs. If a pathological
  // pattern takes >budget here, it'll take orders of magnitude longer
  // against a real post body. CF's 10ms Worker CPU limit also kills
  // anything truly catastrophic before this returns.
  for (const probe of REDOS_PROBES) {
    const started = Date.now();
    try { re.test(probe); } catch { /* exec errors don't gate */ }
    const elapsed = Date.now() - started;
    if (elapsed > REDOS_PROBE_BUDGET_MS) {
      return `pattern is too expensive (${elapsed}ms on a ${probe.length}-char probe — likely catastrophic backtracking)`;
    }
  }
  return null;
}

interface IngestCtx {
  email: string;
  traceId: string;
}

export async function handleIngest(
  subpath: string,
  request: Request,
  env: ProxyEnv,
  ctx: IngestCtx,
): Promise<DispatchResult> {
  // Register YouTube adapter on first call if key is present.
  if (!youtubeRegistered && env.YOUTUBE_API_KEY) {
    registerYouTube(env.YOUTUBE_API_KEY);
    youtubeRegistered = true;
  }

  // Wire structured logging into all adapters with per-request trace context.
  setAdapterLoggers(createAdapterLogger(env.ENV_NAME ?? 'prod', ctx.traceId));

  const d1 = env.D1_VOTER_INFO;
  if (!d1) {
    return {
      response: jsonResponse(503, { error: 'd1_unavailable', traceId: ctx.traceId }),
      shape: 'worker-emitted',
    };
  }

  const url = new URL(request.url);
  const [resource, id] = (subpath || '').split('/');

  // --- Handles CRUD ---
  if (resource === 'handles') {
    if (request.method === 'GET') {
      const items = await ingestStore.listHandles(d1, {
        bioguideId: url.searchParams.get('bioguideId') ?? undefined,
        platform: url.searchParams.get('platform') as PlatformSlug | undefined,
        activeOnly: url.searchParams.get('includeInactive') !== 'true',
      });
      return ok(ctx, { items });
    }
    if (request.method === 'POST') {
      const body = (await request.json()) as Record<string, unknown>;
      const row = await ingestStore.upsertHandle(d1, {
        bioguideId: (body['bioguide_id'] as string | undefined) ?? null,
        entityName: body['entity_name'] as string | undefined,
        accountCategory: body['account_category'] as string | undefined,
        platform: body['platform'] as string,
        accountKind: (body['account_kind'] as string) ?? 'official',
        handle: body['handle'] as string,
        platformId: body['platform_id'] as string,
        displayName: body['display_name'] as string | undefined,
        avatarUrl: body['avatar_url'] as string | undefined,
        source: body['source'] as string | undefined,
      });
      return { response: jsonResponse(201, { row }), shape: 'api-proxied' };
    }
    if (request.method === 'PATCH' && id) {
      const body = (await request.json()) as Record<string, unknown>;
      await ingestStore.updateHandle(d1, id, {
        handle: body['handle'] as string | undefined,
        platformId: body['platform_id'] as string | undefined,
        displayName: body['display_name'] as string | undefined,
        entityName: body['entity_name'] as string | undefined,
        accountCategory: body['account_category'] as string | undefined,
        platform: body['platform'] as string | undefined,
      });
      return ok(ctx, { updated: true });
    }
    if (request.method === 'DELETE' && id) {
      await ingestStore.deactivateHandle(d1, id);
      return ok(ctx, { deactivated: true });
    }
  }

  // --- Handle poll status ---
  // GET /api/admin/ingest/handle-status            → all handles + status (Settings ▸ Poll Status)
  // GET /api/admin/ingest/handle-status?bioguideId=X → just one person's handles (profile panel)
  // GET /api/admin/ingest/handle-status?status=error → filter to failures only
  if (resource === 'handle-status' && request.method === 'GET') {
    const items = await ingestStore.listHandles(d1, {
      bioguideId: url.searchParams.get('bioguideId') ?? undefined,
      activeOnly: true,
    });
    const filterStatus = url.searchParams.get('status');
    const filtered = filterStatus
      ? items.filter((h) => h.last_poll_status === filterStatus)
      : items;
    const out = filtered.map((h) => ({
      handle_id: h.id,
      platform: h.platform,
      handle: h.handle,
      display_name: h.display_name,
      bioguide_id: h.bioguide_id,
      last_polled_at: h.last_polled_at,
      last_poll_attempted_at: h.last_poll_attempted_at,
      last_poll_status: h.last_poll_status,
      last_poll_error: h.last_poll_error,
      last_poll_trace_id: h.last_poll_trace_id,
    }));
    return ok(ctx, { items: out });
  }

  // --- Queue ---
  if (resource === 'queue') {
    if (request.method === 'GET') {
      const result = await ingestStore.listQueue(d1, {
        status: url.searchParams.get('status') ?? undefined,
        platform: url.searchParams.get('platform') ?? undefined,
        bioguideId: url.searchParams.get('bioguideId') ?? undefined,
        keywordMatch: url.searchParams.get('keywordMatch') === 'true',
        limit: Number(url.searchParams.get('limit') || 50),
        offset: Number(url.searchParams.get('offset') || 0),
      });
      return ok(ctx, result);
    }
    if (request.method === 'POST') {
      const body = (await request.json()) as Record<string, unknown>;
      const platform = body['platform'] as string;
      const platformPostId = body['platform_post_id'] as string;
      const row = await ingestStore.enqueuePost(d1, {
        bioguideId: (body['bioguide_id'] as string) ?? null,
        platform,
        platformPostId,
        authorHandle: body['author_handle'] as string,
        postedAt: body['posted_at'] as string,
        url: body['url'] as string,
        bodyText: body['body_text'] as string,
        mediaRefsJson: (body['media_refs_json'] as string) ?? '[]',
        rawPayloadJson: JSON.stringify(body),
      });
      // Dedupe path: enqueuePost returned null because (platform, platform_post_id)
      // already exists. Look up the existing row so the caller still gets an id
      // it can use for the curate-as-quote handoff (otherwise the Research
      // re-curate flow would silently drop on the floor).
      if (!row) {
        const existing = await ingestStore.findQueueByPlatformPostId(d1, platform, platformPostId);
        return { response: jsonResponse(200, { row: existing, deduped: true }), shape: 'api-proxied' };
      }
      return { response: jsonResponse(201, { row, deduped: false }), shape: 'api-proxied' };
    }
    if (request.method === 'PATCH' && id) {
      const body = (await request.json()) as Record<string, unknown>;
      await ingestStore.updateQueueStatus(
        d1,
        id,
        body['status'] as 'curated' | 'dismissed',
        ctx.email,
      );
      return ok(ctx, { updated: true });
    }
  }

  // --- Keywords ---
  if (resource === 'keywords') {
    if (request.method === 'GET') {
      const items = await ingestStore.listKeywordWatches(
        d1,
        url.searchParams.get('includeInactive') !== 'true',
      );
      return ok(ctx, { items });
    }
    if (request.method === 'POST') {
      const body = (await request.json()) as Record<string, unknown>;
      const pattern = String(body['pattern'] ?? '');
      const isRegex = Boolean(body['is_regex']);
      // Pattern length cap + ReDoS preflight. The poll loop runs the pattern
      // on every body of every polled post — a catastrophic-backtracking
      // pattern (e.g. `(a+)+$`) would eat the Worker CPU budget on every
      // cron tick. Admins are trusted but not infallible; this is a
      // self-protective gate, not an authz check.
      const patternError = validateRegexPattern(pattern, isRegex);
      if (patternError) {
        return { response: jsonResponse(400, { error: 'invalid_pattern', detail: patternError, traceId: ctx.traceId }), shape: 'worker-emitted' };
      }
      const row = await ingestStore.createKeywordWatch(d1, {
        watchName: body['watch_name'] as string,
        pattern,
        isRegex,
        notify: body['notify'] !== false,
        createdBy: ctx.email,
      });
      return { response: jsonResponse(201, { row }), shape: 'api-proxied' };
    }
    if (request.method === 'PATCH' && id) {
      const body = (await request.json()) as Record<string, unknown>;
      await ingestStore.toggleKeywordWatch(d1, id, Boolean(body['active']));
      return ok(ctx, { updated: true });
    }
  }

  // --- Manual poll trigger ---
  if (resource === 'poll' && request.method === 'POST') {
    const body = (await request.json()) as Record<string, unknown>;
    const platform = (body['platform'] as PlatformSlug) ?? 'bluesky';
    const adapter = getAdapter(platform);
    const handles = await ingestStore.listHandles(d1, { platform, activeOnly: true });
    const keywords = await ingestStore.listKeywordWatches(d1, true);

    const kwList: KeywordWatch[] = keywords.map((k) => ({
      watchName: k.watch_name,
      pattern: k.pattern,
      isRegex: Boolean(k.is_regex),
    }));

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

    return ok(ctx, result);
  }

  // --- Poll a single handle (granular control from admin UI) ---
  if (resource === 'poll-handle' && request.method === 'POST') {
    const body = (await request.json()) as Record<string, unknown>;
    const handleId = body['handle_id'] as string;
    if (!handleId) {
      return { response: jsonResponse(400, { error: 'missing_handle_id' }), shape: 'worker-emitted' };
    }
    // Per-call override: `force=true` bypasses the staleness gate. The
    // staleness window itself is derived from the cron schedule — admins
    // don't get a per-call knob (the schedule is the truth).
    const force = body['force'] === true;

    // Look up the handle row.
    const allHandles = await ingestStore.listHandles(d1, { activeOnly: true });
    const handle = allHandles.find((h) => h.id === handleId);
    if (!handle) {
      return { response: jsonResponse(404, { error: 'handle_not_found' }), shape: 'worker-emitted' };
    }

    // Staleness gate: skip the upstream call if the handle was polled inside
    // the cron's natural window (interval - safety margin). Derived from
    // SOCIAL_POLL_CRON so the schedule is the only knob — no parallel D1 setting
    // to drift out of sync, no admin UI to fiddle with.
    const minAgeMin = getSocialPollStalenessMin(env);
    if (!force && minAgeMin > 0 && handle.last_polled_at) {
      const ageMs = Date.now() - Date.parse(handle.last_polled_at);
      const cutoffMs = minAgeMin * 60 * 1000;
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < cutoffMs) {
        const ageMin = Math.round(ageMs / 60000);
        return ok(ctx, {
          handle: handle.handle,
          platform: handle.platform,
          bioguideId: handle.bioguide_id,
          displayName: handle.display_name,
          lastPolledAt: handle.last_polled_at,
          skipped: true,
          skipReason: `polled ${ageMin}m ago (gate: ${minAgeMin}m)`,
          newPosts: 0,
          duplicates: 0,
          keywordMatches: 0,
          error: null,
        });
      }
    }

    const adapter = getAdapter(handle.platform as PlatformSlug);
    const keywords = await ingestStore.listKeywordWatches(d1, true);
    const kwList: KeywordWatch[] = keywords.map((k) => ({
      watchName: k.watch_name,
      pattern: k.pattern,
      isRegex: Boolean(k.is_regex),
    }));

    const result = await pollPlatform({
      adapter,
      handles: [{
        id: handle.id,
        bioguideId: handle.bioguide_id,
        platformId: handle.platform_id,
        handle: handle.handle,
        displayName: handle.display_name ?? handle.handle,
        lastSeenPostId: handle.last_seen_post_id,
      }],
      keywords: kwList,
      enqueue: async (input) => {
        const row = await ingestStore.enqueuePost(d1, input);
        return row ? { id: row.id } : null;
      },
      updatePollState: async (hId, polledAt, lastSeenPostId) => {
        // Success path: timestamp + cursor + reset error state.
        await ingestStore.updateHandlePollState(d1, hId, polledAt, lastSeenPostId);
      },
    });

    // Failure path: pollPlatform doesn't write on error (so the next cron tick
    // retries), but we DO want a durable record of the failure so it surfaces
    // on profile + Settings ▸ Poll Status. The trace ID lets operators report
    // the exact failed attempt to engineering.
    //
    // Detect rate-limit signals from the error string. RateLimitError.message
    // has the form "<platform> rate-limited (<status>, <kind>): <ctx> — <body>".
    // We sniff for both the status and the kind so the UI can pick the right
    // backoff strategy: 'transient' = pause + resume, 'quota' = stop until cap resets.
    const errMsg = result.errors.length > 0 ? result.errors[0]!.error : null;
    const rateMatch = errMsg?.match(/rate-limited \((429|403), (transient|quota)\)/);
    const rateLimited = Boolean(rateMatch);
    const rateLimitKind: 'transient' | 'quota' | null = rateMatch
      ? (rateMatch[2] as 'transient' | 'quota')
      : null;
    const retryAfterMatch = errMsg?.match(/retry-after[: ]+(\d+)/i);
    const retryAfterSec = retryAfterMatch ? Number.parseInt(retryAfterMatch[1]!, 10) : null;
    if (errMsg) {
      await ingestStore.recordHandlePollFailure(d1, handle.id, errMsg, ctx.traceId);
    }

    return ok(ctx, {
      handle: handle.handle,
      platform: handle.platform,
      bioguideId: handle.bioguide_id,
      displayName: handle.display_name,
      lastPolledAt: handle.last_polled_at,
      skipped: false,
      rateLimited,
      rateLimitKind,
      retryAfterSec,
      newPosts: result.newPosts,
      duplicates: result.duplicates,
      keywordMatches: result.keywordMatches,
      error: errMsg,
      traceId: ctx.traceId,
    });
  }

  // --- Fetch single post by URL (direct-add flow) ---
  if (resource === 'fetch-post' && request.method === 'POST') {
    const body = (await request.json()) as Record<string, unknown>;
    const postUrl = body['url'] as string;
    if (!postUrl) {
      return { response: jsonResponse(400, { error: 'missing_url' }), shape: 'worker-emitted' };
    }

    try {
      const adapter = adapterForUrl(postUrl);
      const post = await adapter.fetchPostByUrl(postUrl);

      // Try to match the author to a known MoC handle.
      const handles = await ingestStore.listHandles(d1, {
        platform: post.platform,
        activeOnly: true,
      });
      const matched = handles.find(
        (h) => h.platform_id === post.authorPlatformId || h.handle === post.authorHandle,
      );

      return ok(ctx, {
        post,
        moc: matched
          ? { bioguideId: matched.bioguide_id, handle: matched.handle, displayName: matched.display_name }
          : null,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { response: jsonResponse(422, { error: 'fetch_failed', detail: msg }), shape: 'worker-emitted' };
    }
  }

  // --- Search by congressperson (multi-platform) ---
  if (resource === 'search' && request.method === 'POST') {
    const body = (await request.json()) as Record<string, unknown>;
    const bioguideId = body['bioguide_id'] as string;
    const platforms = (body['platforms'] as PlatformSlug[] | undefined) ?? listPlatforms();
    const maxPosts = Number(body['max_posts'] || 50);
    const filterTerms = body['filter_terms'] as string | undefined;
    if (filterTerms) {
      const patternError = validateRegexPattern(filterTerms, true);
      if (patternError) {
        return { response: jsonResponse(400, { error: 'invalid_filter_terms', detail: patternError, traceId: ctx.traceId }), shape: 'worker-emitted' };
      }
    }

    const handles = await ingestStore.listHandles(d1, { bioguideId, activeOnly: true });
    const results: Record<string, { posts: unknown[]; handle: string | null; error?: string }> = {};

    for (const platform of platforms) {
      const handle = handles.find((h) => h.platform === platform);
      if (!handle) {
        results[platform] = { posts: [], handle: null, error: 'no_handle' };
        continue;
      }

      try {
        const adapter = getAdapter(platform);
        const feed = await adapter.listAuthorPosts({
          account: {
            platformId: handle.platform_id,
            handle: handle.handle,
            displayName: handle.display_name ?? handle.handle,
          },
          maxPosts,
        });

        let posts = feed.posts;
        // Client-side keyword filter if terms provided.
        if (filterTerms) {
          const re = new RegExp(filterTerms, 'i');
          posts = posts.filter((p) => re.test(p.bodyText));
        }
        results[platform] = { posts, handle: handle.handle };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        results[platform] = { posts: [], handle: handle.handle, error: msg };
      }
    }

    return ok(ctx, { bioguideId, results });
  }

  // --- Platforms list with liveness ---
  // Returns { platforms: [{ slug, available, error?, bulkEligible }] }.
  // The UI uses `available` to gate which platform toggles render. A
  // platform is "registered" when its env var is present, and "available"
  // when its healthCheck() (if any) succeeds against the live API. Bluesky
  // and Mastodon don't require auth, so they're always available when
  // registered.
  //
  // Liveness is cached in module scope for 5 minutes — health checks are
  // cheap (one API call per platform) but not free, and platform availability
  // doesn't change minute-to-minute. The TTL is bypassed when ?refresh=true.
  if (resource === 'platforms' && request.method === 'GET') {
    const refresh = url.searchParams.get('refresh') === 'true';
    const platforms = await getPlatformsLiveness(refresh);
    return ok(ctx, { platforms });
  }

  // --- Unified seed: roster + Bluesky + keywords (delegates to ingest-seed service) ---
  if (resource === 'seed' && request.method === 'POST') {
    try {
      const result = await ensureIngestSeeded(env, { force: true });
      return ok(ctx, result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { response: jsonResponse(500, { error: 'seed_failed', detail: msg, traceId: ctx.traceId }), shape: 'worker-emitted' };
    }
  }

  // --- YouTube channel ID resolution ---
  if (resource === 'resolve-youtube' && request.method === 'POST') {
    if (!env.YOUTUBE_API_KEY) {
      return { response: jsonResponse(503, { error: 'no_youtube_api_key' }), shape: 'worker-emitted' };
    }
    try {
      const resolved = await resolveYouTubeChannelIds(
        d1,
        env.YOUTUBE_API_KEY,
        { env: env.ENV_NAME ?? 'prod', traceId: ctx.traceId },
      );
      return ok(ctx, { resolved });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { response: jsonResponse(500, { error: 'resolve_failed', detail: msg, traceId: ctx.traceId }), shape: 'worker-emitted' };
    }
  }

  // --- Roster metadata: all MoC entries from KV name-index (photos, party, state) ---
  if (resource === 'roster-meta' && request.method === 'GET') {
    const kv = env.KV_VOTER_INFO;
    if (!kv) {
      return { response: jsonResponse(503, { error: 'kv_unavailable' }), shape: 'worker-emitted' };
    }
    const all: NameIndexEntry[] = [];
    const seen = new Set<string>();
    for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
      const raw = await kv.get(KV_PREFIXES.nameIndex + letter, 'text') as string | null;
      if (!raw) continue;
      const shard = JSON.parse(raw) as { entries: NameIndexEntry[] };
      for (const e of shard.entries) {
        if (seen.has(e.bioguideId)) continue;
        seen.add(e.bioguideId);
        // Strip searchKeys to keep payload small.
        all.push({ ...e, searchKeys: [] });
      }
    }
    return ok(ctx, { members: all });
  }

  // --- Account categories list ---
  if (resource === 'categories' && request.method === 'GET') {
    return ok(ctx, {
      categories: [
        { id: 'congress', label: 'Member of Congress' },
        { id: 'influencer', label: 'Influencer' },
        { id: 'journalist', label: 'Journalist' },
        { id: 'bureaucrat', label: 'Government Official' },
        { id: 'thinktank', label: 'Think Tank / Policy' },
        { id: 'ngo', label: 'NGO / Advocacy' },
        { id: 'foreign_official', label: 'Foreign Official' },
        { id: 'military', label: 'Military / Defense' },
        { id: 'other', label: 'Other' },
      ],
    });
  }

  return {
    response: jsonResponse(404, { error: 'not_found', traceId: ctx.traceId }),
    shape: 'worker-emitted',
  };
}

function ok(ctx: IngestCtx, body: unknown): DispatchResult {
  const r = jsonResponse(200, body);
  r.headers.set('Cache-Control', 'no-store');
  r.headers.set('X-Trace-Id', ctx.traceId);
  return { response: r, shape: 'api-proxied' };
}
