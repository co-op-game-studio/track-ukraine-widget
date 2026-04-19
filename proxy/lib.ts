/**
 * proxy/lib.ts — back-compat barrel file (Phase 12 T-077, 2026-04-19).
 *
 * Pre-Phase-12 this file was a 1583-line god module housing types, pure
 * helpers, KV helpers, route handlers, and dispatch. Phase 12 extracted
 * every responsibility into its own module:
 *
 *   proxy/env.ts              — ProxyEnv, ApiRouteRule, API_ROUTES, types
 *   proxy/routes/common.ts    — WaitUntilLike, DispatchResult, jsonResponse
 *   proxy/routes/api-*.ts     — one file per route family
 *   proxy/router.ts           — dispatch + handleFetch
 *   proxy/security/*          — origin allowlist, URL validation, headers, rate-limit
 *   proxy/kv/*                — KV_PREFIXES, NameIndexEntry, MemberProfile types
 *   proxy/cache/*             — tiered cache (FR-40)
 *   proxy/upstreams/*         — upstream fetchers (FR-41)
 *   proxy/observability/*     — trace / log / analytics / error-envelope (FR-36..39)
 *
 * This file remains solely to preserve the `from '../../proxy/lib'` import
 * paths that existing tests + consumers use. No implementation lives here.
 *
 * New code SHOULD import from the specific module. Legacy imports
 * continue to work.
 */

// ─── Types + constants ───────────────────────────────────────────────────
export type { CacheLike, KVLike, RateLimiterLike, ProxyEnv, ApiRouteRule } from './env';
export { API_ROUTES, normalizeUpstreamErrorBody } from './env';

// ─── Dispatch primitives ────────────────────────────────────────────────
export type { WaitUntilLike, DispatchResult } from './routes/common';

// ─── Security helpers ────────────────────────────────────────────────────
export {
  isOriginAllowed,
  isPreviewEnv,
  isSameOriginBypass,
  parseAllowedOrigins,
  corsHeaders,
} from './security/origin-allowlist';
export {
  isValidUpstreamPath,
  buildUpstreamUrl,
  sanitizeHttpUrl,
} from './security/url-validator';
export {
  applySecurityHeaders,
  stripFingerprintingHeaders,
  pickApiCacheControl,
  type ResponseShape,
} from './security/headers';
export { rateLimitKey, applyRateLimit } from './security/rate-limit';

// ─── KV types + helpers ─────────────────────────────────────────────────
export { KV_PREFIXES } from './kv/prefixes';
export {
  normalizeSearchKey,
  rankMatches,
  type NameIndexEntry,
} from './kv/name-index';
export { type MemberProfile, PROFILE_TTL_SECONDS } from './kv/member-profile';

// ─── Dispatch entry point ──────────────────────────────────────────────
export { handleFetch, dispatch } from './router';
