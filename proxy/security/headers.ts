/**
 * Security header emitter + fingerprinting-header stripper + per-route
 * Cache-Control picker.
 *
 * Owns the real implementations as of Phase 12 T-071 (2026-04-19).
 * `proxy/lib.ts` re-exports from here for legacy import paths.
 *
 * Traces: FR-42 AC-42.1, AC-42.2. AC-27.1, AC-27.1a/b/c, AC-27.4, AC-27.16,
 * AC-27.17, AC-25.2/25.3/25.4.
 */
import type { ApiRouteRule } from '../env';

/**
 * What shape of content does this response carry? Used to pick which tier
 * of headers to layer on top of the universal baseline.
 *
 * - 'worker-emitted' — the Worker generated this response itself (error JSON,
 *   redirect, unknown-path 404). Gets CSP + Permissions-Policy + strict CORP.
 * - 'api-proxied'    — a 2xx upstream response flowing through /api/*. Gets
 *   CORP cross-origin so the embedder's browser can read it.
 * - 'static-asset'   — served from R2 (JS bundle, JSON datasets). Gets CORP
 *   cross-origin for embedding; CSP/Permissions-Policy intentionally absent
 *   (they apply to documents, not subresources).
 */
export type ResponseShape = 'worker-emitted' | 'api-proxied' | 'static-asset' | 'embeddable-html';

/** CSP used on any HTML/error content the Worker emits itself. */
const WORKER_EMITTED_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * Permissions-Policy denying every feature we don't use. The empty-allowlist
 * `feature=()` syntax is the strictest form — no origin (including self) may
 * use the feature. List pulled from the MDN feature registry plus a few
 * quasi-standard ones (`interest-cohort`) that major browsers honor.
 */
const WORKER_EMITTED_PERMISSIONS_POLICY = [
  'accelerometer=()',
  'autoplay=()',
  'camera=()',
  'cross-origin-isolated=()',
  'display-capture=()',
  'encrypted-media=()',
  'fullscreen=()',
  'geolocation=()',
  'gyroscope=()',
  'interest-cohort=()',
  'keyboard-map=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'picture-in-picture=()',
  'publickey-credentials-get=()',
  'screen-wake-lock=()',
  'sync-xhr=()',
  'usb=()',
  'web-share=()',
  'xr-spatial-tracking=()',
].join(', ');

/**
 * Apply the AC-27.1 universal baseline plus the AC-27.1a/b/c shape-specific
 * layer. Returns a new Response (body reused). Shape defaults to
 * 'worker-emitted' — safe fallback if a caller forgets to pass one.
 */
export function applySecurityHeaders(
  resp: Response,
  shape: ResponseShape = 'worker-emitted',
): Response {
  const headers = new Headers(resp.headers);

  // Universal baseline (AC-27.1) — set on EVERY response except 'embeddable-html'
  // which needs to be frameable. Everything else gets X-Frame-Options: DENY.
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  if (shape !== 'embeddable-html') {
    headers.set('X-Frame-Options', 'DENY');
  }
  headers.set('X-DNS-Prefetch-Control', 'off');
  headers.set('X-Permitted-Cross-Domain-Policies', 'none');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Origin-Agent-Cluster', '?1');

  // Shape-specific layer.
  if (shape === 'worker-emitted') {
    // AC-27.1a: CSP + Permissions-Policy + strict CORP.
    headers.set('Content-Security-Policy', WORKER_EMITTED_CSP);
    headers.set('Permissions-Policy', WORKER_EMITTED_PERMISSIONS_POLICY);
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    // All worker-emitted responses are error/redirect content — never cache.
    if (resp.status >= 400) {
      headers.set('Cache-Control', 'no-store');
    }
  } else if (shape === 'api-proxied') {
    // AC-27.1c: allow cross-origin read for embedder browsers.
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  } else if (shape === 'embeddable-html') {
    // Embed page — designed for iframing on third-party sites. No CSP
    // restriction from our side (set inline on the response with embed-friendly
    // directives). CORP cross-origin so the iframe's browser can render it.
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  } else {
    // 'static-asset' — AC-27.1b: cross-origin embed.
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  }

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

const FINGERPRINT_HEADER_PREFIXES = [
  'x-vcap-',
  'x-api-umbrella-',
  'x-amz-',
  'x-azure-',
  'x-appengine-',
  'x-request-id',
  'x-correlation-id',
  'x-trace-id',
  'x-b3-',
  // AC-27.16: upstream quota-state leak.
  'x-ratelimit-',
  // AC-27.17: Worker is the sole authority on CORS response headers.
  'access-control-',
];
const FINGERPRINT_HEADERS_EXACT = new Set([
  'set-cookie',
  'server',
  'via',
  'link',
  'report-to',
  'nel',
  'reporting-endpoints',
  'p3p',
  'x-powered-by',
  'x-aspnet-version',
  'x-aspnetmvc-version',
  // AC-27.16: upstream directive headers we never want to honor.
  'clear-site-data',
  'refresh',
  'content-location',
]);

/** Remove fingerprinting / sensitive upstream headers in place (AC-27.4). */
export function stripFingerprintingHeaders(headers: Headers): void {
  const toDelete: string[] = [];
  headers.forEach((_value, name) => {
    const lower = name.toLowerCase();
    if (FINGERPRINT_HEADERS_EXACT.has(lower)) {
      toDelete.push(name);
      return;
    }
    for (const prefix of FINGERPRINT_HEADER_PREFIXES) {
      if (lower.startsWith(prefix)) {
        toDelete.push(name);
        return;
      }
    }
  });
  for (const name of toDelete) headers.delete(name);
}

/**
 * Per-route Cache-Control picker. Exported for AC-25.2/25.3/25.4 tests.
 * See spec.md for the exact contract each return value satisfies.
 */
export function pickApiCacheControl(route: ApiRouteRule, upstreamPath: string): string {
  if (route.upstreamName !== 'congress') return route.cacheControl;
  if (/^v3\/house-vote\//.test(upstreamPath)) {
    return 'public, s-maxage=31536000, max-age=31536000, immutable';
  }
  if (/^v3\/bill\/\d+\/\w+\/\d+\/(actions|summaries)/.test(upstreamPath)) {
    return 'public, s-maxage=31536000, max-age=31536000, immutable';
  }
  if (/^v3\/member\/.*\/(sponsored|cosponsored)-legislation/.test(upstreamPath)) {
    return 'public, s-maxage=604800, max-age=86400, stale-while-revalidate=3600';
  }
  return 'public, s-maxage=86400, max-age=86400, stale-while-revalidate=3600';
}
