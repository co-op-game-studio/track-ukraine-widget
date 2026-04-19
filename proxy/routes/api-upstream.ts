/**
 * Generic /api/{census|congress|senate}/* upstream proxy handler.
 *
 * Performs preflight, origin allowlist, method gating, structural path
 * validation, Congress.gov key-injection, rate limiting, edge cache
 * lookup, upstream fetch with timeout, error normalization, and response
 * header sanitization.
 *
 * Owns its implementation as of Phase 12 T-075 (2026-04-19).
 *
 * Traces: FR-10, FR-25 AC-25.1..AC-25.10. FR-27 AC-27.1..AC-27.22. FR-42.
 */
import type { ProxyEnv, CacheLike } from '../env';
import { API_ROUTES, normalizeUpstreamErrorBody } from '../env';
import type { DispatchResult, WaitUntilLike } from './common';
import { jsonResponse, API_ALLOW_METHODS, sanitizeBody } from './common';
import {
  isOriginAllowed,
  isPreviewEnv,
  isSameOriginBypass,
  corsHeaders,
} from '../security/origin-allowlist';
import { isValidUpstreamPath, buildUpstreamUrl } from '../security/url-validator';
import { pickApiCacheControl, stripFingerprintingHeaders } from '../security/headers';
import { applyRateLimit } from '../security/rate-limit';
import { matchRoute } from './cache-config';
import { TieredCache } from '../cache/tiered-cache';
import { EdgeTier } from '../cache/edge-tier';
import { KvTier, type KvLike } from '../cache/kv-tier';
import { R2Tier } from '../cache/r2-tier';
import { serveCached } from '../cache/pipeline';
import { createUpstreamRegistry } from '../upstreams/registry';
import type { CacheKey } from '../cache/key';

export async function handleApi(
  request: Request,
  url: URL,
  env: ProxyEnv,
  origin: string | null,
  allowedOrigins: string[],
  allowLocalhost: boolean,
  cache: CacheLike,
  ctx: WaitUntilLike = { waitUntil: () => {} },
): Promise<DispatchResult> {
  // AC-27.13: route-match BEFORE preflight so unknown /api/<foo>/* paths
  // don't get a 204 preflight-success (which would advertise CORS on paths
  // we don't actually serve).
  const route = API_ROUTES.find((r) => url.pathname.startsWith(r.prefix));
  if (!route) {
    return {
      response: jsonResponse(
        404,
        { error: 'no_such_api_route' },
        { Allow: API_ALLOW_METHODS },
      ),
      shape: 'worker-emitted',
    };
  }

  // Preflight (OPTIONS) — now only reached when route is known.
  if (request.method === 'OPTIONS') {
    if (!isPreviewEnv(env) && !isOriginAllowed(origin, allowedOrigins, allowLocalhost) && !isSameOriginBypass(request)) {
      return {
        response: new Response('Origin not allowed', {
          status: 403,
          headers: { Allow: API_ALLOW_METHODS },
        }),
        shape: 'worker-emitted',
      };
    }
    return {
      response: new Response(null, {
        status: 204,
        headers: { ...corsHeaders(origin), Allow: API_ALLOW_METHODS },
      }),
      shape: 'api-proxied',
    };
  }

  // AC-27.9: accept GET and HEAD. Anything else → 405 with Allow.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return {
      response: new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: API_ALLOW_METHODS },
      }),
      shape: 'worker-emitted',
    };
  }

  if (!isPreviewEnv(env) && !isOriginAllowed(origin, allowedOrigins, allowLocalhost) && !isSameOriginBypass(request)) {
    return {
      response: new Response('Origin not allowed', {
        status: 403,
        headers: { Allow: API_ALLOW_METHODS },
      }),
      shape: 'worker-emitted',
    };
  }

  const upstreamPath = url.pathname.slice(route.prefix.length);

  // AC-27.7: structural validation of upstream path.
  if (!isValidUpstreamPath(upstreamPath)) {
    return {
      response: jsonResponse(400, { error: 'invalid_upstream_path' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }

  // AC-27.6 + AC-27.12: congress.gov key is injected only on /v3/<alpha>* paths.
  if (route.injectKey && !/^v3\/[a-z]/.test(upstreamPath)) {
    return {
      response: jsonResponse(400, { error: 'unsupported_upstream_path' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }

  // AC-27.21 + AC-27.22: rate-limit AFTER cheap rejections (origin/route/
  // path/method) and BEFORE the expensive upstream fetch.
  const rlResult = await applyRateLimit(request, url, env, origin);
  if (rlResult) return rlResult;

  // ── FR-40/FR-41 tiered-cache intercept (Phase 12 live-wiring) ─────────
  // When matchRoute identifies a cacheable path and the method is GET,
  // route through the three-tier cache (edge → KV → R2 → upstream) with
  // FR-38 analytics + FR-39 structured logs wired in. Non-matching paths
  // (or HEAD) fall through to the legacy edge-cache-only logic below so
  // semantics are preserved for everything the tiered cache doesn't yet
  // handle (e.g., HEAD responses, routes not in the cache-config map).
  if (request.method === 'GET') {
    const match = matchRoute(request);
    if (match) {
      const routeClass = match.cacheKind;
      const tiered = new TieredCache<string>([
        new EdgeTier<string>(cache, (k: CacheKey) => {
          // Use the upstream URL as the edge cache key so two requests
          // for the same key land in the same bucket regardless of which
          // POP served them. The API key never appears here.
          const u = new URL(`${route.target}/${upstreamPath}`);
          // Include kind + params in the pathname so same-URL different-
          // kind doesn't collide (defense; matchRoute should prevent).
          u.pathname += `#${k.kind}`;
          return u;
        }),
        new KvTier<string>({
          // env.KV_VOTER_INFO.get returns `string | null | unknown`; KvLike
          // expects `string | null`. Narrow via adapter since the tier only
          // ever passes a key (not the optional `type` param that widens
          // the KVLike return type).
          get: (k: string) => env.KV_VOTER_INFO.get(k).then((v) => (v as string | null)),
          put: (k: string, v: string, opts?: { expirationTtl?: number }) =>
            env.KV_VOTER_INFO.put(k, v, opts),
        } satisfies KvLike),
        new R2Tier<string>(env.R2_STATIC),
      ]);
      // Resolve fetch off globalThis at call time (not module-bind time)
      // so tests that swap globalThis.fetch via beforeEach still intercept.
      const registry = createUpstreamRegistry({
        apiKey: env.CONGRESS_API_KEY,
        fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
        now: () => new Date(),
      });
      const fetcher = registry.getFor(match.key);
      if (fetcher) {
        const resp = await serveCached({
          key: match.key,
          cache: tiered,
          fetcher,
          policy: match.policy,
          ctx,
          traceId: request.headers.get('X-Trace-Id') ?? 'tr_' + Math.random().toString(16).slice(2, 18).padEnd(16, '0'),
          extraHeaders: corsHeaders(origin),
          upstreamAttribution: route.upstreamName === 'senate' ? 'senate' : route.upstreamName === 'census' ? 'census' : 'congress',
          observability: {
            analytics: env.ANALYTICS,
            env: env.ENV_NAME ?? 'prod',
            routeClass,
            upstreamName: route.upstreamName === 'senate' ? 'senate' : route.upstreamName === 'census' ? 'census' : 'congress',
            redactList: env.CONGRESS_API_KEY ? [env.CONGRESS_API_KEY] : undefined,
          },
        });
        return { response: resp, shape: 'api-proxied' };
      }
    }
  }

  // AC-27.20: allowlist + canonical form.
  const upstreamUrl = buildUpstreamUrl(route, upstreamPath, url.searchParams);

  if (route.injectKey) {
    if (!env.CONGRESS_API_KEY) {
      return {
        response: jsonResponse(
          500,
          { error: 'server_misconfigured', detail: 'CONGRESS_API_KEY not set' },
          corsHeaders(origin),
        ),
        shape: 'worker-emitted',
      };
    }
    upstreamUrl.searchParams.set('api_key', env.CONGRESS_API_KEY);
  }

  const cacheControl = pickApiCacheControl(route, upstreamPath);

  // Cache key MUST NOT include the API key or the Origin.
  const cacheKeyUrl = new URL(upstreamUrl.toString());
  cacheKeyUrl.searchParams.delete('api_key');
  const cacheKey = new Request(cacheKeyUrl.toString(), { method: 'GET' });

  let upstreamResponse = await cache.match(cacheKey);
  const wasCacheHit = !!upstreamResponse;

  if (!upstreamResponse) {
    try {
      upstreamResponse = await fetch(upstreamUrl.toString(), {
        method: 'GET',
        headers: {
          Accept: route.upstreamAccept,
          'User-Agent': 'voter-info-widget-proxy/2.5.1',
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      const isTimeout = err instanceof DOMException && err.name === 'AbortError';
      return {
        response: jsonResponse(
          isTimeout ? 504 : 502,
          {
            error: isTimeout ? 'upstream_timeout' : 'upstream_unreachable',
            upstream: route.upstreamName,
          },
          { ...corsHeaders(origin), 'Cache-Control': 'no-store' },
        ),
        shape: 'worker-emitted',
      };
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

  // AC-27.5: non-2xx upstream responses are normalized to a JSON envelope.
  if (!upstreamResponse.ok) {
    const envelope = normalizeUpstreamErrorBody(upstreamResponse.status, route.upstreamName);
    const sanitized = sanitizeBody(envelope, [env.CONGRESS_API_KEY]);
    const finalHeaders = new Headers(corsHeaders(origin));
    finalHeaders.set('Content-Type', 'application/json; charset=utf-8');
    finalHeaders.set('Cache-Control', 'no-store');
    finalHeaders.set('X-Proxy-Cache', wasCacheHit ? 'HIT' : 'MISS');
    return {
      response: new Response(sanitized, {
        status: upstreamResponse.status,
        headers: finalHeaders,
      }),
      shape: 'worker-emitted',
    };
  }

  // 2xx: pass upstream body, strip fingerprinting headers, apply CORS.
  const finalHeaders = new Headers(upstreamResponse.headers);
  stripFingerprintingHeaders(finalHeaders);
  for (const [k, v] of Object.entries(corsHeaders(origin))) finalHeaders.set(k, v);
  finalHeaders.set('Cache-Control', cacheControl);
  finalHeaders.set('X-Proxy-Cache', wasCacheHit ? 'HIT' : 'MISS');

  // AC-27.9: HEAD returns headers only — no body.
  const body = request.method === 'HEAD' ? null : upstreamResponse.body;

  return {
    response: new Response(body, {
      status: upstreamResponse.status,
      headers: finalHeaders,
    }),
    shape: 'api-proxied',
  };
}
