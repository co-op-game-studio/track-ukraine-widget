# ADR-014: Tiered Cache Architecture with R2 Static Tier

**Status**: Accepted
**Date**: 2026-04-19
**Supersedes (partial)**: ADR-009 (KV response cache — superseded by this ADR's KV tier, which is one of three composed tiers rather than a standalone system)
**Narrows**: ADR-011 ("KV is the sole datastore") — narrowed to "KV is the sole datastore for curator-projected domain records; R2 stores byte-level upstream archives of static responses."
**Traces to**: FR-40, FR-41

## Context

The proxy Worker has three overlapping caching mechanisms today:

1. **Cloudflare edge cache** (`caches.default`) — per-POP, driven by our `Cache-Control` headers.
2. **Ad-hoc KV write-through** in `handleMemberProfile` for `/api/members/{bioguideId}` — writes full member profiles on first fetch with a 30-day TTL.
3. **Curator-populated KV prefixes** (`bill:v1:*`, `roll-call:v1:*`, `member:v1:*`, `name-index:v1:*`, `roll-call-roster:v1:*`, `state-members:v1:*`) written by `scripts/publish-to-kv.ts` via GitHub Actions weekly.

Each lives in a different code path. The widget's per-visit fan-out depends on which caches happen to be warm. Cold-KV cold-edge requests fall all the way through to upstream Congress.gov / Senate.gov and hit rate limits — observed during the 2026-04-18 go-live. There is no single answer to "where does this response come from?"

The "curator" concept is also a smell: it is a shadow cache populated out-of-band by a Node script that reads from upstream, transforms, and writes to KV. The transform logic is duplicated by the Worker's own read-through code for `member:v1:*` — two independent implementations of "fetch Congress.gov, transform, store." Drift risk is real and has bitten us (`memberProfileParseResilience.test.ts` was added after such drift surfaced in prod on 2026-04-18).

Meanwhile, closed-session roll-call data (Senate XML, House rosters) is byte-level-static — it never changes after the Congress adjourns. We re-fetch it from senate.gov / api.congress.gov every time the edge + KV caches cycle, contributing directly to the 429 pressure.

## Decision

Unify all caching behind a single tiered cache layer with a `CacheTier<V>` interface implemented by three concrete tiers:

- **Tier 0: `EdgeTier`** — `caches.default`. Per-POP. Fastest. ~5ms.
- **Tier 1: `KvTier`** — `KV_VOTER_INFO`. Global. ~30ms. Holds both upstream-byte responses and curator-style domain records (they're structurally the same to the tier — `CacheEntry<V>`).
- **Tier 2: `R2Tier`** — `R2_STATIC` (new per-env bucket). Global, durable. ~50ms. **Only accepts writes where `policy.immutable === true` AND `entry.sessionStatus === 'frozen'`.** Everything else is silently skipped at the tier boundary.
- **Tier 3 (conceptual): upstream** — Congress.gov / Senate.gov / Census. Live. 400–1200ms. Rate-limited.

Composed by a `TieredCache<V>` class that:
- **Reads top-down.** Tier 0 first, stop at first hit.
- **Promotes on hit (write-back).** If tier 2 serves, write back to tiers 0 and 1 via `ctx.waitUntil` so the next request hits faster tiers.
- **Stores on miss (write-through).** When upstream serves, write to every writable tier whose policy allows, via `ctx.waitUntil`.

One pipeline function `serveCached(request, key, cache, fetcher, policy, ctx, env)` is the only code path any cacheable route uses. An `UpstreamFetcher<V>` interface abstracts the "get bytes from upstream" concern; one implementation per upstream.

**The curator is retired.** Prewarming (FR-35) becomes an ordinary client that issues `GET` requests to the Worker's public API, which populates all tiers via the standard `serveCached` pipeline. No separate transformation logic, no drift risk.

## Data-type eligibility (FR-41 matrix)

R2 is not a universal tier. It is gated to **byte-level-static upstream responses**:

- **Eligible (frozen after session close)**: Senate roll-call XML, House roll-call rosters, House roll-call details.
- **Eligible (age-gated)**: Bill actions and summaries where `latestActionDate` is >180 days old.
- **Ineligible (rotating)**: Member detail, member sponsored/cosponsored, census geocoder responses, bill metadata. These flow through tiers 0–1 only.
- **Not cache data**: Curator-projected domain records (`member:v1:*`, `bill:v1:*`, etc.). These live in KV as the owner store, not the cache tier — same backing, different abstraction layer. R2 is not involved.

Session-status is computed at fetch time by the upstream fetcher via a `currentCongress`/`currentSession` helper keyed off today's date.

## Alternatives considered

**Write-through from Worker into R2 on every upstream fetch.** Rejected as the primary population path. The Worker's `ctx.waitUntil` budget is limited (30s), and an opportunistic write-back adds latency-tail risk on the request that first reaches upstream. Instead: `storeFromUpstream` writes to R2 when the policy says so, but the bulk of R2 population happens via the prewarm client, which is synthetic traffic with no user-latency cost.

**R2 as a datastore (reverse ADR-011).** Rejected. ADR-011's reasoning still holds: KV is the right store for structured, keyed domain records because its get-by-key latency (~30ms global) and cost model fit that access pattern. R2 is for large, infrequently-written byte blobs where durability + cost-per-GB matters. These are different abstraction layers; both can coexist.

**Keep the curator.** Rejected on composition grounds: the curator's existence was a workaround for the absence of a real cache layer. With FR-40, the reason to have a curator evaporates — the cache has everything the curator used to do, reachable through the same code path.

**Four tiers (add an in-memory Worker-instance cache).** Rejected for v2.6.0. Workers are instanced per-POP-per-isolate with unpredictable lifetimes. An in-memory LRU gives ~0ms hits when hot but measurably hurts tail latency when cold (cold-start adds ~50ms of allocation). `caches.default` already fills this role for 95% of the benefit with no isolate-lifetime cliff.

**Per-response bespoke caching (status quo).** Rejected. That is what produced the current god-module. The whole point is to compose.

## Consequences

### Positive

- One answer to "where does this come from?" — the `X-Cache-Tier` header.
- 429 pressure from upstream Congress.gov / Senate.gov drops for static data once R2 is populated.
- Curator script retired; curator/Worker drift risk eliminated by construction.
- Prewarming is trivially testable: it's just HTTP requests.
- Tier implementations are swappable; adding a future tier (e.g., "Durable Objects regional cache") is additive, not invasive.

### Negative / costs

- Refactor touches every route handler. Every `/api/*` path migrates to `serveCached`. Estimated ~2 weeks of implementation + test rewrite if done atomically; can be staged by route family.
- R2 binding + bucket provisioning is a manual step per env (AC-41.11, fail-loud if missing).
- New concept surface area for contributors: they now need to understand `CacheTier`, `TieredCache`, `UpstreamFetcher`, `CacheConfig`. Mitigated by the fact that most routes are one-liners against this infrastructure.
- Tests must be split to match the new module layout (FR-42 AC-42.2 — no file >300 lines, applies retroactively to `worker.test.ts`).

### Cost (R2 storage)

~13 MB per env of archive bytes. Four envs = ~52 MB. At $0.015/GB/month that's **<$0.001/month total.** Egress within CF is free. Cost is not a factor.

### Rollout gotchas

- R2 bucket names must be globally unique at creation time. Namespace them `voter-info-widget-archive-${env}`.
- First prewarm run against a cold R2 bucket + cold KV will hit upstream once per eligible key; pacing at 4 concurrent + 250ms delay keeps us well under Congress.gov's observed 429 threshold.
- If an env's R2 bucket is ever emptied (accidental `wrangler r2 bucket empty`), the next wave of requests for static data falls through to upstream and re-populates. No permanent damage; just a temporary latency blip.

## Implementation references

- `proxy/cache/tier.ts` — interface definitions
- `proxy/cache/tiered-cache.ts` — composition logic
- `proxy/cache/edge-tier.ts`, `kv-tier.ts`, `r2-tier.ts` — concrete implementations
- `proxy/cache/pipeline.ts` — `serveCached` function
- `proxy/routes/cache-config.ts` — per-route CacheConfig map
- `proxy/upstreams/*` — one file per upstream fetcher

## Related

- ADR-013 (observability): tier served is recorded in `X-Cache-Tier` header and the `cacheTier` AE blob.
- ADR-015 (proxy module refactor): this ADR's tier implementations live within the refactored module topology.
- ADR-011 (KV sole datastore): narrowed, not superseded. KV is still the sole store for domain records.
- ADR-009 (KV response cache): superseded by the KV tier here.
