/**
 * Origin allowlist + preview/same-origin bypass helpers + CORS header builder.
 *
 * Owns the real implementations as of Phase 12 T-071 (2026-04-19).
 * `proxy/lib.ts` re-exports from here for legacy import paths.
 *
 * Traces: FR-42 AC-42.1, AC-42.2. AC-25.6/25.7/25.9, AC-27.17.
 */
import type { ProxyEnv } from '../env';

const DEFAULT_ALLOWED_ORIGINS = [
  'https://trackukraine.com',
  'https://www.trackukraine.com',
];

/**
 * Is the request Origin header on the allowlist?
 *
 * Exact string match only (AC-25.7). Localhost is permitted ONLY when
 * `allowLocalhost` is true (AC-25.9) — and even then, only for the `http://`
 * scheme against the literal host names `localhost` and `127.0.0.1`.
 */
export function isOriginAllowed(
  origin: string | null,
  allowlist: string[],
  allowLocalhost: boolean,
): boolean {
  if (!origin) return false;
  if (allowlist.includes(origin)) return true;
  if (allowLocalhost && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin)) {
    return true;
  }
  return false;
}

/**
 * Non-prod envs (dev/uat/stg) are gated by Cloudflare Access. Requests that
 * reach the Worker have already passed OTP auth or carry a service token.
 * We drop the Origin allowlist check on these envs — Access is the gate.
 * Prod stays strict.
 */
export function isPreviewEnv(env: { PREVIEW_MODE?: string }): boolean {
  return env.PREVIEW_MODE === 'true';
}

/**
 * Same-origin GET/HEAD bypass: browsers omit the Origin header on same-origin
 * read requests. Sec-Fetch-Site is browser-set (Forbidden Header) and
 * unforgeable by client script, so 'same-origin' with method=GET is a reliable
 * signal that this request came from a document served by this Worker's own
 * host. That's legitimate (our /embed page talking to our own /api/*).
 *
 * Narrowly scoped: GET/HEAD only, Origin absent. Doesn't widen the surface
 * vs. any allowlisted cross-origin GET (which bypasses the allowlist by
 * matching it).
 */
export function isSameOriginBypass(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (request.headers.get('Origin')) return false;
  return request.headers.get('Sec-Fetch-Site') === 'same-origin';
}

export function parseAllowedOrigins(env: ProxyEnv): string[] {
  if (env.ALLOWED_ORIGINS) {
    return env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [...DEFAULT_ALLOWED_ORIGINS];
}

export function corsHeaders(allowedOrigin: string | null): Record<string, string> {
  // On same-origin requests the browser doesn't need (and ignores) ACAO; we
  // omit it entirely rather than echoing a null/empty string that some
  // validators flag as malformed.
  const base: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowedOrigin) base['Access-Control-Allow-Origin'] = allowedOrigin;
  return base;
}
