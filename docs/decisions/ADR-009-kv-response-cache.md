# ADR-009: KV Response Cache at the Proxy Layer

**Status**: Proposed
**Date**: 2026-04-17
**Deciders**: Kody
**Supersedes**: none
**Related**: ADR-005 (Cloudflare deployment), ADR-006 (proxy security hardening)

---

## Context

The widget's perceived slowness is driven almost entirely by **per-member Congress.gov calls** made on every lookup:

| Endpoint | When called | Typical latency | Calls per widget load |
|---|---|---|---|
| `/v3/member/{id}` (detail) | every rep after address resolution | ~300–600ms | 3 (two senators + one rep) |
| `/v3/member/{id}/sponsored-legislation` | when a chip is clicked | ~500–1500ms × up to 2 pages | up to 6 |
| `/v3/member/{id}/cosponsored-legislation` | when a chip is clicked | same as above | up to 6 |
| `/v3/senate-vote/{congress}/{session}/{rollcall}` | bundled roster miss (rare) | ~300–800ms | 0–N |
| `/v3/house-vote/.../members` | bundled roster miss (rare) | ~500–1000ms | 0–N |

Every single one of these is cold on every page load. The in-memory cache added to `useSponsoredBills` helps within a session but evaporates on reload.

### Why this is a proxy-layer problem, not a client-layer problem

Client-side caches (`Map`, `localStorage`, `IndexedDB`) help a single browser, one user at a time. They do nothing for the *second* user who looks up the same member ten seconds later — that person still pays the full Congress.gov round-trip. A proxy-layer cache, in contrast, amortizes one Congress.gov call across every visitor globally. For data that is either fully immutable (historical roll-call votes) or changes on human timescales (a member's sponsorship list), this is the correct layer.

### Why KV specifically (not Cache API, not Durable Objects, not D1)

| Option | Verdict | Reason |
|---|---|---|
| **Cache API** (`caches.default`) | ❌ | Colo-local, not global. Also aggressively evicted under pressure — no durability guarantee. Not appropriate for expensive upstream calls. |
| **Workers KV** | ✅ | Global replication, fully durable (survives deploys/restarts/secret rotations), optimized for high read / low write. Matches our access pattern exactly. |
| **Durable Objects** | ❌ | Strongly-consistent single-writer semantics are overkill; 10–100× the cost for a cache that doesn't need them. |
| **D1** (SQLite) | ❌ | Relational overhead for what is trivially a key→blob map. |
| **R2** (continues to serve roster JSONs) | — | Keep as-is. Better suited to the 790KB `ukraineVotes.json` blob than KV. ADR-005 §R2 unchanged. |

## Decision

**Add a Workers KV namespace — `KV_RESPONSE_CACHE` — as a read-through / write-behind cache in front of Congress.gov and Senate.gov upstream calls.** Each cacheable proxy route checks KV first; on miss, it fetches upstream, writes the response to KV with a TTL chosen per data class, and returns. R2 continues to serve the bundled roster JSONs unchanged.

## Data classes and TTLs

Drawn from the honest assessment that not all "static" data is equally static.

| Data class | Example endpoint | Mutability | TTL | Notes |
|---|---|---|---|---|
| **Immutable — historical roll-call votes** | `/v3/house-vote/{c}/{s}/{rc}/members`, `/v3/senate-vote/{c}/{s}/{rc}` (for any `{c}` whose session has ended) | A cast vote never changes. | `31536000` (1y) | Could be infinite, but a 1y ceiling bounds storage growth and lets a bad cache entry eventually self-heal. |
| **Near-immutable — member detail** | `/v3/member/{id}` | Members rarely change party, website, etc., but it does happen (Sinema, Manchin). | `2592000` (30d) | 30d is the sweet spot — fast enough on reuse, catches defections within a month. |
| **Mutable — sponsored/cosponsored lists** | `/v3/member/{id}/sponsored-legislation`, `/v3/member/{id}/cosponsored-legislation` | Members cosponsor new bills almost daily. | `86400` (1d) | A day-stale sponsorship list is acceptable for a voting-tracker widget; users aren't expecting real-time. |
| **Mutable — address geocode** | `/api/census/geocoder/geographies/onelineaddress` | Same address → same district until next redistricting (~10y). | `2592000` (30d) | Conservative. Redistricting is rare and our FIPS map + 119th layer name already pin us to a specific cycle. |
| **Current-session roll-call votes** | `/v3/house-vote/{c}/{s}/{rc}/members` where `{c}` is the *active* session | A roll call can be re-reported / corrected briefly after the vote. | `3600` (1h) | Lets corrections flow through within an hour. After the session ends, promote the same key to the 1y immutable class via a scheduled job (see "Invalidation"). |

**Rationale for huge-but-bounded TTLs**: you said "huge TTLs near-static." 1y on historical votes is the largest we can go before accepting storage-growth blindness; 30d on member detail is the largest we can go before missing a real party change. The two mutable classes (sponsorship lists, active-session votes) are deliberately short — their contents *do* shift on human timescales and a stale read there would actively mislead voters.

## Key schema

```
cache:v1:{classLabel}:{deterministicKey}
```

- **`cache:` prefix** — namespaces this cache within the KV namespace, in case we later add non-cache KV keys (feature flags, rate-limit counters).
- **`v1:` version** — schema version. Bumping this (to `v2:`) invalidates all cache entries in one edit, without deleting the namespace or touching upstream. Use when the response-shape parsing changes in a way that would make old cached bodies mis-parse.
- **`classLabel`** — `immutable-vote`, `member-detail`, `sponsored`, `cosponsored`, `census-geo`, `active-vote`. Makes manual invalidation by class possible (`list-by-prefix` + delete).
- **`deterministicKey`** — the URL path + sorted query-string, with `api_key` stripped (never cache on secret-bearing params). Example: `member/B001261/sponsored-legislation?limit=250&offset=0`.

Final example: `cache:v1:sponsored:member/B001261/sponsored-legislation?limit=250&offset=0`

## Storage model

**Store the serialized fetch body, not the fetch Response object.** Specifically a single JSON value:

```json
{
  "body": "<raw response body as string>",
  "contentType": "application/json",
  "status": 200,
  "cachedAt": 1744934400
}
```

- `body` is a string (not parsed JSON) so we don't pay a double parse/stringify on hit.
- `contentType` is preserved because Senate.gov responses are XML and we must not lie about that to the browser.
- `status` is stored so we can negative-cache 404s from Congress.gov (member bioguide typo → 404) with a short TTL rather than hammering upstream.
- `cachedAt` is a sanity field for debugging and for the optional "how fresh is this?" response header.

**Do not cache** responses with status ≥500, or bodies >900KB (KV's 1MB ceiling with headroom). Those bypass the cache and pass through to upstream.

## Write path

```
1. Compute cache key from request
2. Check KV (read is ~5–20ms globally)
3. Hit → return cached body, status, content-type. Add X-Cache: HIT, X-Cache-Age: <seconds>.
4. Miss → fetch upstream
5. If upstream 2xx and body ≤900KB → KV.put(key, payload, { expirationTtl })
6. Return upstream response. Add X-Cache: MISS.
```

**KV.put is asynchronous in the Worker model** — we don't block the response on the write. Use `ctx.waitUntil(kv.put(...))` so the user gets the response immediately and the cache fills in the background.

## Negative caching

A separate, short-TTL class for "we tried, got a non-retryable error":

| Upstream status | TTL | Rationale |
|---|---|---|
| 404 (member not found) | `3600` (1h) | Probably a typo'd bioguide; short TTL so a data-fix upstream gets picked up. |
| 429 (rate limited) | `60` (1m) | Back off, but don't memorize the 429 — the whole point is our limit has lifted. |
| 5xx | ❌ don't cache | Upstream failure; always retry. |

## Invalidation strategy

Three triggers:

1. **Version bump** — edit `v1` → `v2` in the Worker source. Redeploy. All old entries ignored. Use when response-parsing code changes incompatibly.
2. **Class purge** — on-demand script (`scripts/kv-purge.mjs --class sponsored`) that `list`s by prefix and deletes. Use when the curator `ukraineBills.json` rebuild might have changed what we care about.
3. **TTL expiration** — the passive path. Do nothing and entries naturally age out at the class-configured TTL.

**Promote current-session votes to immutable when a session closes.** Scheduled task (cron trigger in Worker) runs at the known session-end dates; rewrites the keys for that session with the 1y TTL. Alternative: just let the 1h TTL keep applying indefinitely — simpler, costs about 24 extra upstream calls per year per active-session vote. Probably fine.

## Per-environment bindings

Following `wrangler.toml`'s existing four-env layout:

```toml
# prod (default block)
[[kv_namespaces]]
binding = "KV_RESPONSE_CACHE"
id = "<prod-namespace-id>"

[env.stg]
[[env.stg.kv_namespaces]]
binding = "KV_RESPONSE_CACHE"
id = "<stg-namespace-id>"

[env.uat]
[[env.uat.kv_namespaces]]
binding = "KV_RESPONSE_CACHE"
id = "<uat-namespace-id>"

[env.dev]
[[env.dev.kv_namespaces]]
binding = "KV_RESPONSE_CACHE"
id = "<dev-namespace-id>"
```

**Each environment gets its own KV namespace**, same pattern as R2 buckets today. This preserves the stg-mimics-prod invariant from our earlier conversation — stg's cache reflects stg traffic only, not cross-contaminated with prod. For full parity, stg's `ukraineVotes.json` / `ukraineBills.json` should be synced from prod's R2 (separate task).

## Observability

Add three Worker-side metrics (structured log lines suffice — no need for a metrics service yet):

- `cache.hit` / `cache.miss` counts by `classLabel`
- `cache.write_failed` (KV write errors — rare, but we want to know)
- `upstream.latency_ms` — to prove the cache is actually buying us latency

Also expose on every response:
- `X-Cache: HIT|MISS|BYPASS`
- `X-Cache-Age: <seconds>` (0 on MISS)

This lets the browser DevTools Network tab tell you at a glance whether a slow request was a miss or a missed-cache bug.

## What stays unchanged

- **R2 still serves `ukraineVotes.json` + `ukraineBills.json`.** Blobs are the wrong fit for KV's sweet spot. ADR-005 unchanged.
- **`ASSETS` binding unchanged.**
- **CORS rules, `ALLOWED_ORIGINS`, `ALLOW_LOCALHOST` unchanged** (ADR-006 preserved).
- **API key injection unchanged** — keys are stripped before cache-key computation, added on upstream fetch, never stored in KV.
- **Client code unchanged** — every existing hook keeps calling its proxy URL. The cache is transparent to the client.

## Expected impact

Rough, order-of-magnitude numbers based on the current call profile:

| Scenario | Today | With KV cache |
|---|---|---|
| First visitor of the day looks up an address | ~3–10s | ~3–10s (cache miss on everything) |
| Second visitor hits same reps within 1 day | ~3–10s | **~200–500ms** (all hits on member-detail + bills) |
| Popular reps (e.g., Durbin, Cruz) across thousands of visitors | ~3–10s each | first visitor pays, everyone else fast |
| Same user reloads the page | ~3–10s | same as above — global cache helps them too |

**The "first visitor of the day" case does not get faster** — we can't skip the upstream call when we genuinely don't have the data. That's addressed by a *scheduled warmer* (a cron Worker that touches the N most-popular rep endpoints each morning), which is an optional follow-up, not part of this ADR.

## Consequences

**Positive:**
- Score + bills + votes become near-instant for any member the proxy has seen recently
- Congress.gov rate-limit headroom multiplies — we're asking them for the same data ~100× less often
- Widget embeds on third-party pages get the same benefit without any client changes
- Survives deploys, restarts, secret rotations — durability property you wanted

**Negative / risks:**
- Stale reads within TTL window (mitigated by conservative class TTLs)
- KV storage costs — trivial at our scale (CF's free tier covers 1GB stored, 100K reads/day; we'll be well under)
- One more moving part in the proxy; adds ~40 lines of Worker code and a `KV_RESPONSE_CACHE` binding to each env
- If KV is globally degraded (rare), requests fall through to upstream — same behavior as today, just slower paths take over

**Neutral:**
- Observable `X-Cache` headers expose cache behavior to clients. Fine — it's useful, not sensitive.

## Open questions (defer until implementation)

1. **Do we want a client-side `If-None-Match` / ETag handshake with the proxy?** Probably not for v1 — TTLs are long enough that the client's own `Map` cache is sufficient within a session.
2. **Scheduled warmer for popular reps?** Not v1. Revisit if metrics show a long cold-start tail.
3. **Per-embedder cache partitioning?** No — responses are origin-agnostic. CORS is enforced on the response, not keyed into the cache.

## Implementation task breakdown

(For later — not part of this ADR's decision.)

1. Create KV namespaces per env (one-time CF dashboard or `wrangler kv:namespace create`)
2. Add `KV_RESPONSE_CACHE` binding to all four env blocks in `wrangler.toml`
3. Add `proxy/cache.ts` implementing the read-through wrapper
4. Route-by-route: wrap the cacheable fetches; pass `X-Cache` headers through
5. Add observability log lines
6. Add `scripts/kv-purge.mjs` for operational invalidation
7. Test: unit tests on the cache module; integration test that second identical request gets `X-Cache: HIT`
8. Deploy dev → smoke → uat → stg → prod with the usual gate
