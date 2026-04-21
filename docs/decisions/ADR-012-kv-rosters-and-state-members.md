# ADR-012: KV-Backed Roll-Call Rosters and State-Members Directory

**Status**: Accepted
**Date**: 2026-04-18
**Deciders**: Kody
**Amends**: ADR-011 (extends the "KV as sole first-class datastore" decision to close the remaining per-visitor upstream-fan-out gap)
**Amends**: ADR-007 (rate-limit posture — numeric limits revised in spec AC-27.21 v2.5.2 and rationale depends on this ADR landing)

---

## Context

ADR-011 committed to KV as the sole first-class datastore for widget-facing data, with edge caching as a pure performance optimization. The v2.5.1 and v2.5.2 implementations delivered this for most data families (bills, roll-call metadata, name-search index, and — with the caveat documented in the ADR-011 addendum — member profiles).

**The remaining gap:** two classes of data the widget needs on every rendered surface were still resolved by live upstream calls through the Worker proxy:

1. **Per-roll-call rosters.** When the widget renders a member's Ukraine voting record, it calls, for each curated vote, either:
   - `/api/congress/v3/house-vote/{congress}/{session}/{rollCall}/members?limit=500` (House — Congress.gov API), or
   - `/api/senate/legislative/LIS/roll_call_votes/vote{c}{s}/vote_{c}_{s}_{rc}.xml` (Senate — Senate.gov XML).

   At the current curator count of 18 House + 26 Senate Ukraine votes, opening a single rep's detail pane triggers **19-27 upstream fetches** on a cold edge cache. On 2026-04-18 this produced observable 429 pressure on prod and blocked the go-live until cache warming + rate-limit bumps partially mitigated it.

2. **Per-state member directory.** `useAddressLookup` calls `/api/congress/v3/member/congress/{congress}/{state}/{district}?currentMember=true` and `/api/congress/v3/member/congress/{congress}/{state}?currentMember=true&limit=250` to resolve the state's senators + house rep. Both are low-volume per-visit (two calls total) but they're still per-visitor upstream round-trips against Congress.gov on cold edge cache.

Both data classes are **historical and stable** (rolls never change post-vote; current-Congress membership changes on election-cycle timescales) and are a strict subset of the data the curator already fetches to build `bill:v1:` and `roll-call:v1:` records. There is no principled reason to resolve them live at widget render time; they should live in KV.

### Why this matters beyond perf

The 2026-04-18 go-live exposed that the rate-limit posture (AC-27.21, AC-28.3) was tuned against an obsolete per-visit fan-out estimate. Raising the limits to absorb the real fan-out is a stopgap — it works today but it scales badly as the curator adds more Ukraine votes, because each new curated vote linearly increases the per-visit fan-out floor. Moving rosters into KV **decouples the rate-limit posture from the curated-vote count**: the widget makes one KV read per vote instead of one Congress.gov fetch, so the real per-IP resource cost of a visit stops scaling with the curator's curation depth.

Said differently: without this ADR, every new curated vote raises the rate-limit floor for legitimate traffic. With this ADR, the rate-limit floor is determined by the widget's KV-read rate, which the curator cannot inflate.

### Alternatives considered

**A. Raise the rate limit indefinitely.** Simple, already done as a stopgap (AC-27.21 v2.5.2 = 300/60s). Does not scale with curated-vote count. Rejected as a long-term posture.

**B. Pre-warm edge cache post-deploy for the upstream routes.** `scripts/warm-member-cache.mjs` already does this for the House and Senate roster endpoints. It moves the cold-visit cost off the critical path but:
- The upstream routes still cost real Congress.gov / Senate.gov requests during warming. Shared across deploys but still upstream-proportional to curated-vote count × deploys.
- The Cloudflare edge cache is tier-ed by POP; a "warm" central cache doesn't help a visitor routed to a less-trafficked POP. KV's globally-replicated reads do.
- Warming is a post-deploy operational burden that has to be re-run on config drift (e.g., the `api_key` being rotated invalidates the Worker's outgoing upstream requests and thus the cached responses keyed to them).

**C. Move the rosters and state-members into KV (this ADR).** Curator does the upstream work once per run; widget reads KV. Aligns with ADR-011's stated principle. Marginal additional work for the curator (the member directory is already fetched; roll-call rosters are new calls but already required by the roster-warmer script).

Option C is the principled fix.

## Decision

**Add two new KV prefixes, each with a corresponding Worker route. The widget SHALL use the KV routes for roll-call rosters and state-member lookup. The existing upstream pass-through routes SHALL remain available for curator, admin, and debugging use but SHALL NOT be called by the widget in steady state.**

### `roll-call-roster:v1:{chamber}:{congress}:{session}:{rollCall}`

- **Writer:** curator (`scripts/publish-to-kv.ts`). Walks every `votes[]` tuple in `src/data/ukraineBills.json`; for each House vote, fetches `https://api.congress.gov/v3/house-vote/{c}/{s}/{rc}/members?limit=500&format=json&api_key=<curator-key>`; for each Senate vote, fetches `https://www.senate.gov/legislative/LIS/roll_call_votes/vote{c}{s}/vote_{c}_{s}_{rc}.xml` and parses to an array of `{ lastName, state, cast, firstName?, party? }`.
- **Reader:** widget via Worker route `GET /api/roll-call-rosters/{chamber}/{c}/{s}/{rc}` (see spec AC-32.15, api-contracts.md §5.5).
- **Record shape:** see AC-32.15.
- **TTL:** none in KV (historical roll-calls never change). Cache-Control on the Worker route: `public, max-age=86400, s-maxage=31536000, immutable`.
- **Invariant:** House rosters are keyed by bioguide; Senate rosters are keyed by lastName+state (Senate XML carries no bioguide IDs — see design.md §4.3 for the matching algorithm and its rare-conflict case).

### `state-members:v1:{stateCode}`

- **Writer:** curator. Reuses the same paginated `api.congress.gov/v3/member?currentMember=true&state={state}&limit=250` walk the curator already does to build `name-index:v1:*`; pre-groups the returned members into senators (district==null) and house (district!=null, sorted by district ascending) and writes one record per two-letter stateCode.
- **Reader:** widget via Worker route `GET /api/state-members/{stateCode}` (AC-32.16, api-contracts.md §5.6).
- **Record shape:** see AC-32.16.
- **TTL:** none in KV (the curator rewrites weekly). Cache-Control: `public, max-age=86400, s-maxage=86400, stale-while-revalidate=3600`.

### Widget code path changes

| Widget function | v2.5.1 call | v2.5.2 call |
|---|---|---|
| `useAddressLookup` — resolve state roster | `fetchMembersByStateDistrict` + `fetchMembersByState` → `/api/congress/v3/member/congress/{c}/{state}[/{district}]` | `GET /api/state-members/{state}` then client-side filter to district |
| `useAddressLookup` — enrich chip list with detail | `fetchMemberDetail(bioguideId)` → `/api/congress/v3/member/{id}` | Removed. The `state-members:v1:` record already carries `photoUrl`, `website`, party, district; no second fetch needed. |
| `useVotingRecord` — resolve a House member's cast on a curated vote | `fetchHouseVoteMembers(c, s, rc)` → `/api/congress/v3/house-vote/{c}/{s}/{rc}/members` | `GET /api/roll-call-rosters/house/{c}/{s}/{rc}` then lookup `casts[bioguideId]` |
| `useVotingRecord` — resolve a Senate member's cast | `fetchSenateVoteDetail(c, s, rc)` → `/api/senate/legislative/LIS/.../xml` | `GET /api/roll-call-rosters/senate/{c}/{s}/{rc}` then `casts.find(r => r.lastName === lastName && r.state === state)` |

### Deprecations (not deletions)

The upstream pass-through routes stay. They are:
- Still called by the **curator** (from Node.js, with its own Congress.gov key).
- Still cached by the Worker per AC-25.2 (immutable) / AC-25.3 (semi-mutable) / AC-25.4 (default).
- Potentially useful for debugging ("what does Congress.gov actually return for HR7691 roll call 185?").

The widget just stops calling them. A unit test SHALL assert this invariant (see task).

## Consequences

**Positive:**
- Per-visitor Congress.gov upstream calls drop from ~30+ to ~0 in the hot path. The Worker rate-limit budget is governed by KV read rate, which the curator cannot inflate.
- AC-27.21 and AC-28.3 rate limits can be re-tightened after this lands (flagged as forward-path notes in those ACs). Forward target: AC-27.21 prod = ~60/60s (matches v2.5.1's original budget for non-fan-out traffic); AC-28.3 prod = ~120/60s (2× Worker).
- Roll-call rosters become an authoritative, version-controlled artifact — the curator run becomes a reproducible snapshot of historical vote data, not a series of live round-trips.
- Senate XML parsing moves out of the widget (it already happens in Worker code at proxy time for cache-fill; now it happens in the curator and the Worker's Senate roll-call route becomes a simple KV-read). Reduces the client-side bundle by removing the `senateVotesApi.parseSenateXml` path.

**Negative / risks:**
- **Curator runtime grows.** 18 House + 26 Senate roll-call fetches per curator run, plus 50 state-member fetches (one per state/territory, ≤5 minutes at default concurrency with KV bulk writes). Currently seconds; post-ADR closer to 2-3 minutes. Acceptable at weekly cadence.
- **Curator API-key budget grows.** ~94 additional Congress.gov fetches per curator run. Congress.gov free-tier limit is 5000 req/hour; a curator run uses ≤200 total. Acceptable.
- **Stale rosters on unreleased curated votes.** If a curator adds a new `votes[]` entry to `ukraineBills.json` and deploys the widget before the next curator run, the new vote's roster is not in KV. Widget behavior: the roster route returns 404, the widget treats the cast as "Did Not Vote" (or "Did Not Serve" based on cross-check). Not a silent corruption; the UI surfaces it. Operational mitigation: the curator SHALL be run as part of any deploy that adds new curated votes. Document in `docs/tasks.md` Phase 8 rollout checklist.
- **Two writers on `state-members:v1:` (curator) vs. `member:v1:` (Worker read-through, per ADR-011 addendum).** The curator can also pre-populate `member:v1:` records as part of its run (optional; it knows the bioguide list already). Not included in this ADR — kept simple, deferred to AC-32.17 if pursued.

**Neutral:**
- KV storage grows by ~44 roster records (~150 KB each for House, ~15 KB for Senate) + 56 state-members records (~5 KB each) ≈ 3.5 MB total. Well within KV free-tier limits.
- Senate XML is still parsed *somewhere* — in the curator rather than the Worker. Curator code size grows by ~150 lines for the Senate XML parser. Offset by removing `fetchSenateVoteDetail` from the widget's service layer (net bundle size reduction on the client).

## Open questions (deferred)

1. **Do we need a manual "roster overrides" mechanism?** The Senate XML occasionally has typos in last names (observed historically). Today the widget's lookup-failure silently becomes "Did Not Vote"; with rosters in KV this is more obviously a curator-pipeline data-quality issue. A `src/data/voteOverrides.yaml` already exists for overriding individual casts — keep it, have the curator apply it after fetching the XML.
2. **Should `/api/state-members/{state}` include non-voting delegates?** Today the Worker's upstream call to `/api/congress/v3/member/congress/{c}/{state}` *does* return territory delegates. The curator SHALL include them in the `house[]` array with a flag (`isNonVoting: true`). Widget renders them with the "Delegate (non-voting)" label per AC-1.4 / AC-31.4 v2.5.2.
3. **Senate class-based sort?** AC-32.16 currently sorts senators by last name. Seniority (senate class) would require the curator to cross-reference individual `/v3/member/{id}` records. Deferred.
4. **Historical rosters for members no longer in Congress?** The `state-members:v1:` record is current-Congress only. Historical vote rosters in `roll-call-roster:v1:` include former members by bioguide (House) or by name+state (Senate). Cross-referencing a former member's current identity is explicitly out of scope (see ADR-011 open question 3).
