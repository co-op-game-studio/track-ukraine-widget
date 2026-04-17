/**
 * Cloudflare Worker entry point — single-domain handler for the Voter Info Widget.
 *
 * Serves (from one origin, e.g. https://vote.cogs.it.com):
 *   - /api/census/*     — CORS proxy to Census Bureau geocoder
 *   - /api/congress/*   — CORS proxy to api.congress.gov (with API key, v3 only)
 *   - /api/senate/*     — CORS proxy to www.senate.gov
 *   - /voter-info-widget.iife.js
 *   - /ukraineBills.json
 *   - /ukraineVotes.json    — served from R2 via the R2_ASSETS binding
 *   - anything else     — 404, or 301 to trackukraine.com on text/html GETs
 *
 * All logic lives in proxy/lib.ts so it can be unit-tested without a
 * Workers runtime. This file is a thin shim that wires `caches.default`
 * and the R2 binding to `handleFetch(request, env, cache)`.
 *
 * Implements:
 *   - FR-10, FR-24, FR-25, FR-26, FR-27
 *   - ADR-002, ADR-006
 */

import { handleFetch, type ProxyEnv } from './lib';

type Env = Omit<ProxyEnv, 'R2_ASSETS'> & {
  /** R2 binding — the bucket holding the static assets. Named R2_ASSETS
   *  (not ASSETS) because wrangler treats an `ASSETS` binding as a signal
   *  to auto-upload the project dir as static Workers Assets, which isn't
   *  what we want — we read R2 ourselves via env.R2_ASSETS.get(...). */
  R2_ASSETS: R2Bucket;
};

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env as unknown as ProxyEnv, caches.default);
  },
};
