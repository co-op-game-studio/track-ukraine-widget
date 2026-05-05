# ADR-017: D1 as Editable Source of Truth, KV as Read Snapshot

**Status**: Accepted
**Date**: 2026-05-02
**Deciders**: Kody
**Amends**: ADR-011 (KV as sole first-class datastore — narrows the scope to "KV is sole *read-path* datastore")
**Amends**: ADR-009 (KV response cache — unchanged in shape; expanded prefix list under FR-51)
**Related**: ADR-012 (KV-rosters), ADR-018 (score Bayesian shrink), FR-49..FR-58

---

## Context

V4 introduces an editable, audited researcher-facing surface: bills, vote weights, direction tags, comments, social posts, quotes. The pre-V4 model has every piece of curated content in a hand-edited git-tracked JSON file (`src/data/ukraineBills.json`). That file has worked well at small curator-count + small bill-count, but it cannot support:

- **Audit trail.** Who changed which weight when, with what rationale. Today the answer is "git blame," which conflates content edits with refactors and is invisible to non-developer researchers.
- **Multi-author writes.** A team of researchers cannot productively concurrent-edit a JSON file. Branch + PR is the wrong friction shape for a "report 30 wrong votes this week" workflow (see `docs/researcher-workflow-discord.md`).
- **Attached editorial content.** Comments scoped to a bill or roll call, social posts attached to a rep, quotes with source citations — none of these have a place in `ukraineBills.json` and shoehorning them in would break the existing publish path.
- **Score-quality work.** FR-54 (per-vote tunable weight) and FR-55 (Bayesian shrink toward party prior) both need edit-level granularity that JSON-file-as-database can't express without a regression in the curator workflow.

ADR-011 made KV the sole first-class datastore for **reads**. That decision is sound and is preserved. The question this ADR answers is: where does the editable, source-of-truth state live, given that KV is the wrong shape for it?

### Why KV is the wrong shape for source-of-truth

- KV's only query primitive is prefix scan. Audit-log queries (last 50 changes by alice@…, all weight changes between two dates) are O(N) over the entire namespace, which is operationally unacceptable.
- KV has no transactional semantics across keys. A coupled change ("update vote weight + insert audit log row") cannot be atomic. Half-applied state on a failed write is observable to readers.
- KV's eventual-consistency model (~60s global, FR-32 AC-32.13) is fine for read-snapshot data — readers can tolerate "I see last minute's score." It is wrong for write-after-read flows where a researcher saves an edit and immediately reloads the editor: KV may still return the prior value for up to a minute.
- KV record sizes are bounded; an unbounded `audit_log` list as a single KV value is the wrong storage primitive.

### Why D1 is the right shape

- SQL queries: audit traversal, aggregates (FR-56), joins between bills/votes/comments are one statement.
- Foreign-key cascades enforce referential integrity at the storage layer instead of in script code.
- Transactions: write + audit-log insert are atomic. Half-applied state is impossible.
- Strong consistency within a region: the admin SPA's read-after-write works without a `setTimeout(retry, 1500)` workaround.
- D1 is in the same Cloudflare account, billing surface, and Worker binding namespace as the existing KV. No new vendor.

### Why not "skip KV, embed reads D1 directly"

- D1 is regional, not edge-replicated. A widget loaded in Sydney would round-trip to a North-American D1 region per request. KV serves in single-digit ms from every POP.
- The embed's read-path latency profile is hard-won and measured. Inserting a regional database into the request path would regress NFR-1 (5s end-to-end target) on top-of-funnel cold visits.
- The FR-32 atomic-record contract (one KV.get returns everything to render a rep card) is preserved by keeping KV as the read snapshot and projecting D1 state into the same record shapes via the publish script.

### Why not "skip Discord, use email allowlist forever"

- Email allowlists do not scale past ~10 trusted researchers. The community organizes on Discord; long-term auth should match where users are.
- Discord OAuth + role-based authorization is the right destination. It is not the right *Sunday* destination — implementing OAuth callback handling, JWT minting, cookie security, and CSRF protection on the V4 clock is risk we don't need to take.
- Cloudflare Access supports Discord as an IdP (via SAML / OIDC) — when the migration happens, the `Cf-Access-Authenticated-User-Email` extraction point can be left in place and the IdP swapped underneath.

## Decision

1. **Cloudflare D1** is the editable source of truth for V4 researcher content. New database `viw_researcher` per environment with schema in design.md §4.16.
2. **KV** remains the sole read-path datastore. Existing FR-32 prefixes (`member:`, `bill:`, `roll-call:`, `roll-call-roster:`, `state-members:`, `name-index:`, `cache:`) are unchanged in shape. Three new curator-written prefixes are added: `comment:v1:{billId}`, `social-post:v1:{bioguideId}`, `quote:v1:{bioguideId}`. Plus stats and audit-feed snapshots: `stats:v1:summary`, `audit-feed:v1:full`, `audit-feed:v1:public`.
3. **The boundary between D1 and KV** is `scripts/publish-d1-to-kv.ts`. Researchers write to D1; the script projects D1 into KV. The Worker NEVER writes to `*:v1:*` KV prefixes from researcher routes (FR-32 AC-32.5 invariant preserved, with the one-line exception in AC-32.18 already on the books).
4. **Auth** is Cloudflare Access at the edge plus independent JWT verification in the Worker. CF Access policies (managed in the CF dashboard) own login / MFA / IdP / allowlist; the Worker has no email-allowlist code. The Worker DOES verify the `Cf-Access-Jwt-Assertion` JWT on every admin request as belt-and-suspenders against direct-origin bypass — `proxy/security/cf-access-jwt.ts` performs RS256 signature + `aud`/`iss`/`exp`/`iat`/`nbf` checks against the team JWKS; `proxy/security/admin-actor.ts` extracts the email from the verified claims (NOT from the loose plain header). Workers.dev URLs and preview URLs are disabled (`workers_dev = false`, `preview_urls = false` in `wrangler.toml`) so the only inbound path is the gated zone hostname. Discord SSO (FR-57) is a deferred swap of the CF Access IdP — the Worker code would not change.
5. **Audit log** is a D1 table written in the same transaction as every researcher mutation. Public-readable redacted projection lives in KV (`audit-feed:v1:public`) and is updated by the publish pipeline.

## Consequences

**Good:**
- Researchers get a real CMS surface without a custom OAuth implementation.
- Audit history is queryable in SQL.
- Score-quality work (FR-54, FR-55) lands on a data path that supports it.
- KV read-path is unchanged — embed performance and edge-cache wins from ADR-011/012/014 are intact.
- The publish-script boundary is small and testable; determinism is asserted by tests (AC-56.5).

**Risk:**
- Two storage layers means two consistency models. A researcher's save commits to D1 immediately but takes one publish-cron cycle (≤15 min on dev/uat, manual on stg/prod) plus KV-eventual-consistency (~60s) to be visible in the embed. Documented in design.md §4.17 and surfaced in the SPA via "Last published at: …" timestamp.
- D1 is regional, so cross-region failover is not free. For V4 we accept this — the researcher surface has fewer concurrent users than the embed and tolerates regional latency.
- Cloudflare Access ties researcher access to the team plan. If the team-plan limit becomes a problem, fallback is HMAC-cookie auth in the Worker (out-of-scope for V4, not blocking).

**Neutral / explicit non-goals:**
- D1 is not a write surface for the embed. The embed is read-only.
- No realtime push from D1 to embed. The publish-cron cadence is the SLO.
- No multi-region D1. Cloudflare's read-replica story for D1 is improving but not in V4 scope.

## Migration outline

1. Land migration `0001_init.sql` (FR-49 AC-49.2) on dev D1 first.
2. Run `scripts/seed-d1-from-json.ts` — bootstrap from the existing `ukraineBills.json` (FR-49 AC-49.3). Idempotent.
3. Land `scripts/publish-d1-to-kv.ts` (FR-51) and run it once on dev. Compare output to current `bill:v1:*` records — should be byte-identical for the bill/vote subset (AC-54.3 regression test).
4. Land Worker routes + auth (FR-50). Smoke-test against dev with a known allowlisted email.
5. Land admin SPA (FR-52). Smoke-test the full edit-save-publish loop against dev.
6. Promote through ladder: dev → uat (D1 binding swap), uat → stg (manual approval per project_branch_model), stg → prod.
7. After prod is stable for 48 hours, freeze `src/data/ukraineBills.json` with the AC-49.4 header comment.
8. Schedule the Discord-SSO migration (FR-57) as a follow-on cycle. ADR-017 is superseded at that point.

## References

- [FR-49 D1 as Editable Source of Truth](../spec.md#fr-49-d1-as-editable-source-of-truth-new-v270)
- [FR-50 Authenticated Researcher API](../spec.md#fr-50-authenticated-researcher-api-new-v270)
- [FR-51 D1→KV Publish Pipeline](../spec.md#fr-51-d1kv-publish-pipeline-new-v270)
- [Design §4.16–4.21](../design.md)
- [ADR-011](ADR-011-kv-sole-datastore.md)
- [ADR-012](ADR-012-kv-rosters-and-state-members.md)
- [docs/researcher-workflow-discord.md](../researcher-workflow-discord.md) — the workflow ADR-017 enables
