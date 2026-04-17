/**
 * Cloudflare Worker — single-domain handler for the Voter Info Widget.
 *
 * Serves (from one origin, e.g. https://vote.cogs.it.com):
 *   - /api/census/*     — CORS proxy to Census Bureau geocoder
 *   - /api/congress/*   — CORS proxy to api.congress.gov (with API key)
 *   - /api/senate/*     — CORS proxy to www.senate.gov
 *   - /voter-info-widget.iife.js
 *   - /ukraineBills.json
 *   - /ukraineVotes.json    — served from R2 via the ASSETS binding
 *   - anything else     — 404
 *
 * Implements:
 *   - FR-10 CORS proxy routing
 *   - FR-24 serves baked roster JSON from R2
 *   - FR-25 edge caching via `caches.default`
 *   - FR-26 single-domain deployment
 *   - AC-25.5 origin whitelist (ALLOWED_ORIGINS env var)
 *
 * See docs/deployment.md.
 */

type Env = {
  /** API key for api.congress.gov. Set via `wrangler secret put CONGRESS_API_KEY`. */
  CONGRESS_API_KEY: string;
  /**
   * Comma-separated list of allowed origins for /api/* routes. Browsers send
   * the host page's origin (e.g. https://trackukraine.com); our CORS headers
   * must reflect that origin back for cross-origin fetches to work.
   */
  ALLOWED_ORIGINS?: string;
  /** R2 binding — the bucket holding the static assets. */
  ASSETS: R2Bucket;
};

interface ApiRouteRule {
  prefix: string;
  target: string;
  injectKey: boolean;
  cacheControl: string;
}

const API_ROUTES: ApiRouteRule[] = [
  {
    prefix: '/api/census/',
    target: 'https://geocoding.geo.census.gov',
    injectKey: false,
    cacheControl: 'public, s-maxage=86400, max-age=3600',
  },
  {
    prefix: '/api/senate/',
    target: 'https://www.senate.gov',
    injectKey: false,
    cacheControl: 'public, s-maxage=31536000, max-age=31536000, immutable',
  },
  {
    prefix: '/api/congress/',
    target: 'https://api.congress.gov',
    injectKey: true,
    cacheControl: 'public, s-maxage=3600, max-age=300',
  },
];

/** R2 static files we serve. Keys match object keys in the bucket. */
const STATIC_FILES: Record<string, { contentType: string; cacheControl: string }> = {
  'voter-info-widget.iife.js': {
    contentType: 'application/javascript; charset=utf-8',
    cacheControl: 'public, max-age=600',
  },
  'ukraineBills.json': {
    contentType: 'application/json; charset=utf-8',
    cacheControl: 'public, max-age=600',
  },
  'ukraineVotes.json': {
    contentType: 'application/json; charset=utf-8',
    cacheControl: 'public, max-age=600',
  },
};

const DEFAULT_ALLOWED_ORIGINS = [
  'https://trackukraine.com',
  'https://www.trackukraine.com',
];

function isOriginAllowed(origin: string | null, allowlist: string[]): boolean {
  if (!origin) return false;
  if (allowlist.includes(origin)) return true;
  // Any localhost/127.0.0.1 origin is permitted for dev convenience.
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

function parseAllowedOrigins(env: Env): string[] {
  if (env.ALLOWED_ORIGINS) {
    return env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return DEFAULT_ALLOWED_ORIGINS;
}

function corsHeaders(allowedOrigin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/**
 * For static files we allow anyone to read — they are a JS bundle and JSON
 * datasets that are meant to be embedded broadly. CORS is wide-open here.
 */
function staticCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };
}

function pickApiCacheControl(route: ApiRouteRule, upstreamPath: string): string {
  if (route.prefix !== '/api/congress/') return route.cacheControl;
  // Congress.gov routes split between immutable and semi-mutable.
  if (/\/v3\/house-vote\//.test(upstreamPath)) {
    return 'public, s-maxage=31536000, max-age=31536000, immutable';
  }
  if (/\/v3\/bill\/\d+\/\w+\/\d+\/(actions|summaries)/.test(upstreamPath)) {
    return 'public, s-maxage=31536000, max-age=31536000, immutable';
  }
  if (/\/v3\/member\/.*\/(sponsored|cosponsored)-legislation/.test(upstreamPath)) {
    return 'public, s-maxage=3600, max-age=300';
  }
  return 'public, s-maxage=3600, max-age=3600';
}

function sanitizeBody(body: string, redactList: string[]): string {
  let out = body;
  for (const v of redactList) {
    if (v) out = out.split(v).join('[REDACTED]');
  }
  return out;
}

// ─── Request handlers ──────────────────────────────────────────────────────

async function handleStatic(
  pathname: string,
  method: string,
  env: Env,
): Promise<Response | null> {
  // Strip leading slash for R2 object key
  const key = pathname.replace(/^\/+/, '');
  const fileMeta = STATIC_FILES[key];
  if (!fileMeta) return null;

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: staticCorsHeaders() });
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const obj = await env.ASSETS.get(key);
  if (!obj) {
    return new Response('Not Found', { status: 404, headers: staticCorsHeaders() });
  }

  const headers = new Headers({
    'Content-Type': fileMeta.contentType,
    'Cache-Control': fileMeta.cacheControl,
    ...staticCorsHeaders(),
  });
  if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
  if (obj.httpMetadata?.contentEncoding) {
    headers.set('Content-Encoding', obj.httpMetadata.contentEncoding);
  }

  if (method === 'HEAD') {
    return new Response(null, { status: 200, headers });
  }
  return new Response(obj.body, { status: 200, headers });
}

async function handleApi(
  request: Request,
  url: URL,
  env: Env,
  origin: string | null,
  allowedOrigins: string[],
): Promise<Response> {
  // Preflight
  if (request.method === 'OPTIONS') {
    if (!isOriginAllowed(origin, allowedOrigins)) {
      return new Response('Origin not allowed', { status: 403 });
    }
    return new Response(null, { status: 204, headers: corsHeaders(origin!) });
  }
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  if (!isOriginAllowed(origin, allowedOrigins)) {
    return new Response('Origin not allowed', { status: 403 });
  }

  const route = API_ROUTES.find((r) => url.pathname.startsWith(r.prefix));
  if (!route) {
    return new Response('Not Found', { status: 404, headers: corsHeaders(origin!) });
  }

  const upstreamPath = url.pathname.slice(route.prefix.length);
  const upstreamUrl = new URL(`${route.target}/${upstreamPath}`);
  upstreamUrl.search = url.search;

  if (route.injectKey) {
    if (!env.CONGRESS_API_KEY) {
      return new Response('Server misconfigured: CONGRESS_API_KEY not set', {
        status: 500,
        headers: corsHeaders(origin!),
      });
    }
    upstreamUrl.searchParams.set('api_key', env.CONGRESS_API_KEY);
  }

  const cacheControl = pickApiCacheControl(route, upstreamPath);

  // Cache key MUST NOT include the API key or the Origin, or we'd never get
  // cache hits across users/origins.
  const cacheKeyUrl = new URL(upstreamUrl.toString());
  cacheKeyUrl.searchParams.delete('api_key');
  const cacheKey = new Request(cacheKeyUrl.toString(), { method: 'GET' });
  const cache = caches.default;

  let upstreamResponse = await cache.match(cacheKey);
  const wasCacheHit = !!upstreamResponse;

  if (!upstreamResponse) {
    try {
      upstreamResponse = await fetch(upstreamUrl.toString(), {
        method: 'GET',
        headers: {
          Accept: request.headers.get('Accept') ?? '*/*',
          'User-Agent': 'voter-info-widget-proxy/2.4',
        },
      });
    } catch {
      return new Response('Bad Gateway: upstream fetch failed', {
        status: 502,
        headers: corsHeaders(origin!),
      });
    }

    if (upstreamResponse.ok) {
      const cacheableHeaders = new Headers(upstreamResponse.headers);
      cacheableHeaders.set('Cache-Control', cacheControl);
      const cacheable = new Response(upstreamResponse.clone().body, {
        status: upstreamResponse.status,
        headers: cacheableHeaders,
      });
      await cache.put(cacheKey, cacheable);
    }
  }

  const finalHeaders = new Headers(upstreamResponse.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin!))) finalHeaders.set(k, v);
  finalHeaders.set('Cache-Control', cacheControl);
  finalHeaders.set('X-Proxy-Cache', wasCacheHit ? 'HIT' : 'MISS');
  finalHeaders.delete('Set-Cookie');
  finalHeaders.delete('Access-Control-Allow-Credentials');

  if (!upstreamResponse.ok) {
    const body = await upstreamResponse.text();
    const sanitized = sanitizeBody(body, [env.CONGRESS_API_KEY]);
    return new Response(sanitized, { status: upstreamResponse.status, headers: finalHeaders });
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: finalHeaders,
  });
}

// ─── Entry point ───────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowedOrigins = parseAllowedOrigins(env);

    // 1. Static file served from R2
    const staticResp = await handleStatic(url.pathname, request.method, env);
    if (staticResp) return staticResp;

    // 2. /api/* proxied with CORS + origin whitelist
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, url, env, origin, allowedOrigins);
    }

    // 3. Everything else — 404
    return new Response('Not Found', { status: 404 });
  },
};
