/**
 * Router — single dispatch point for every inbound request.
 *
 * Owns the `dispatch` + `handleFetch` functions as of Phase 12 T-076
 * (2026-04-19). Before: both lived in a 1583-line `proxy/lib.ts` god
 * module. After: router.ts is ≤200 lines; every handler is imported
 * from `proxy/routes/*`.
 *
 * `handleFetch` is the Worker's default export (via `proxy/worker.ts`),
 * invokes `dispatch`, then applies the FR-27 security-header baseline
 * to whatever the handler returned.
 *
 * Observability (T-103, 2026-04-19): `handleFetch` runs a single trace /
 * analytics / log middleware around `dispatch`. Every outbound response —
 * from every code path — carries `X-Trace-Id`, emits one Analytics Engine
 * data point, and on non-2xx emits one `logEvent`. Previously only the
 * tiered-cache pipeline did any of this, which meant KV-backed routes,
 * origin-denials, rate-limits, and static HTML were invisible to
 * Cloudflare Logpush / Analytics.
 *
 * Traces: FR-42 AC-42.1, AC-42.4. FR-27 AC-27.1. FR-36 AC-36.2. FR-38
 * AC-38.2. FR-39 AC-39.2. FR-44.
 */
import type { ProxyEnv, CacheLike } from './env';
import type { DispatchResult, WaitUntilLike } from './routes/common';
import { jsonResponse, API_ALLOW_METHODS } from './routes/common';
import {
  isOriginAllowed,
  isPreviewEnv,
  isSameOriginBypass,
  parseAllowedOrigins,
  corsHeaders,
} from './security/origin-allowlist';
import { applySecurityHeaders } from './security/headers';
import { applyRateLimit } from './security/rate-limit';
import { handleMemberProfile } from './routes/api-members';
import { handleNameSearch } from './routes/api-name-search';
import { handleBill } from './routes/api-bills';
import { handleRollCall } from './routes/api-roll-calls';
import { handleRollCallRoster } from './routes/api-roll-call-rosters';
import { handleStateMembers } from './routes/api-state-members';
import { handleApi } from './routes/api-upstream';
import { handleAdmin } from './routes/api-admin';
import { handleComments } from './routes/api-comments';
import { handleSocialPosts } from './routes/api-social-posts';
import { handleQuotes } from './routes/api-quotes';
import { handleAuditPublic } from './routes/api-audit-public';
import { handleStatsSummary } from './routes/api-stats';
import { buildEmbedHtml, buildPreviewHtml } from './routes/preview';
import { resolveTraceId, TRACE_HEADER } from './observability/trace';
import { logEvent } from './observability/log';
import {
  writeAnalyticsPoint,
  type UpstreamNameLabel,
  type CacheTierLabel,
} from './observability/analytics';

/** Classify a URL pathname into the analytics `routeClass` blob value. */
function classifyRoute(url: URL): string {
  const p = url.pathname;
  if (p.startsWith('/api/admin/') || p === '/api/admin') return 'admin';
  const kv = p.match(/^\/api\/(members|bills|roll-calls|roll-call-rosters|state-members|name-search|comments|social-posts|quotes|audit|stats)\b/);
  if (kv) return kv[1]!;
  if (p.startsWith('/api/census/')) return 'census';
  if (p.startsWith('/api/congress/')) return 'congress-upstream';
  if (p.startsWith('/api/senate/')) return 'senate-upstream';
  if (p.startsWith('/api/')) return 'api-other';
  if (p.startsWith('/admin')) return 'admin-spa';
  if (p === '/embed' || p === '/embed/') return 'embed-html';
  if (p === '/' || p === '') return 'root';
  return 'asset-or-404';
}

function classifyUpstream(routeClass: string): UpstreamNameLabel {
  if (routeClass === 'census') return 'census';
  if (routeClass === 'congress-upstream') return 'congress';
  if (routeClass === 'senate-upstream') return 'senate';
  return 'none';
}

/** Map an HTTP status + path to the AC-37.2 error code vocabulary. */
function errorCodeFor(status: number): string {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 304) return 'ok';
  if (status === 403) return 'origin_not_allowed';
  if (status === 404) return 'not_found';
  if (status === 405) return 'method_not_allowed';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_error';
  return 'invalid_request';
}

/**
 * Default fetch handler. Called per-request; stateless; pure over its
 * (request, env, cache) inputs.
 *
 * Every response is funneled through `applySecurityHeaders` with its
 * shape so the AC-27.1 baseline is guaranteed regardless of control flow.
 *
 * Observability middleware (T-103): resolve trace ID once, stamp on
 * response, emit analytics + log on exit. Error paths get one log event
 * at level=warn (4xx) or error (5xx); success paths are silent per
 * AC-39.3.
 */
export async function handleFetch(
  request: Request,
  env: ProxyEnv,
  cache: CacheLike,
  ctx: WaitUntilLike = { waitUntil: () => {} },
): Promise<Response> {
  const started = Date.now();
  const url = new URL(request.url);
  const traceId = resolveTraceId(request);
  const envLabel = env.ENV_NAME ?? 'prod';
  const routeClass = classifyRoute(url);
  const upstreamName = classifyUpstream(routeClass);
  // Defense-in-depth log scrub: any secret value seen verbatim in a log
  // payload gets replaced. We never intentionally log these, but a future
  // refactor that interpolates them into an error message (Worker fetch
  // throws are opaque; upstream API bodies sometimes echo request URLs)
  // would otherwise leak the raw token. Keep this list synchronized with
  // every secret in env.ts.
  const redactList = [
    env.CONGRESS_API_KEY,
    env.YOUTUBE_API_KEY,
  ].filter((s): s is string => Boolean(s));

  let response: Response;
  let shape;
  try {
    const dispatched = await dispatch(request, env, cache, ctx);
    response = dispatched.response;
    shape = dispatched.shape;
  } catch (err) {
    // Handler threw — convert to a 500 with the trace ID so the operator
    // can correlate. This is a belt-and-suspenders catch; individual
    // handlers already catch their own errors.
    logEvent(
      { env: envLabel, traceId, redactList },
      { event: 'router_unhandled_error', level: 'error', routeClass, message: (err as Error)?.message ?? String(err) },
    );
    response = new Response('Internal error', { status: 500 });
    shape = 'worker-emitted' as const;
  }

  const withHeaders = applySecurityHeaders(response, shape);

  // Stamp X-Trace-Id on every response (FR-36 AC-36.2). `applySecurityHeaders`
  // doesn't touch X-Trace-Id, but `stripFingerprintingHeaders` (called deep
  // in api-upstream for origin responses) does — so we set AFTER the full
  // dispatch pipeline has returned.
  const finalHeaders = new Headers(withHeaders.headers);
  finalHeaders.set(TRACE_HEADER, traceId);
  const finalResponse = new Response(withHeaders.body, {
    status: withHeaders.status,
    statusText: withHeaders.statusText,
    headers: finalHeaders,
  });

  // Analytics point — one per request, whatever the status (AC-38.2).
  const cacheTier: CacheTierLabel = classifyCacheTier(finalHeaders);
  writeAnalyticsPoint(env.ANALYTICS, ctx, {
    routeClass,
    upstreamName,
    errorCode: errorCodeFor(finalResponse.status),
    env: envLabel,
    cacheTier,
    totalLatencyMs: Date.now() - started,
    upstreamLatencyMs: 0, // populated only on cache-pipeline paths today
    statusCode: finalResponse.status,
    rateLimitRemaining: -1,
    traceId,
  });

  // Log line on non-2xx — AC-39.2. Success is silent (AC-39.3).
  if (finalResponse.status >= 400) {
    const level = finalResponse.status >= 500 ? 'error' : 'warn';
    logEvent(
      { env: envLabel, traceId, redactList },
      {
        event: 'request_non_2xx',
        level,
        routeClass,
        upstreamName,
        status: finalResponse.status,
        method: request.method,
        path: url.pathname,
      },
    );
  }

  return finalResponse;
}

/** Inspect the outbound headers to label which cache tier served this. */
function classifyCacheTier(headers: Headers): CacheTierLabel {
  const cacheHeader = headers.get('X-Cache') ?? headers.get('X-Proxy-Cache') ?? '';
  const tierHeader = headers.get('X-Cache-Tier') ?? '';
  if (tierHeader === 'edge' || tierHeader === 'kv' || tierHeader === 'r2' || tierHeader === 'upstream') {
    return tierHeader;
  }
  if (cacheHeader === 'HIT') return 'edge';
  if (cacheHeader === 'MISS') return 'upstream';
  return 'n/a';
}

export async function dispatch(
  request: Request,
  env: ProxyEnv,
  cache: CacheLike,
  ctx: WaitUntilLike,
): Promise<DispatchResult> {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const allowedOrigins = parseAllowedOrigins(env);
  const allowLocalhost = env.ALLOW_LOCALHOST === 'true';

  // 0. Admin write API (FR-50). Cloudflare Access gates this path at the
  //    edge; the Worker independently verifies the JWT. Path discipline is
  //    enforced here so no `/api/admin/*` request can fall through to the
  //    upstream-passthrough block below.
  const adminMatch = url.pathname.match(/^\/api\/admin(?:\/(.*))?$/);
  if (adminMatch) {
    const rest = adminMatch[1] ?? '';
    // Origin allowlist still applies — admin SPA is same-origin so this
    // succeeds in practice; rejecting cross-origin is an extra layer.
    if (!isPreviewEnv(env) && !isOriginAllowed(origin, allowedOrigins, allowLocalhost) && !isSameOriginBypass(request)) {
      return {
        response: new Response('Origin not allowed', {
          status: 403,
          headers: { Allow: 'GET, POST, PATCH, DELETE, OPTIONS' },
        }),
        shape: 'worker-emitted',
      };
    }
    const adminRl = await applyRateLimit(request, url, env, origin);
    if (adminRl) return adminRl;
    const traceId = resolveTraceId(request);
    return handleAdmin(rest, request, env, ctx, origin, traceId, env.ENV_NAME ?? 'prod');
  }

  // 1. KV-backed read routes (ADR-011 / FR-32 + V4 FR-51 / FR-56 / FR-58).
  const kvRouteMatch = url.pathname.match(
    /^\/api\/(members|bills|roll-calls|roll-call-rosters|state-members|name-search|comments|social-posts|quotes|audit|stats)(?:\/(.+))?$/,
  );
  if (kvRouteMatch) {
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

    // AC-27.21 + AC-27.22: rate-limit after cheap rejects, before KV reads.
    const kvRlResult = await applyRateLimit(request, url, env, origin);
    if (kvRlResult) return kvRlResult;

    const [, kind, rest] = kvRouteMatch;
    // AC-52.48 + AC-52.51 — read-through routes log cache events with
    // the inbound traceId. Older routes don't consume it; pass anyway.
    const kvTraceId = resolveTraceId(request);
    if (kind === 'members') {
      if (!rest) return { response: jsonResponse(400, { error: 'missing_bioguide_id' }, corsHeaders(origin)), shape: 'worker-emitted' };
      return handleMemberProfile(rest, request, env, ctx, origin!);
    }
    if (kind === 'bills') {
      if (!rest) return { response: jsonResponse(400, { error: 'missing_bill_id' }, corsHeaders(origin)), shape: 'worker-emitted' };
      return handleBill(rest, request, env, origin!, kvTraceId);
    }
    if (kind === 'roll-calls') {
      if (!rest) return { response: jsonResponse(400, { error: 'missing_roll_call_key' }, corsHeaders(origin)), shape: 'worker-emitted' };
      return handleRollCall(rest, request, env, origin!);
    }
    if (kind === 'roll-call-rosters') {
      if (!rest) return { response: jsonResponse(400, { error: 'missing_roll_call_key' }, corsHeaders(origin)), shape: 'worker-emitted' };
      return handleRollCallRoster(rest, request, env, origin!);
    }
    if (kind === 'state-members') {
      if (!rest) return { response: jsonResponse(400, { error: 'missing_state_code' }, corsHeaders(origin)), shape: 'worker-emitted' };
      return handleStateMembers(rest, request, env, origin!);
    }
    if (kind === 'name-search') {
      return handleNameSearch(request, url, env, origin!);
    }
    if (kind === 'comments') {
      if (!rest) return { response: jsonResponse(400, { error: 'missing_bill_id' }, corsHeaders(origin)), shape: 'worker-emitted' };
      return handleComments(rest, request, env, origin!, kvTraceId);
    }
    if (kind === 'social-posts') {
      if (!rest) return { response: jsonResponse(400, { error: 'missing_bioguide_id' }, corsHeaders(origin)), shape: 'worker-emitted' };
      return handleSocialPosts(rest, request, env, origin!, kvTraceId);
    }
    if (kind === 'quotes') {
      if (!rest) return { response: jsonResponse(400, { error: 'missing_bioguide_id' }, corsHeaders(origin)), shape: 'worker-emitted' };
      return handleQuotes(rest, request, env, origin!, kvTraceId);
    }
    if (kind === 'audit') {
      // Only the public sub-route is served from the public KV-route block.
      // The authenticated /api/admin/audit lives under the admin block above.
      if (rest !== 'public') {
        return { response: jsonResponse(404, { error: 'not_found' }, corsHeaders(origin)), shape: 'worker-emitted' };
      }
      return handleAuditPublic(request, env, origin!);
    }
    if (kind === 'stats') {
      // FR-56 AC-56.1 — only /api/stats/v1/summary is exposed.
      if (rest !== 'v1/summary') {
        return { response: jsonResponse(404, { error: 'not_found' }, corsHeaders(origin)), shape: 'worker-emitted' };
      }
      return handleStatsSummary(request, env, origin!);
    }
  }

  // 2. /api/* passthrough (census/congress/senate) — upstream fetch + edge cache.
  //    Tiered-cache intercept (FR-40/FR-41) lives inside handleApi and falls
  //    through to the legacy edge-cache path on non-matching routes.
  if (url.pathname.startsWith('/api/')) {
    return handleApi(request, url, env, origin, allowedOrigins, allowLocalhost, cache, ctx);
  }

  // 3. Browser navigation: /admin (FR-52, gated by CF Access), /embed,
  //    preview (non-prod), or redirect (prod).
  const accept = request.headers.get('Accept') ?? '';
  if (request.method === 'GET' && accept.includes('text/html')) {
    // FR-52 AC-52.2 — admin SPA. CF Access gates this path at the edge;
    // by the time we get here the user is authenticated. We rewrite
    // bare /admin and /admin/ to the SPA's index.html so the bundle
    // bootstraps; nested paths (/admin/main.js, /admin/assets/*) fall
    // through to the ASSETS binding below.
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      if (env.ASSETS) {
        const indexReq = new Request(
          new URL('/admin/index.html', url.origin),
          { method: 'GET', headers: request.headers },
        );
        try {
          const r = await env.ASSETS.fetch(indexReq);
          if (r.status !== 404) {
            return { response: r, shape: 'static-asset' };
          }
        } catch { /* fall through */ }
      }
      return {
        response: new Response('admin SPA bundle missing', { status: 404 }),
        shape: 'worker-emitted',
      };
    }
    if (url.pathname === '/embed' || url.pathname === '/embed/') {
      return {
        response: new Response(buildEmbedHtml(env.ENV_NAME ?? 'prod'), {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=600',
            'Content-Security-Policy':
              "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; " +
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
              "font-src 'self' https://fonts.gstatic.com; " +
              "img-src 'self' data: https:; " +
              "connect-src 'self'; " +
              "base-uri 'none'",
          },
        }),
        shape: 'embeddable-html',
      };
    }
    // AC-52.10 — `/admin/*` paths are admin SPA assets and SHALL NOT be
    // intercepted by the preview-HTML branch (dev) or the 301-to-embed-host
    // branch (prod). They fall through to env.ASSETS at the bottom of
    // dispatch where the bundled `dist/admin/` files serve them. The bare
    // `/admin` and `/admin/` paths are handled above by the explicit
    // index.html rewrite block; this guard catches the nested paths
    // (e.g. /admin/index.html, /admin/foo/bar.html).
    const isAdminAssetPath = url.pathname.startsWith('/admin/');
    if (!isAdminAssetPath) {
      if (env.PREVIEW_MODE === 'true') {
        return {
          response: new Response(buildPreviewHtml(env.ENV_NAME ?? 'non-prod'), {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
              'Content-Security-Policy':
                "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; " +
                "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
                "font-src 'self' https://fonts.gstatic.com; " +
                "img-src 'self' data: https:; " +
                "connect-src 'self'; " +
                "frame-ancestors 'none'; base-uri 'none'",
              'X-Preview-Mode': 'served',
            },
          }),
          shape: 'static-asset',
        };
      }
      // Prod: bounce to the embed host.
      const resp = Response.redirect('https://trackukraine.com/', 301);
      const headers = new Headers(resp.headers);
      headers.set('X-Preview-Mode', `skipped (prod)`);
      return {
        response: new Response(resp.body, { status: resp.status, headers }),
        shape: 'worker-emitted',
      };
    }
    // /admin/* paths fall through to ASSETS below.
  }

  // 4. Unknown path: delegate to Worker Sites assets.
  if (env.ASSETS) {
    try {
      const assetResp = await env.ASSETS.fetch(request);
      if (assetResp.status !== 404) {
        return { response: assetResp, shape: 'static-asset' };
      }
    } catch {
      /* fall through */
    }
  }
  return { response: new Response('Not Found', { status: 404 }), shape: 'worker-emitted' };
}
