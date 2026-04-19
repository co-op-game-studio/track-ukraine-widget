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
 * Traces: FR-42 AC-42.1, AC-42.4. FR-27 AC-27.1. FR-44.
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
import { buildEmbedHtml, buildPreviewHtml } from './routes/preview';

/**
 * Default fetch handler. Called per-request; stateless; pure over its
 * (request, env, cache) inputs.
 *
 * Every response is funneled through `applySecurityHeaders` with its
 * shape so the AC-27.1 baseline is guaranteed regardless of control flow.
 */
export async function handleFetch(
  request: Request,
  env: ProxyEnv,
  cache: CacheLike,
  ctx: WaitUntilLike = { waitUntil: () => {} },
): Promise<Response> {
  const { response, shape } = await dispatch(request, env, cache, ctx);
  return applySecurityHeaders(response, shape);
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

  // 1. KV-backed curator read routes (ADR-011, FR-32).
  const kvRouteMatch = url.pathname.match(
    /^\/api\/(members|bills|roll-calls|roll-call-rosters|state-members|name-search)(?:\/(.+))?$/,
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
    if (kind === 'members') {
      if (!rest) return { response: jsonResponse(400, { error: 'missing_bioguide_id' }, corsHeaders(origin)), shape: 'worker-emitted' };
      return handleMemberProfile(rest, request, env, ctx, origin!);
    }
    if (kind === 'bills') {
      if (!rest) return { response: jsonResponse(400, { error: 'missing_bill_id' }, corsHeaders(origin)), shape: 'worker-emitted' };
      return handleBill(rest, request, env, origin!);
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
  }

  // 2. /api/* passthrough (census/congress/senate) — upstream fetch + edge cache.
  //    Tiered-cache intercept (FR-40/FR-41) lives inside handleApi and falls
  //    through to the legacy edge-cache path on non-matching routes.
  if (url.pathname.startsWith('/api/')) {
    return handleApi(request, url, env, origin, allowedOrigins, allowLocalhost, cache, ctx);
  }

  // 3. Browser navigation: /embed (any env), preview (non-prod), or redirect (prod).
  const accept = request.headers.get('Accept') ?? '';
  if (request.method === 'GET' && accept.includes('text/html')) {
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
