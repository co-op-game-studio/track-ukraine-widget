# ADR-019: Edge-Tier Cache Key Must Be Injective on (kind, params)

**Status**: Accepted
**Date**: 2026-05-25
**Deciders**: Kody
**Related**: FR-40 AC-40.11 (new), ADR-014 (Tiered Cache + R2 Static Tier)

---

## Context

On 2026-05-25 a production regression was reported on the embed at `trackukraine.com`: after a first successful address lookup, subsequent address lookups returned the **first lookup's** result set even though a different address was submitted. The bug was observed end-to-end (user sees Illinois reps for a Washington, DC address) and reproduced against the live `vote.cogs.it.com` Worker by issuing two consecutive `/api/census/geocoder/geographies/onelineaddress` requests with distinct `address=` query strings.

The second request returned `X-Cache: HIT, X-Cache-Tier: edge` with a response body whose `input.address.address` field literally echoed the *first* request's address. The defect was therefore in the edge tier of the unified tiered cache (FR-40), not in the upstream, not in the widget, and not in KV.

### Root cause

`proxy/routes/api-upstream.ts` constructs the `EdgeTier`'s `keyToUrl` adapter inline at request time:

```ts
new EdgeTier<string>(cache, (k: CacheKey) => {
  const u = new URL(`${route.target}/${upstreamPath}`);
  u.pathname += `#${k.kind}`;
  return u;
}),
```

This adapter takes the inbound request's pathname (e.g., `/geocoder/geographies/onelineaddress`) and appends `#${k.kind}` (e.g., `#census-geocoder`) as a URL fragment. **It never references `k.params`.** For every route whose identity lives in the URL pathname — `/v3/house-vote/{c}/{s}/{rc}`, `/v3/member/{bioguideId}`, `/v3/bill/{c}/{type}/{num}/actions`, the Senate XML path — this is harmless: the pathname is already uniquely identifying. `/api/census/*` is the lone route whose identity lives in the **query string** (the `address` parameter), and that identity was being silently discarded.

The result: the first POPULATED address lookup at each Cloudflare POP "claimed" the edge cache entry for the geocoder endpoint, and every subsequent geocoder request at that POP was served the same cached response — until the rotating-policy `max-age` expired, at which point the *next* first lookup re-claimed the slot.

The bug was not caught by the existing tests in `tests/unit/routes/query-and-cache.test.ts` because that suite asserts the *opposite* invariant (unknown query params SHOULD NOT fragment the cache key — AC-27.20) but never asserted the dual invariant (allowed query params MUST fragment the cache key). The KV tier's serializer (`cacheKeyToDottedString`) does include `params` correctly, so unit tests of the KV tier passed; the integration-level interaction between `api-upstream.ts`' edge adapter and the census route was unobserved.

### Why this is architecturally significant

The tiered-cache contract (FR-40) is built on the assumption that all three tiers agree on which `CacheKey`s are "the same." A tier whose native key derivation collapses structurally non-equal `CacheKey`s into the same address violates that contract and produces wrong-answer cache hits — the worst kind of cache bug, because it succeeds silently and serves stale-and-irrelevant data with normal `200 OK` semantics and HIT cache headers. No log, no alarm, no observable failure mode short of a user reading the wrong reps and noticing.

This invariant deserves an explicit AC and an ADR because it generalizes: any future route added to `cache-config.ts` that carries identity in the query string (think: a future search endpoint, a date-ranged historical query, a geographically scoped statistics endpoint) will be vulnerable to the same defect unless the edge-tier adapter is *systematically* required to incorporate `params`.

## Decision

The edge-tier `keyToUrl` adapter SHALL be required, by FR-40 AC-40.11, to incorporate both `key.kind` and a canonical serialization of `key.params` into the URL it produces. The chosen encoding is to encode the kind+params dotted string (the same form used by the KV tier via `cacheKeyToDottedString`) as a query parameter on the synthetic cache URL, e.g.:

```
https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?__ck=census-geocoder:path=geocoder%2Fgeographies%2Fonelineaddress:qs=address%3D1600+Pennsylvania...
```

Using the existing `cacheKeyToDottedString` (already exported from `proxy/cache/key.ts`) gives us:

- **One serialization function** shared across tiers (DRY, single point of audit).
- **Stable ordering** (the function sorts param keys alphabetically).
- **Sanity at log time** — the `X-Cache-Tier: edge` cache lookup uses the same identifier string that appears in KV.

The synthetic URL still includes the real upstream host + path *as the URL base* so logs and Cloudflare's per-zone cache analytics group census-geocoder edge entries in an intelligible way; the `__ck` query param is the part that actually distinguishes entries.

The `#${k.kind}` fragment is dropped — fragments are not transmitted to the server, are stripped by some `Request` constructors, and were the original locus of the bug. Encoding in the query string is robust and inspectable in Cloudflare's cache analytics.

## Consequences

**Positive:**
- Census address lookups produce the correct rep list on every call. Bug fixed.
- Future query-string-identity routes get the invariant for free at the policy layer — adding a new `CacheKind` to `cache-config.ts` no longer requires a parallel audit of `api-upstream.ts`' edge adapter.
- The invariant is now testable via a single AC-40.11 regression test plus the dotted-string property test in `tests/unit/cache/key.test.ts`.

**Negative:**
- Existing edge cache entries for census-geocoder are orphaned (they live under the old fragment-only URL, never read again). No correctness impact — they expire naturally per `ROTATING_POLICY.maxAge`. Storage cost is negligible.
- The synthetic URL is longer (~150 chars vs ~80 chars). No practical impact: Cloudflare's edge cache key has no length-sensitive performance cliff in this range.

**Neutral:**
- The current production fleet running the buggy adapter will continue to serve wrong responses until the next deploy. The fix MUST ship as a hotfix (not a queued release) given the customer-visible breakage.

## Alternatives considered

1. **Encode `params` in the URL fragment alongside `kind` (e.g., `#census-geocoder?qs=address%3D...`).** Rejected: fragments are inconsistently preserved by `Request` constructors and `caches.default.put(url, resp)`, and at least one prior reading suggested Cloudflare's Cache API normalizes fragments out. Even if it works today, query-string encoding is the more durable choice.

2. **Add an `address`-aware special case to the census route only.** Rejected: addresses the symptom, not the invariant. The next route that carries query-string identity will hit the same bug.

3. **Drop the `caches.default` tier entirely and rely on KV + R2.** Rejected: the per-POP ~5ms edge hit latency is the dominant cache benefit for high-traffic routes; losing it would increase median latency 6–10x for already-warm responses.

4. **Use `cacheKeyToDottedString` directly as the cache URL pathname.** Rejected (mild): synthetic URLs like `https://internal.cache/census-geocoder:path=...:qs=...` are inscrutable in Cloudflare cache analytics. Keeping the real upstream host+path as the URL base preserves analytics legibility.

## Verification

- A new regression test (`tests/unit/routes/query-and-cache.test.ts` → "two distinct addresses MUST issue two upstream calls") fails on the current code, passes after the fix.
- An invariant property test (`tests/unit/cache/key.test.ts`) asserts the dotted-string serialization is injective on `(kind, params)`.
- Manual verification post-deploy: two consecutive `curl` requests to `/api/census/geocoder/geographies/onelineaddress` with different `address=` values SHALL return responses whose `input.address.address` fields each echo the corresponding submitted address. The current production behavior (incorrect) is captured in trace IDs `tr_6e4856405c7e463e` (Cloudflare cache log evidence) and reproducible against `vote.cogs.it.com` for posterity.
