# ADR-006: Proxy Security Hardening (v2.4.1)

**Status**: Accepted
**Date**: 2026-04-17
**Context**: v2.4.1 security pass following a live-prod probe of the Cloudflare Worker at `vote.cogs.it.com`.

## Context

A live-probe security review of the prod Worker surfaced three classes of defect that the original v2.4.0 spec either underspecified or actively encoded:

1. **Origin-whitelist defect (spec-level).** AC-25.5 as written in v2.4.0 required the Worker to unconditionally permit any `http://localhost[:port]` or `http://127.0.0.1[:port]` origin, in *every* environment. The probe confirmed this: a request with `Origin: http://localhost:9999` to prod (`vote.cogs.it.com`) returned a 200 with a reflected CORS header. Any attacker running a local webserver (trivial on a developer machine, also trivial inside a VM or a compromised host) could use the prod proxy as a free Congress.gov gateway — consuming our quota, warming our cache with their queries, and attaching our credential to every upstream hit. This is not a code bug. It is what AC-25.5 said to do.

2. **Security-header baseline inconsistency (code-level).** Successful `/api/*` responses inherited headers from upstream that happened to include `Strict-Transport-Security`, `X-Content-Type-Options`, and `X-Frame-Options`. Error responses (403, 404, 405, 500, 502) emitted by the Worker itself had none of these. Static-file responses from R2 had `Cross-Origin-Resource-Policy` but not STS or `nosniff`. The baseline was dependent on upstream behavior, which is unstable (upstream header choices can change without notice) and inconsistent across routes.

3. **Error-body passthrough (code-level).** On non-2xx upstream responses, the Worker passed the raw upstream body through after a string-replace redaction of `CONGRESS_API_KEY`. Upstream HTML error pages (rate-limit, maintenance, api-umbrella error envelopes) therefore flowed through with `Content-Type: text/html`, exposing the upstream provider's error templates and internal request IDs. The `sanitizeBody()` redaction was a sensible defense-in-depth, but relying on it as the *primary* protection for the key meant every upstream body shape was a potential leak site.

Secondary findings from the same review (rolled into this ADR because they are one coherent piece of work):

4. **Path-traversal-adjacent fragility.** The Worker built the upstream URL via `new URL(\`${route.target}/${upstreamPath}\`)`. The `URL` constructor does normalize and cannot be host-switched through this path, but the shape makes that guarantee implicit. A request to `/api/congress/` with an empty path still attached our API key to a request against `https://api.congress.gov/`, and there was no shape check on `upstreamPath` to reject obviously malicious inputs (`..`, `//`, `@`).
5. **Upstream fingerprinting headers.** Responses passed through `x-api-umbrella-request-id`, `x-vcap-request-id`, `Link: <https://api.congress.gov/...>; rel="canonical"`, `Server: cloudflare` (already expected), and `Via` chains. These leak which provider is upstream.
6. **API-key injection scope too broad.** The Worker injected `CONGRESS_API_KEY` into *any* path under `/api/congress/*`, not just `/v3/*`. If api.congress.gov ever exposes a non-v3 endpoint (admin, debug, legacy), our credential goes with the request.

## Decision

Harden the Worker along six axes, specified in new ACs (AC-25.7 through AC-25.10, and FR-27 AC-27.1 through AC-27.10):

1. **Fix the spec first.** Rewrite AC-25.5 to not mandate the localhost bypass. Add AC-25.9 making localhost allowance a per-env flag (`ALLOW_LOCALHOST`). Prod/stg/uat leave it unset (deny); dev/preview set it to `"true"`. This closes Finding 1 at the spec level, where the root cause lives.

2. **Unconditional security-header baseline.** Every response from the Worker (success or error, static or API) is passed through `applySecurityHeaders()`, which sets `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY`. The worker no longer depends on upstream header choices for the baseline.

3. **Error body normalization.** On non-2xx upstream responses, emit a JSON envelope `{"error":"upstream_error","status":N,"upstream":"<prefix>"}` with `Content-Type: application/json; charset=utf-8`. The raw upstream body is never passed through. `sanitizeBody()` is kept as a defense-in-depth step applied to our own error strings, but is no longer the primary protection.

4. **Upstream-path shape validation.** Reject `upstreamPath` containing `..`, `//`, `@`, or control characters with 400 and a JSON body. Makes the "no host switching" guarantee local and testable, independent of `URL`-constructor behavior.

5. **Narrow API-key injection.** For `/api/congress/*`, require the upstream path to start with `v3/`. Reject other congress.gov paths with 400. The key is only attached to v3 endpoints.

6. **Strip fingerprinting upstream headers.** Drop `Set-Cookie`, `Access-Control-Allow-Credentials`, `Server`, `Via`, `Link`, and any `x-vcap-*`, `x-api-umbrella-*`, `x-amz-*`, `x-azure-*`, `x-appengine-*` headers before responding.

The Worker module is refactored to export the five pure helpers (`isOriginAllowed`, `isValidUpstreamPath`, `normalizeUpstreamErrorBody`, `applySecurityHeaders`, `stripFingerprintingHeaders`) alongside the default fetch handler, so each concern is independently unit-testable via vitest. A new `tests/unit/worker.test.ts` exercises the public contract across all three route families (static, `/api/census/*`, `/api/congress/*`) and all six hardening axes. Integration-level behavior is verified by constructing a `Request` and a fake `Env` + `caches.default` stub and calling the default handler directly — no `miniflare` dependency added.

## Consequences

**Positive:**
- Prod stops being a free Congress.gov gateway for any page served from a local webserver.
- Baseline security headers are present on every response, not just on upstream-successful API responses.
- Upstream HTML error pages no longer flow through; clients see a stable JSON error shape.
- The API key can only attach to `api.congress.gov/v3/*`, not arbitrary paths on that host.
- Every hardening axis is covered by a unit test, so regressions in future refactors are caught in CI.

**Negative:**
- Dev workflows that pointed a local harness at the *prod* proxy will break (they must point at `dev.vote.cogs.it.com` or set `ALLOW_LOCALHOST="true"` on their own preview Worker). The fix: use `wrangler dev` or the dev env for local work. This is what `[env.dev]` and `[env.preview]` in `wrangler.toml` are for.
- Clients that parsed upstream HTML error pages (none known, because our own client always consumes JSON) would break. We accept this.
- Small code-size increase in the Worker. Still well under any practical Worker CPU/size limits.

**Neutral:**
- No change to the happy path: successful `/api/*` requests with an allowed origin return the same body and cache behavior as before. Cache keys are unchanged.
- No change to static-file delivery from R2 other than the added security-header baseline.

## Deliberate tradeoffs (documented, not defects)

### Shared cache across whitelisted origins

The edge cache key is built from the upstream URL with `api_key` stripped.
It deliberately does **not** include the `Origin` header. This means a
response fetched when `trackukraine.com` made the request is also served to
`www.trackukraine.com` (and, in non-prod envs, to localhost origins permitted
by `ALLOW_LOCALHOST`). This is intentional — cache hit rate would collapse
if we partitioned by origin, and the upstream API response is identical
regardless of which embedder requested it.

Consequence: any origin on the whitelist can warm the cache. Post-F1 fix
(localhost denied in prod), the whitelist is `trackukraine.com` +
`www.trackukraine.com` only, so this is low-risk. If the whitelist later
expands to include untrusted origins, consider partitioning the cache key
by origin, or making cache-warming explicit (scheduled prefetch) so embedder
behavior doesn't influence shared state.

### Upstream query params forwarded unfiltered (except api_key)

The Worker copies `url.search` verbatim to the upstream URL, then
overwrites `api_key` if the route requires it. All other client-supplied
query parameters reach upstream. For our three upstreams (Census geocoder,
Congress.gov, Senate.gov) this is fine — they only interpret parameters
they know about, and we're the only client, so there's no input
sanitization gap. Documented here so a future refactor that adds an
upstream which DOES treat arbitrary params as sensitive (e.g., a search API
where attacker-controlled `order_by` could leak data by timing) will
surface this as a review point.

### Upstream Accept pinned, not forwarded

`fetch()` to upstream sends a pinned Accept header per route
(`application/json` for Congress and Census, XML-accepting for Senate).
We deliberately do **not** forward the client's Accept. Without this,
an attacker-controlled Accept on a shared-cache proxy could poison the
cache — the cache key is URL-only, so `Accept: text/html` would get the
upstream to respond with HTML which would then be served to subsequent
JSON-expecting clients. Pinning server-side keeps the cache key
semantically complete. The downside: if upstream ever adds content-type
negotiation we want (e.g., CSV), we'd need to extend the route table, not
let the client ask for it directly.

### Cloudflare-injected headers are a zone concern, not a code concern

`Server: cloudflare`, `CF-RAY`, `Report-To`, `NEL` are added by the edge
**after** our Worker returns. No in-code strip is possible. These are
suppressed by a Cloudflare Transform Rule documented in
`docs/deployment.md §Zone-level hardening`. The alternative (setting them
to empty values in the Worker) doesn't work — the edge overwrites.

### HSTS preload is header + manual submission

The Worker emits `Strict-Transport-Security: ...; preload` but preload-list
enrollment is a **separate manual step** at https://hstspreload.org. Until
submitted, the `preload` directive is a no-op that signals intent. See
`docs/deployment.md §Submit the apex to the HSTS preload list`.

## Revisit when

- We need per-embed rate limiting (current answer: Cloudflare zone defaults). At that point, the origin-allowlist becomes a *first* tier of defense and per-origin token-bucket becomes the second.
- We need authenticated surfaces (admin, curator). Current answer: none exist. When they do, Cloudflare Access fronts those paths at the zone level, not in-Worker.
- Congress.gov introduces a `/v4/` endpoint family we want to use — AC-27.6 becomes a `/v[3-9]/` check.
