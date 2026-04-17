# ADR-005: Cloudflare-Native Deployment Architecture

**Status**: Accepted
**Date**: 2026-04-17
**Context**: v2.4.0 rework (FR-24, FR-25, FR-26)

## Context

The widget must be embeddable on trackukraine.com (which runs on the Fourthwall platform) while keeping API keys secure and infrastructure under the project's control. Earlier specs referenced "some CDN + the Cloudflare Worker" without committing to a deployment story. Now that we need:

- Reliable edge caching to hit the performance targets
- A single-origin security story (everything on Cloudflare)
- Reproducible deploys via CI

we need to commit to an architecture.

## Decision

Two Cloudflare services, both deployed from this repo:

1. **Cloudflare R2** bucket (`voter-info-widget-assets`) behind a custom domain. Serves the IIFE bundle and the two JSON files (`ukraineBills.json`, `ukraineVotes.json`).
2. **Cloudflare Worker** (`proxy/worker.ts`) behind a separate custom domain. Handles the `/api/*` proxy routes with edge caching via `caches.default`. Holds the Congress.gov API key as a Worker secret.

Embedders reference both domains via `<script src="https://cdn.../bundle.iife.js">` + `<voter-info-widget api-base="https://api..." assets-base="https://cdn...">`.

## Alternatives Considered

### Alt 1: Cloudflare Pages for the static assets

Pages is designed for full SPAs / static sites with git-backed deploys. Our assets are a single JS file and two JSON files. Pages would work but adds a build step and treats us as a "site" instead of a "CDN origin." R2 with a custom domain is the leaner fit.

### Alt 2: Bundle the roster JSON into the IIFE directly

Produces a single ~1MB file. Simpler embed (one `<script>`), but fattens the bundle even for users who never open a rep card. The chosen approach (sibling JSON fetched on boot) keeps the IIFE under 250KB, parallelizes the bundle+JSON download, and leverages CDN caching on the JSON.

### Alt 3: External CDN (jsDelivr / unpkg / Netlify / Vercel) for the bundle, Worker for API only

Splits the security story. A third-party CDN could be compromised, and Fourthwall operators wouldn't have one source of truth. Keeping everything on the same Cloudflare account lets us audit the full chain.

### Alt 4: Full backend (Express / Fastify / Node on a VPS)

Overkill for a stateless proxy. Costs more, requires more ops, doesn't match the "edge-first" model. Ruled out.

### Alt 5: Bake rosters AND provide runtime fallback

This is what we actually do — baked rosters are the fast path, runtime fetch is the fallback for misses. Not strictly an alternative, but worth noting as the compromise.

## Consequences

### Positive
- Single security perimeter (one Cloudflare account, one auditable surface)
- Edge cache absorbs >99% of post-warmup traffic
- Widget bundle stays small (~185KB gzipped today; +JSON fetch in parallel)
- `wrangler`-driven deploys are reproducible and scriptable
- API keys never touch client-exposed surfaces

### Negative
- Hard dependency on Cloudflare (lock-in). Migration cost non-trivial but feasible — the Worker is ~150 lines and the static assets are standard files.
- Two custom domains to provision and maintain
- First-ever visitor in a POP pays an upstream round trip (mitigated by baked rosters covering 90%+ of the data)

### Operational
- Requires a Cloudflare account, an API token, and two custom domain DNS records
- Requires three GitHub Actions secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CONGRESS_API_KEY`)
- Weekly curator job keeps rosters fresh without manual intervention

## References

- FR-24 Baked Vote Rosters
- FR-25 Edge-Cached CORS Proxy
- FR-26 Cloudflare Deployment Story
- [`docs/deployment.md`](../deployment.md) — operator playbook
