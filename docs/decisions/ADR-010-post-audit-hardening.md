# ADR-010: Post-Audit Hardening (v2.5.1)

**Status**: Accepted
**Date**: 2026-04-17
**Context**: A comprehensive security audit performed on 2026-04-17 against prod (`vote.cogs.it.com`) and the working tree. Covered: `proxy/lib.ts` (static review), live prod probes of all three `/api/*` routes, R2 asset surface, client bundle XSS sinks, `.env` secret hygiene, `npm audit`, wrangler config per-env. Findings ranked by severity with live-probe verification where applicable.

## Context

ADR-006 closed the worst defects from the v2.4.0 shape of the Worker — localhost bypass in prod, inconsistent header baseline, raw upstream error bodies, implicit URL construction. ADR-007 committed the zone-level posture (WAF, rate limit, DNSSEC, CAA, geo-block). Both were correct as far as they went. The 2026-04-17 audit found that going further required filling in the gaps *between* them: a handful of response headers the strip list missed, a client-side URL that was implicitly trusted because "Congress.gov wouldn't send us `javascript:`", a fetch without a timeout, a prototype lookup that pre-dated `Object.hasOwn`, a query-string passthrough that let an attacker fragment the shared cache, and an embed snippet that shipped without SRI.

Specifically, the audit observed:

1. **`x-ratelimit-limit: 20000` and `x-ratelimit-remaining: 19807` on 2xx `/api/congress/*` responses.** These proved the key exists and leaked the remaining budget, giving an attacker the signal needed to time a denial-of-wallet attack. Not covered by ADR-006's AC-27.3 strip list.

2. **Live prod accepting forged `Origin` headers.** This is by design — the spec deliberately uses Origin as a weak authenticator — but the consequence, in combination with no in-Worker rate limit and a zone rate limit at 100/min/IP (AC-28.3), was that the proxy behaved like an open gateway for anyone running `curl -H "Origin: https://trackukraine.com" …`. The proxy's intended threat model is browser traffic from a known embedder; 100/min/IP is three orders of magnitude looser than the widget's legitimate use (one lookup per visitor, ~7 upstream calls).

3. **`officialWebsiteUrl` rendered as `<a href={…}>` without scheme validation.** React 19 logs a dev-mode warning for `javascript:` URLs but still sets the attribute in production. If a Congress.gov compromise, an MITM on the proxy's own response, or a faulty roster-builder ever produces a non-http URL, a click fires script in the trackukraine.com origin. Cheap to fix; no reason to leave as-is.

4. **No `AbortSignal.timeout()` on upstream `fetch()`.** A slow upstream (or attacker holding connections open) ties up Worker concurrency until Cloudflare's 30s platform limit cuts the worker. The platform limit is a cliff; a proxy-side guard is a guardrail.

5. **`STATIC_FILES[key]` via plain-object property access.** `pathname.replace(/^\/+/, '')` on `/__proto__` yields `"__proto__"`, which returns `Object.prototype` (truthy), bypassing the guard and producing a malformed response. Not exploitable for RCE but an ugly failure mode.

6. **`upstreamUrl.search = url.search`** copies the full client query string, so `?nonce=1..N` forces N cache misses and N upstream fetches — cache-fragmentation DoS that drains Congress.gov quota without ever appearing as excessive per-request traffic.

7. **Upstream `Access-Control-Expose-Headers` not stripped.** The Worker was the authority for `Access-Control-Allow-*` but let upstream decide which response headers were exposed to JS. Minor but inconsistent — the Worker should be the sole authority on CORS surface.

8. **`.env` contains a live production-grade Congress.gov API key.** Not committed to git, but readable by every local process, every editor plugin, every AI assistant with file access. Would appear in crash dumps and backup tools.

9. **Embed snippet documented without SRI.** A compromise of the R2 bucket or Cloudflare account means arbitrary JS on trackukraine.com. SRI is the only mitigation a third-party embedder can apply.

10. **`ukraineVotes.json` / `ukraineBills.json` return 404 in prod.** Deployed state diverges from the spec's intent — the R2 bucket does not contain the JSON datasets the widget tries to fetch at runtime via `embed.tsx`.

11. **Production static-bundle response diverges from `handleStatic`.** Live prod returns `Content-Type: text/javascript` and `Cache-Control: public, max-age=0, must-revalidate`, neither of which matches the code. Some other deploy mechanism (Pages binding? R2 public URL? Transform Rule?) is serving the bundle. This is a spec/reality drift — either the code is dead, or the deploy is wrong.

## Decision

Add fifteen new ACs across FR-26 (deploy/release), FR-27 (Worker code), FR-28 (zone config), and a new FR-31 (client hardening + key-management process). Grouping by layer keeps each layer's ACs co-located so future readers of `proxy/lib.ts` can read AC-27.16…AC-27.22 without needing to understand client or zone concerns.

**FR-27 (Worker code): AC-27.16 through AC-27.22.**
- **AC-27.16** — expand the upstream-header strip list to include `Clear-Site-Data`, `Refresh`, `Content-Location`, and `/^x-ratelimit-/i`.
- **AC-27.17** — strip *all* upstream `Access-Control-*` headers; the Worker is the sole authority on CORS response headers.
- **AC-27.18** — 15 s `AbortSignal.timeout()` on upstream `fetch`, returning `504 Gateway Timeout` on trip.
- **AC-27.19** — `Object.hasOwn` guard for static-file lookup.
- **AC-27.20** — per-route query-parameter allowlist with canonical sort before forwarding and before cache-key derivation.
- **AC-27.21** — in-Worker per-IP rate limit via the Cloudflare Workers Rate Limiting API binding, 10/60s/IP in prod, tighter in stg, looser in uat/dev/preview. Defense-in-depth with the zone limit in AC-28.3.
- **AC-27.22** — cheap rejections (missing/bad Origin, unknown route, bad method) do not consume the rate-limit budget.

**FR-28 (zone config): AC-28.3 revision.**
- Tighten zone rate limit from 100/min/IP to 20/min/IP in prod (user requirement: "fairly strict … maybe probably once"), 20 in stg, 120 in uat, 1200 in dev. Layered with AC-27.21 so the blunt volumetric control runs at the edge before the Worker is ever invoked, and the fine-grained per-env control runs inside the Worker.

**FR-26 (deploy/release): AC-26.9 through AC-26.12.**
- **AC-26.9** — deploy workflow computes and publishes a SHA-384 SRI hash of the bundle.
- **AC-26.10** — integrator-facing snippet uses the SRI-pinned form with `crossorigin="anonymous"`.
- **AC-26.11** — R2 upload of all three static keys is part of the deploy contract; post-deploy smoke test asserts 200 on each.
- **AC-26.12** — the Worker's `handleStatic` is the authority for static assets; any other deploy mechanism is a spec violation.

**FR-31 (client hardening + key-management): AC-31.1 through AC-31.4.**
- **AC-31.1** — every URL from an external API is passed through `sanitizeUrl()` before becoming an `href`/`src`. Rejects `javascript:`, `data:`, `vbscript:`, `file:`, and anything that doesn't parse as `http(s):`.
- **AC-31.2** — `sanitizeUrl` is a dedicated helper in `src/utils/sanitizeUrl.ts` with unit tests covering the scheme list and malformed inputs.
- **AC-31.3** — `.env` never contains a prod key; `docs/deployment.md` documents the rotation procedure; dev keys are distinct from prod keys.
- **AC-31.4** — this ADR is append-only if new findings surface.

## Why an in-Worker rate limit on top of the zone rate limit

The zone rate limit (AC-28.3) and the Worker rate limit (AC-27.21) are not redundant:

- **Zone RL** runs at the Cloudflare edge, before the Worker is invoked. It blocks IPs that exceed the threshold — blunt, volumetric, free in Worker CPU time. Primary benefit: the attacker's traffic never consumes Worker invocations.
- **Worker RL** runs *inside* the Worker, after Origin validation, before upstream fetch. Benefits: (a) per-env thresholds are trivial to configure (just change the binding's `simple.limit` per env block in wrangler), (b) path-prefix-aware — future routes can have their own budgets without zone-rule changes, (c) survives zone-config drift — if someone accidentally disables the zone rule, the Worker still enforces a budget.

The in-Worker binding (via `ctx.rateLimit.limit({ key })`) is a first-party Cloudflare API, not a homegrown token-bucket-via-KV. It costs nothing extra, has built-in per-IP keying, and is the documented way to add per-request rate limiting from Worker code.

## Why the Worker RL budget is 10/60s/IP in prod

The widget's intended use is **a single address lookup per visitor**. One lookup fans out to:
- 1× `/api/census/*` (address → FIPS + district).
- 1× `/api/congress/v3/member?…&currentMember=true` (member list for district).
- 2-3× `/api/congress/v3/member/{bioguide}` (detail for each of house rep + two senators, sometimes 1 less for at-large).
- 1× `/api/congress/v3/member/{bioguide}/sponsored-legislation` (optional).
- 1× `/api/senate/legislative/LIS/…xml` (senate roll call data).

Worst-case ~8 requests per legitimate use, often fewer after the edge cache warms. 10/60s/IP gives a 25% buffer on a single completed lookup; a user who actually hits the limit is either (a) doing a second lookup within one minute (rare, but acceptable — the second lookup queues naturally on 429), or (b) an attacker. The limiter's tight fit to the legitimate pattern is the point — user requirement was "fairly strict … maybe probably once."

## Why tighten the zone RL to 20/min (not 100/min)

ADR-007 chose 100/min/IP as "comfortably above any legitimate usage and well below what would meaningfully drain our 5000-req/hour Congress.gov budget." That framing was correct but too lenient once we added the in-Worker 10/60s/IP gate: the *legitimate* upper bound is ~8 requests per visitor-minute, and 100/min was mostly a cushion against false positives. With the Worker-side gate as a finer control, the zone rule can run tighter without risk of blocking real users — 20/min is still a 2× cushion over the worst-case legitimate burst and catches diverse-IP attackers earlier.

The zone rule is the user's "at least in prod it should be fairly strict" requirement, realized.

## Why sanitize on the client when the data comes from an API

Defense-in-depth. The proxy normalizes error bodies (AC-27.5), strips fingerprinting headers (AC-27.3, AC-27.16, AC-27.17), and validates upstream paths (AC-27.7) — all good. But the proxy forwards 2xx upstream bodies verbatim by design, because rewriting JSON bodies is both expensive (parse-rewrite-reserialize per request) and fragile (shape changes upstream). That means the client *must* assume API responses can contain data that is structurally valid but semantically unsafe. Three paths can taint a URL field:

1. **Upstream compromise.** Congress.gov's public API is a government system; compromise is unlikely but not impossible.
2. **MITM on the widget's own proxy.** TLS makes this hard but not unreachable (e.g., compromised CF account, rogue issuer for cogs.it.com before CAA takes effect).
3. **Bad curator data.** The roster-build scripts fetch raw Congress.gov JSON and serialize into our own dataset; a future script that picks up `member.contactForm` or `member.otherWebsites[0]` without filtering could introduce an unexpected scheme.

A sanitizer at the render site costs one string check and makes *every* API URL safe by construction. No cleverness, no plumbing, no regret.

## Consequences

**Positive:**
- No `x-ratelimit-*` leak; denial-of-wallet attacks lose their timing signal.
- The Worker is the sole authority on every `Access-Control-*` response header.
- Upstream timeouts produce predictable 504s instead of saturating concurrency.
- Static-file lookups are prototype-safe.
- Cache-fragmentation DoS is closed at the Worker; cache keys are now semantic.
- In-Worker rate limit enforces a budget that matches the legitimate use pattern.
- Zone rate limit is tight enough to catch abusers early (20/min/IP).
- Every API-derived URL that the widget renders is sanitized.
- The prod key is never in `.env`; rotation is a documented, repeatable procedure.
- Integrators can pin the widget by SRI hash; R2 has the hash published alongside the bundle.

**Negative:**
- The Workers Rate Limiting binding is a Cloudflare-specific feature; porting the Worker off Cloudflare would require a replacement. Accepted — we're Cloudflare-native per ADR-005.
- The query-param allowlist is a bounded maintenance surface: new params require a spec amendment. Accepted — the allowlist is short, stable, and easy to update.
- SRI means every bundle redeploy breaks the integrator's embed until they copy the new hash. Mitigated by publishing the hash at `/voter-info-widget.iife.js.sri` so the integrator can automate fetch.
- Tightening to 20/min/IP will 429 a single user who reloads the page several times in a minute — a quality-of-life cost for a real-world-rare pattern.

**Neutral:**
- The `.env` rotation is a one-time operation plus a recurring discipline; the repo has no mechanism to enforce that a dev key differs from prod beyond documentation and code review. Matching enforcement (CI lint that greps committed files for known-prod-key prefixes) is out of scope for this ADR.

## Related

- **ADR-005** — Cloudflare deployment. This ADR assumes Cloudflare primitives (Workers, R2, Access, Rate Limiting binding).
- **ADR-006** — Proxy security hardening. This ADR extends that work with post-audit findings.
- **ADR-007** — Zone-level security posture. This ADR tightens AC-28.3 but leaves AC-28.1, AC-28.2, AC-28.4–AC-28.14 unchanged.
- **spec.md §FR-26, §FR-27, §FR-28, §FR-31** — ACs derived from this ADR.
