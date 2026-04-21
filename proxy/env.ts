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
