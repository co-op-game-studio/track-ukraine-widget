# ADR-002: CORS Proxy Strategy

**Date**: 2026-04-16
**Status**: Accepted
**Deciders**: Project team

## Context

The U.S. Census Bureau Geocoder, Congress.gov API, and Senate.gov XML endpoints do not support CORS for browser-origin requests. The widget runs entirely client-side, so all three APIs are unreachable from the browser without a proxy.

Additionally, the Congress.gov API key must not be embedded in the production client-side bundle (security concern — keys exposed in source/network tab). The Census geocoder requires no API key.

## Decision

Two-tier proxy approach:

1. **Development**: Vite's built-in dev server proxy rewrites `/api/*` paths to the upstream APIs. API keys are loaded from `.env` and appended by the Vite proxy config.

2. **Production**: A Cloudflare Worker (or equivalent edge function) acts as the CORS proxy. API keys are stored as Worker environment variables and injected server-side. A reference implementation is provided in `proxy/worker.js`.

The widget always calls relative paths (`/api/census/...`, `/api/congress/...`, `/api/senate/...`). An `api-base` attribute on the custom element allows embedders to point at their proxy instance.

## Rationale

**Why not direct client-side calls**: CORS blocks them. No workaround exists without a proxy.

**Why not a full backend server**: The widget is designed to be stateless and front-end only. A full Express/Node server adds deployment complexity that's unnecessary for simple request forwarding.

**Why Cloudflare Workers**: Edge-deployed (low latency), free tier supports the expected traffic, simple to deploy, and natively handles CORS headers. Alternative edge platforms (Vercel Edge Functions, AWS Lambda@Edge) would also work — the reference implementation is intentionally simple enough to port.

**Why Vite proxy for dev**: Zero additional infrastructure during development. Vite's proxy config is declarative and matches the production path contract exactly.

## Alternatives Considered

| Alternative | Why Not |
|------------|---------|
| JSONP / CORS-anywhere | JSONP not supported by these APIs; public CORS proxies are unreliable and insecure |
| Direct Census calls | Census has no CORS headers; same problem as the other APIs |
| Backend-for-frontend (Express) | Adds server hosting requirement; overkill for stateless proxying |
| Embed API keys in client | Security risk — keys visible in network tab and source code |

## Consequences

- Embedders must deploy the CORS proxy (or equivalent) to use the widget in production
- API keys are never in the client bundle
- The proxy is the single point of failure — if it's down, the widget is non-functional
- Reference proxy implementation (~50 lines) lowers the barrier to deployment
