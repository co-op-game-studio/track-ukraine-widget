/**
 * Rate-limit key derivation + rate-limit application helpers (AC-27.21).
 *
 * Owns the real implementations as of Phase 12 T-071 (2026-04-19).
 * `proxy/lib.ts` re-exports from here for legacy import paths.
 *
 * Traces: FR-42 AC-42.1, AC-42.2. AC-27.21, AC-27.22, AC-28.3. ADR-010.
 */
import type { ProxyEnv } from '../env';
import type { DispatchResult } from '../routes/common';
import { jsonResponse } from '../routes/common';
import { corsHeaders } from './origin-allowlist';

/**
 * Derive a rate-limit key from the incoming request. Returns `null` when
 * `CF-Connecting-IP` is absent — in prod that should never happen (CF sets
 * it on every request), so `null` signals a misconfiguration and the
 * caller hard-blocks. Non-prod envs (ENV_NAME != 'prod') fall back to a
 * per-URL stub so tests and localhost dev still exercise the limiter.
 */
export function rateLimitKey(request: Request, url: URL, env: ProxyEnv): string | null {
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) return ip;
  if (env.ENV_NAME === 'prod') return null;
  return `no-ip:${url.pathname}`;
}

/**
 * Apply the AC-27.21 rate limit. Returns a `DispatchResult` to short-circuit
 * with a 429, or `null` to continue processing. Fail-open if the binding is
 * absent (AC-27.21 note) or if the binding itself errors — the zone-level
 * limit (AC-28.3) still applies in prod.
 *
 * `retrySeconds` is sourced from the binding's period when known. The
 * Cloudflare Rate Limiting API's `limit()` outcome does not include a
 * reset-time; 60s mirrors the configured `period` for every env in
 * wrangler.toml. If the period ever diverges per env, pull it from an
 * env var.
 */
export async function applyRateLimit(
  request: Request,
  url: URL,
  env: ProxyEnv,
  origin: string | null,
): Promise<DispatchResult | null> {
  if (!env.RATE_LIMITER) return null;
  const key = rateLimitKey(request, url, env);
  // Prod with no CF-Connecting-IP is a misconfiguration (CF always sets
  // this header at the edge). Hard-block rather than bucket everyone
  // together into `no-ip:${path}`.
  if (key === null) {
    return {
      response: jsonResponse(
        429,
        { error: 'rate_limited', reason: 'no_client_ip' },
        {
          ...corsHeaders(origin),
          'Retry-After': '60',
          'Cache-Control': 'no-store',
        },
      ),
      shape: 'worker-emitted',
    };
  }
  let result: { success: boolean };
  try {
    result = await env.RATE_LIMITER.limit({ key });
  } catch {
    return null;
  }
  if (result.success) return null;
  const retrySeconds = 60; // matches wrangler.toml `period`; see note above.
  return {
    response: jsonResponse(
      429,
      { error: 'rate_limited', retry_after: retrySeconds },
      {
        ...corsHeaders(origin),
        'Retry-After': String(retrySeconds),
        'Cache-Control': 'no-store',
      },
    ),
    shape: 'worker-emitted',
  };
}
