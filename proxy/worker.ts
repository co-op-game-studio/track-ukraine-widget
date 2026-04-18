/**
 * Cloudflare Worker entry point — single-domain handler for the Voter Info Widget.
 *
 * Serves (from one origin, e.g. https://vote.cogs.it.com):
 *   - /api/census/*               — CORS proxy to Census Bureau geocoder
 *   - /api/congress/*             — CORS proxy to api.congress.gov (with API key, v3 only)
 *   - /api/senate/*               — CORS proxy to www.senate.gov
 *   - /api/members/{bioguideId}   — reads member:v1:* from KV
 *   - /api/name-search?q=...      — reads name-index:v1:* from KV
 *   - /api/bills/{billId}         — reads bill:v1:* from KV
 *   - /api/roll-calls/c/s/r/rc    — reads roll-call:v1:* from KV
 *   - anything else               — 404, or 301 to trackukraine.com on text/html GETs
 *
 * All logic lives in proxy/lib.ts. This file is a thin shim that wires
 * `caches.default` and the KV binding to `handleFetch(request, env, cache)`.
 *
 * Implements: FR-10, FR-24, FR-25, FR-26, FR-27, FR-31, FR-32
 * ADRs: ADR-002, ADR-006, ADR-009, ADR-011
 */

import { handleFetch, type ProxyEnv } from './lib';

type Env = Omit<ProxyEnv, 'KV_VOTER_INFO' | 'ASSETS' | 'RATE_LIMITER'> & {
  KV_VOTER_INFO: KVNamespace;
  ASSETS: Fetcher;
  /** Cloudflare Workers Rate Limiting API binding (AC-27.21). Per-env
   *  limits configured in wrangler.toml. Absent in local / wrangler-dev
   *  builds; the Worker fails open when undefined. */
  RATE_LIMITER?: RateLimit;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env as unknown as ProxyEnv, caches.default, ctx);
  },
};
