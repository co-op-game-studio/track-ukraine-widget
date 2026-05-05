/**
 * Worker runtime env + binding types. Phase 12 T-075 (2026-04-19).
 *
 * Every handler imports `ProxyEnv` from here. `proxy/lib.ts` re-exports
 * the same names so the legacy `from '../../proxy/lib'` import path used
 * by tests continues to resolve.
 *
 * Traces: FR-42 AC-42.1, AC-42.3.
 */

/** Minimal surface of `caches.default` that handleFetch uses. */
export interface CacheLike {
  match(req: Request | string): Promise<Response | undefined>;
  put(req: Request | string, resp: Response): Promise<void>;
}

/** Minimal KV surface for tests. */
export interface KVLike {
  get(key: string, type?: 'text' | 'json'): Promise<string | null | unknown>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  list(opts: { prefix: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
  delete(key: string): Promise<void>;
}

/**
 * Minimal Cloudflare Workers Rate Limiting API surface (AC-27.21).
 * Fail-open if the binding is absent — tests and local wrangler-dev.
 */
export interface RateLimiterLike {
  limit(args: { key: string }): Promise<{ success: boolean }>;
}

export interface ProxyEnv {
  /** Congress.gov API key. Injected into /api/congress/v3/* upstream requests. */
  CONGRESS_API_KEY: string;
  /**
   * Comma-separated exact `scheme://host[:port]` values. Defaults to the prod
   * whitelist when unset. See AC-25.6.
   */
  ALLOWED_ORIGINS?: string;
  /**
   * When exactly "true", permit `http://localhost[:port]` and `http://127.0.0.1[:port]`
   * origins. Any other value (including unset) denies localhost. See AC-25.9.
   */
  ALLOW_LOCALHOST?: string;
  /**
   * When exactly "true", the Worker serves a preview HTML page at / instead of
   * 301-redirecting to trackukraine.com. Enabled on dev/uat/stg for "open in
   * browser to see the widget live". Prod omits this so voters still land on
   * the embed host.
   */
  PREVIEW_MODE?: string;
  /** Short env label (dev/uat/stg/prod) shown in preview HTML for orientation. */
  ENV_NAME?: string;
  /** KV namespace for curator records (member:, bill:, roll-call:, name-index:) + response cache (cache:). */
  KV_VOTER_INFO: KVLike;
  /**
   * Worker Sites assets binding. Serves static files from ./dist (the
   * widget IIFE bundle etc.). The Worker explicitly calls env.ASSETS.fetch
   * for unknown paths so assets serve after Worker route matching fails.
   */
  ASSETS?: { fetch: (req: Request) => Promise<Response> };
  /**
   * Rate limiter binding (AC-27.21). Absent in tests and local dev — the
   * Worker fail-opens when this is undefined (the zone-level limit in
   * AC-28.3 still applies in prod regardless). See ADR-010.
   */
  RATE_LIMITER?: RateLimiterLike;
  /**
   * R2 static archive bucket (FR-41). Tier-2 durable storage for byte-
   * level-static upstream responses. Absent in tests and in envs that
   * haven't provisioned the bucket yet; the R2Tier's own binding guard
   * makes get() return null and put() no-op when this is undefined.
   */
  R2_STATIC?: import('./cache/r2-tier').R2BucketLike;
  /**
   * Workers Analytics Engine dataset binding (FR-38). Absent in tests and
   * in envs where the binding hasn't been added to wrangler.toml;
   * writeAnalyticsPoint no-ops when this is undefined.
   */
  ANALYTICS?: import('./observability/analytics').AnalyticsDatasetLike;
  /**
   * D1 database for the V4 admin backend (FR-49). Source of truth for
   * editable content (bills, votes, comments, social posts, quotes, audit log).
   * Absent in tests and in envs where D1 hasn't been provisioned yet —
   * admin routes return 503 in that case rather than 500.
   *
   * Traces to FR-49 AC-49.1, ADR-017.
   */
  D1_VOTER_INFO?: D1Like;
  /** YouTube Data API v3 key (FR-59). Set as a Worker secret. Optional —
   *  YouTube adapter is only registered when this is present. */
  YOUTUBE_API_KEY?: string;
  /** Twitter / X API v2 Bearer token (FR-59). Set as a Worker secret. Optional —
   *  Twitter adapter is only registered when this is present. */
  TWITTER_BEARER_TOKEN?: string;
  /**
   * Per-env social poll concurrency budget (FR-59). Caps how many handles
   * the admin client may fan-out in parallel against /api/admin/ingest/poll-handle.
   * Set per env in wrangler.toml; defaults to 4 when unset.
   * This is a deployment knob (not data) — env-tunable to match upstream
   * rate limits and Worker subrequest budgets.
   */
  POLL_CONCURRENCY?: string;
  /**
   * Cron schedule for the social poll loop (FR-59). Mirror of the value in
   * `[env.<env>.triggers].crons`. Cloudflare doesn't expose the trigger schedule
   * to runtime code, so we re-declare it here as the single source of truth for
   * the staleness window: handles polled within `interval - 5min` are skipped
   * by the cron AND the admin endpoint, so a manual poll inside the cron cycle
   * doesn't double-pull but the next tick still fires.
   * Defaults to `0 * * * *` (hourly) when unset.
   */
  SOCIAL_POLL_CRON?: string;
  /**
   * Cloudflare Access team subdomain (e.g. `cogs` for `cogs.cloudflareaccess.com`).
   * Used to build the JWKS URL and the expected `iss` claim during JWT
   * verification on admin routes. Per-env config in wrangler.toml.
   * Traces to FR-50 AC-50.2.
   */
  CF_ACCESS_TEAM?: string;
  /**
   * Cloudflare Access application AUD tag (a 64-hex-char string from the CF
   * Access dashboard). The Worker checks the JWT's `aud` claim against this
   * value to confirm the token was minted by the *correct* Access app — even
   * within the same team, a JWT for a different app is rejected.
   * Traces to FR-50 AC-50.2.
   */
  CF_ACCESS_AUD?: string;
}

/**
 * Minimal subset of Cloudflare's D1Database surface we depend on.
 * Mirrors the Workers runtime interface — tests fake it via in-memory shims.
 *
 * Traces to FR-49 AC-49.1.
 */
export interface D1Like {
  prepare(query: string): D1PreparedStatementLike;
  batch<T = unknown>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run(): Promise<D1ResultLike<unknown>>;
  all<T = unknown>(): Promise<D1ResultLike<T>>;
}

export interface D1ResultLike<T> {
  success: boolean;
  results?: T[];
  meta?: { changes?: number; last_row_id?: number; duration?: number };
  error?: string;
}

export interface ApiRouteRule {
  prefix: string;
  /** Short name used in normalized error envelopes (AC-27.5). */
  upstreamName: 'census' | 'senate' | 'congress';
  target: string;
  injectKey: boolean;
  cacheControl: string;
  /** Pinned upstream Accept header (AC-27.11). Server-side pinned, never from client. */
  upstreamAccept: string;
  /**
   * Query parameters we will forward to upstream (AC-27.20). Unknown params
   * are dropped before building the upstream URL and before computing the
   * cache key. An empty list means "drop all".
   */
  allowedQueryParams: readonly string[];
}

export const API_ROUTES: ApiRouteRule[] = [
  {
    prefix: '/api/census/',
    upstreamName: 'census',
    target: 'https://geocoding.geo.census.gov',
    injectKey: false,
    cacheControl: 'public, s-maxage=86400, max-age=3600',
    upstreamAccept: 'application/json',
    allowedQueryParams: [
      'address',
      'street',
      'city',
      'state',
      'zip',
      'benchmark',
      'vintage',
      'layers',
      'format',
    ],
  },
  {
    prefix: '/api/senate/',
    upstreamName: 'senate',
    target: 'https://www.senate.gov',
    injectKey: false,
    cacheControl: 'public, s-maxage=31536000, max-age=31536000, immutable',
    upstreamAccept: 'application/xml, text/xml, */*;q=0.1',
    allowedQueryParams: [],
  },
  {
    prefix: '/api/congress/',
    upstreamName: 'congress',
    target: 'https://api.congress.gov',
    injectKey: true,
    cacheControl: 'public, s-maxage=3600, max-age=300',
    upstreamAccept: 'application/json',
    allowedQueryParams: [
      'limit',
      'offset',
      'format',
      'fromDateTime',
      'toDateTime',
      'sort',
      'chamber',
      'congress',
      'currentMember',
    ],
  },
];

/** Serialize the canonical upstream-error JSON envelope (AC-27.5). */
export function normalizeUpstreamErrorBody(status: number, upstream: string): string {
  return JSON.stringify({ error: 'upstream_error', status, upstream });
}
