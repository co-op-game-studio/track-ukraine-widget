# ADR-011: KV as Sole First-Class Datastore

**Status**: Accepted
**Date**: 2026-04-17
**Deciders**: Kody
**Supersedes**: ADR-005 §R2 (R2 bucket for bundled rosters), ADR-010 (name-index as separate pipeline)
**Amends**: ADR-009 (KV response cache — now shares namespace with first-class records)

---

## Context

Three prior decisions each made sense in isolation but together produce an incoherent storage story:

- **ADR-005** put the widget bundle + curated data (`ukraineVotes.json`, `ukraineBills.json`) on R2, served via the Worker's `ASSETS` binding.
- **ADR-009** added a KV namespace (`KV_RESPONSE_CACHE`) as a response cache in front of Congress.gov — explicitly *not* touching R2 blobs.
- **ADR-010** (draft) proposed a *second* KV pipeline for a name-search index, building a separate per-letter shard structure.

The result: three storage layers (R2 blobs, KV response cache, KV name index) each with its own read path, its own write path, its own invalidation story, and two of them duplicating member metadata.

The root issue with R2 blobs: **the widget fetches ~790KB of roster data on boot to serve ~45 cast lookups per user.** Per-member atomic reads would fetch ~1KB per member. The 99% waste comes from KV not being on the table when FR-24 was designed.

## Decision

**KV is the sole first-class datastore.** R2 is removed entirely. All curated content — member profiles, bills, roll-call metadata, name-search indices — lives in one KV namespace (`KV_VOTER_INFO`) under prefix-scoped key schemas. The widget bundle itself is served via Worker Sites (static-asset binding), not R2, not KV.

This collapses the three-layer story into: **curator writes atomic records → Worker reads atomic records → widget receives one record per rendered surface.**

## Atomic unit: `member:v1:{bioguide}`

The per-member profile is the atomicity point. One `KV.get` returns everything the widget needs to render a rep card:

```json
{
  "bioguideId": "D000563",
  "first": "Richard",
  "last": "Durbin",
  "officialName": "Durbin, Richard J.",
  "state": "IL",
  "district": null,
  "chamber": "Senate",
  "party": "D",
  "photoUrl": "https://www.congress.gov/img/member/...",
  "website": "https://www.durbin.senate.gov",
  "searchKey": "durbin",
  "ukraineVotes": [
    {
      "rollCallId": "senate:118:2:154",
      "cast": "Yea",
      "date": "2024-02-13",
      "billId": "HR815",
      "question": "On Passage of the Bill",
      "result": "Passed",
      "weight": 3,
      "billTitle": "Making emergency supplemental appropriations..."
    }
  ],
  "ukraineScore": {
    "value": 92,
    "totalWeighted": 15,
    "supportWeighted": 14,
    "obstructionEvents": 0,
    "didNotServeCount": 0
  },
  "sponsored": [
    {
      "billId": "S123",
      "title": "A bill to...",
      "introducedDate": "2024-03-01",
      "latestAction": "Referred to Committee on Foreign Relations",
      "latestActionDate": "2024-03-02"
    }
  ],
  "cosponsored": [ ... ],
  "generatedAt": "2026-04-17T09:00:00Z",
  "schemaVersion": 1
}
```

**Duplication is deliberate.** A bill's title lives inside every member record that voted on it, sponsored it, or cosponsored it. ~50KB per member × ~540 members ≈ 27MB total storage. KV charges trivially at this scale, and the read-path simplicity is worth the duplication: no fan-out, no joins, no staleness skew between tables.

**The canonical bill record (`bill:v1:{billId}`) is still the source of truth.** When a bill's title changes, the curator updates `bill:v1:{billId}` and then re-propagates into every member record that references it. Denormalization is consistent because one writer (the curator) owns both sides.

## Key schema (four prefixes + one cache)

```
member:v1:{bioguide}                          → MemberProfile (atomic read unit)
bill:v1:{billId}                              → BillRecord (canonical bill metadata)
roll-call:v1:{chamber}:{c}:{s}:{rc}           → RollCallMeta (question, date, result, totals)
name-index:v1:{letter}                        → NameIndexShard (derived lookup for search)
cache:v1:{class}:{deterministicKey}           → ADR-009 response cache (unchanged)
```

**Rationale for each prefix:**

- `member:v1:*` — the primary atomic read. The widget's rep-card render requires exactly one of these.
- `bill:v1:*` — canonical metadata. Referenced from multiple member records. Lets tools reason about a bill's identity without scanning members.
- `roll-call:v1:*` — canonical roll-call metadata (question text, vote totals, date). Referenced from `ukraineVotes[].rollCallId` inside member profiles. Enables a future "all members' votes on this roll call" view without re-scanning members.
- `name-index:v1:*` — derived index for name search. Rebuilt by the curator as a by-product of writing member records. Not a separate pipeline.
- `cache:v1:*` — ADR-009's response cache. Unchanged from ADR-009. Coexists in the same namespace because the prefix is non-overlapping and the TTL/purge stories are independent.

**Schema version.** Every prefix carries its own `v1:` version. A schema breaking change for `member:*` bumps to `member:v2:*` without disturbing `bill:*` or `cache:*`. The Worker reads the current version; old records age out on TTL (or get purged manually).

## Derived name-search index

Name-search queries the widget supports (FR-31):

- Type `"durb"` → dropdown shows Durbin, IL, Senate
- Type `"van ho"` → Van Hollen, MD, Senate
- Type `"cast"` → Castro (TX, House), Castor (FL, House), etc.
- Both first- and last-name fragments match
- Live, debounced, updates as the user types

**Implementation**: `name-index:v1:{letter}` holds a JSON array of entries for every member whose first OR last name starts with `{letter}`. A member named "Mark DeSaulnier" appears in both `m` (first="Mark") and `d` (last="DeSaulnier"). Worst-case dedup happens at the Worker, not the client.

```json
{
  "letter": "d",
  "generatedAt": "2026-04-17T09:00:00Z",
  "entries": [
    {
      "bioguideId": "D000563",
      "displayName": "Richard J. Durbin",
      "first": "Richard",
      "last": "Durbin",
      "state": "IL",
      "chamber": "Senate",
      "party": "D",
      "searchKeys": ["richard", "durbin"]
    }
  ]
}
```

**Why sharded by letter, not a single "all names" key.** ~540 entries fit in one KV value, but splitting them 26 ways gives the Worker a smaller working set per keystroke (reads only the shards relevant to the query's first letter) and gives KV a smaller hot-key surface. It also bounds growth — if we ever add former members, the shards stay well under the 25MB KV value ceiling.

**Why not build the index by first-letter-of-last-name only?** FR-31 calls for first *and* last name matching. A voter typing `"tammy"` should see Tammy Baldwin and Tammy Duckworth. The simplest way: index by every `searchKey`'s first letter, let a member appear in multiple shards.

**Worker match rule**: substring on normalized `searchKey` (lowercase, diacritics stripped, apostrophes/hyphens removed). Ranked prefix-matches first, then other substring matches, then by chamber-then-state. Top 10 results returned.

## Worker routes

```
GET /api/members/{bioguide}              → member profile
GET /api/name-search?q=<query>           → search results (top 10)
GET /api/bills/{billId}                  → bill detail
GET /api/roll-calls/{chamber}/{c}/{s}/{rc} → roll-call metadata
```

Plus the existing ADR-009-cached routes for live Congress.gov / Senate.gov / Census calls (unchanged behavior).

**All routes pass through ADR-006 hardening** — origin allowlist, method check, security headers, upstream fingerprint stripping (where applicable).

**`/api/members/{bioguide}` and `/api/name-search` do not cache under ADR-009's `cache:*` prefix.** They read from `member:*` / `name-index:*` directly. These records are pre-built by the curator and have no upstream to fetch from on miss.

**404 semantics**: if `member:v1:{bioguide}` doesn't exist, the Worker returns `404 {"error":"member-not-found","bioguideId":"X000000"}`. The widget UI shows an appropriate error state — the lookup did not match a current member.

**503 semantics**: if `name-index:v1:meta` (generation-timestamp sentinel) indicates the index has never been built, the Worker returns `503 {"error":"index-not-ready"}` and the widget disables the name-search input with a hint message.

## Curator ownership

The curator (`scripts/build-curated-bills.ts` + `scripts/build-vote-rosters.ts` + `scripts/publish-to-kv.mjs`) is the *only* writer of `member:*`, `bill:*`, `roll-call:*`, and `name-index:*` keys. The Worker never writes to these prefixes.

The Worker *does* write to `cache:*` (ADR-009 response cache). This separation is enforced by inspection: any Worker code that does `env.KV_VOTER_INFO.put(k, ...)` must check `k.startsWith('cache:v1:')`. Captured as AC-32.5.

**Curator output pipeline**:

```
1. build-curated-bills.ts
   - Fetches current curated bill list from source (existing logic)
   - Writes each bill to in-memory BillRecord[]

2. build-vote-rosters.ts
   - For each curated vote, fetches roll-call detail + all members' casts
   - Writes in-memory RollCallRecord[] and per-member cast entries

3. build-member-profiles.ts (new — replaces roster-blob writer)
   - Fetches /v3/member?currentMember=true (all current members)
   - Joins member detail + their ukraineVotes + sponsored/cosponsored bills
   - Emits in-memory MemberProfile[]

4. publish-to-kv.mjs (new)
   - For each record: KV.put(key, JSON.stringify(record), { metadata: { schemaVersion, generatedAt }})
   - Writes bill:*, roll-call:*, member:*, name-index:* keys
   - Finally writes the generation sentinel: name-index:v1:meta (signals "index ready")
   - Idempotent: re-running overwrites. Partial completion is acceptable (Worker reads whatever's there).
```

**Write order matters for consistency**. Records that are *referenced by* other records are written first:

```
bills → roll-calls → members → name-index shards → name-index:v1:meta (sentinel last)
```

A partial curator run leaves an old `name-index:v1:meta` in place if the sentinel step didn't execute; the Worker continues serving the previous-generation index. This is the same copy-then-swap discipline as the R2 approach, just at the record level.

## Read patterns

**Address-lookup flow** (existing entry point, rewired):

```
1. User enters address
2. Widget → /api/census/... → state + district (Census geocode, ADR-009 cached)
3. Widget → /api/congress/member?state=IL (ADR-009 cached)
4. For each rep bioguide: Widget → /api/members/{bioguide} (atomic KV)
5. Render three rep cards with everything already loaded
```

Eliminates the `initRosters()` bulk fetch entirely. The `/api/members/{bioguide}` response contains the ukraineVotes, ukraineScore, sponsored/cosponsored — so the separate `useSponsoredBills` / `useVotingRecord` hook fetches become client-side filters over an already-present record, not new network calls.

**Name-search flow** (FR-31):

```
1. User types "durb"
2. Widget (debounced 150ms) → /api/name-search?q=durb
3. Worker reads name-index:v1:d shard, filters, returns top 10
4. Widget renders result list
5. User clicks "Richard J. Durbin"
6. Widget → /api/members/D000563 (atomic KV)
7. Render Durbin's rep card
```

Same endpoint, same render path as address lookup step 4. Unified card renderer.

## Size and cost envelope

| Prefix | Est. record count | Est. size per record | Est. total |
|---|---:|---:|---:|
| `member:v1:*` | ~540 | ~50KB | ~27MB |
| `bill:v1:*` | ~200 (curated only) | ~5KB | ~1MB |
| `roll-call:v1:*` | ~50 (curated roll calls) | ~2KB | ~100KB |
| `name-index:v1:*` | 26 shards + meta | ~20KB | ~500KB |
| `cache:v1:*` | bounded by TTL | varies | ~50MB ceiling |

**Total: comfortably under 100MB.** KV free tier covers 1GB. Operational cost remains zero at our scale.

**Reads per widget load**:

- Address path: 3× `/api/members/` = 3 KV reads at ~10ms each (parallel) ≈ 15ms total
- Name-search keystroke: 1× `/api/name-search` = 1 KV read + filter ≈ 10ms
- Name-search selection: 1× `/api/members/` = 10ms

Compare today: 1× R2 fetch of 790KB blob (~150ms to start, ~500ms to parse) + 3-6× Congress.gov calls for sponsored/cosponsored (~500-1500ms each).

**Order-of-magnitude improvement**: cold widget load goes from ~3-10s to ~200-500ms.

## Removed items

- **R2 bucket `voter-info-widget-assets*`** — deleted (one per env) after PR merges and dev/uat/stg/prod are verified
- **`[[r2_buckets]]` bindings in `wrangler.toml`** — removed from all four env blocks + preview block
- **`src/data/ukraineBills.json`, `src/data/ukraineVotes.json`** — deleted from src (regenerated into KV, not into files)
- **`src/services/bundledRosters.ts` + `initRosters()`** — deleted
- **R2 asset-serving logic in `proxy/worker.ts`** — removed
- **`scripts/sync-stg-data.mjs` (T-025d)** — becomes KV-prefix sync instead of R2 copy

## Migration plan (clean cut, not dual-run)

Per user direction: clean cut, no dual-write, no gradual migration.

1. Merge this PR into `develop` → auto-deploys to dev
2. Run `npm run publish:kv -- --env dev` to populate dev KV
3. Smoke test dev (browser): widget loads, address lookup works, name-search works
4. Merge `develop` → `uat`. Deploy. Run publish. Smoke.
5. Merge `uat` → `stg`. Deploy. Run publish + T-025d stg-sync rehearsal. Smoke.
6. Merge `stg` → `prod`. Deploy. Run publish. Smoke.
7. **Delete R2 buckets** (manual, Cloudflare dashboard, after 48h of prod stability)

Rollback path: revert the PR, redeploy. R2 buckets remain for 48h post-merge as a safety net.

## Consequences

**Positive:**

- Single storage system. One mental model, one binding, one purge tool, one backup story
- Widget boot drops from ~790KB download to zero-pre-fetch; cold-load latency improves by ~5-20×
- Per-record atomicity means curator updates are incremental, not "regenerate the whole blob"
- Name-search becomes a read, not a client-side filter of a downloaded list
- T-025d stg-sync becomes simpler (KV list-by-prefix + put vs. R2 object-level copy-then-swap)
- Free-tier KV covers us indefinitely at current scale

**Negative / risks:**

- Denormalization: a bill's metadata is duplicated across every member record that references it. Curator must rewrite all affected member records when a canonical bill changes. At our scale (~200 bills × ~540 members × sparse references) this is still seconds of work.
- Curator becomes a more complex pipeline (build-member-profiles step joins three sources before writing). Already expected.
- KV eventual consistency: a `put` is visible within ~60s globally, not instantly. A user landing on the widget within 60s of a curator run may get a mix of old + new records. Acceptable — our curator runs nightly and the widget is read-only.
- R2 as a fallback store is gone. If KV is globally unavailable (rare), the widget has no data to serve. Today's behavior: widget falls back to live Congress.gov calls through the Worker (without roster optimization). With this ADR: same fallback — the `/api/members/{bioguide}` endpoint returns 503, widget shows "temporarily unavailable". Operationally equivalent.

**Neutral:**

- KV namespace binding renamed from `KV_RESPONSE_CACHE` (ADR-009) to `KV_VOTER_INFO` to reflect its broader role. One-line change in Worker code + wrangler.toml.
- `ASSETS` binding (Worker Sites) still serves the widget bundle and `index.html`. Not affected.

## Open questions (deferred)

1. **Per-member generation timestamp for cache-busting the widget's in-memory cache?** Probably not v1 — the widget re-fetches on each lookup and lives within one render cycle.
2. **Compression at rest?** KV doesn't do it natively. Our records are ~50KB uncompressed; not worth pre-gzipping.
3. **Historical-member lookup (former reps)?** Out of scope for v1. Would be a `former-member:v1:{bioguide}` prefix if we add it.
4. **Per-embedder quota / rate limiting on `/api/name-search`?** Zone-level rate limit from ADR-007 covers it. If search becomes hot, revisit.
