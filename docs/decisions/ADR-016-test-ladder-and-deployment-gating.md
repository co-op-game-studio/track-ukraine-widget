# ADR-016: Test Ladder + Deployment Gating + Stg KV Mirror

**Status**: Accepted
**Date**: 2026-04-19
**Supersedes (mechanics only)**: ADR-005 deployment specifics on stg, FR-30 AC-30.3 / AC-30.5
**Traces to**: FR-44, FR-30, FR-26

## Context

The 2026-04-18 go-live produced observable 429 pressure from Congress.gov and Senate.gov that no automated test could have caught. Cause analysis:

1. **No composition tests.** Each module has a unit suite with all collaborators faked. There is no test that composes the real `TieredCache` + real tier implementations + real `UpstreamRegistry` + real `matchRoute` against faked *bindings*. Integration bugs in the wiring surface only in production.
2. **No edge-reality tests.** `tests/e2e/widget.test.tsx` exists but exercises the React component tree with every `/api/*` response mocked. It has never watched a request traverse a real Worker, real edge cache, real KV.
3. **No remote e2e.** FR-30 / AC-30.5 spec'd this in v2.5.0 and has been marked aspirational ever since — no remote-mode test has landed in a year.
4. **No stress testing.** We found out about 429 pressure from visitors on go-live day. A synthetic visitor-flow workload run against stg would have flagged it before anyone pressed the button.
5. **Stg KV is stale.** FR-30 AC-30.3's R2-object sync predates ADR-011's move to KV as the datastore. Stg's KV contents drift freely from prod's between the rare occasions someone runs the sync manually.

The root structural gap: no ladder from unit → integration → e2e-local → e2e-remote → stress, no CI gate enforcing any rung, and no mechanism that ensures stg's data matches prod at rehearsal time.

## Decision

Formalize a **four-tier test ladder** (FR-44), make every tier a **merge-blocking or promotion-blocking CI gate**, and add **two new ops** to the stg rehearsal: a full prod-KV mirror sync and a stress run.

### The ladder (fastest → slowest, cheapest → most realistic)

**Tier 1 — Unit**
- One module under test, every collaborator faked.
- Runs in Vitest, in-process, seconds.
- Gate: every PR to `main` via `pr.yml`. Failing unit blocks merge.

**Tier 2 — Integration**
- Multiple modules composed. Real classes, real collaborators, only *bindings* faked (fake KV, fake R2, fake `caches.default`, stubbed `fetch`).
- Lives under `tests/integration/`.
- New requirement: any PR touching `proxy/**`, `src/services/**`, or the curator/warm scripts that drops branch coverage below 80% on the affected module fails CI (AC-44.11).
- Gate: every PR to `main` via `pr.yml`. Failing integration blocks merge.

**Tier 3 — E2E Local Worker**
- Worker booted via `wrangler dev --env preview`.
- Fixture HTTP server on a separate port returns canned Congress/Senate/Census responses.
- Widget SPA pointed at the local Worker; real HTTP; real edge cache; real KV binding (miniflare-backed).
- Gate: runs on `deploy.yml` for pushes to `develop`, `uat`, `stg`, `prod`. Blocks the deploy step.

**Tier 4 — E2E Remote Edge**
- Full test suite against the deployed stg Worker (`https://stg.vote.cogs.it.com`).
- Real upstream data via prod-mirrored KV.
- Real Access service token.
- Runs in the stg-rehearsal workflow.
- Gate: required for any prod promotion (AC-44.10).

**Stress (stg-only, runs after Tier 4)**
- Parametrized concurrent-visitor workload against stg's real edge.
- Cold scenario (fresh R2 + KV, 50 concurrent for 60s) and warm scenario (same load, caches warm from cold pass).
- Budgets: p95 ≤ 5s, 0 Worker 5xx, upstream 429 count ≤ 0 warm / ≤ 5 cold (AC-44.8).

### Stg KV mirror (replaces FR-30 AC-30.3 R2-object sync)

Every rehearsal:
1. Sync every curator-owned KV prefix from prod → stg (6 prefixes: member, bill, roll-call, name-index, roll-call-roster, state-members).
2. Skip `cache:v1:*` (stg must exercise its own cold-cache path).
3. Skip `archive/**` in R2 (same reason — stress needs cold-R2 to produce the numbers we care about).
4. Fail loud on any error. No retry, no partial copy.
5. Abort rehearsal before deploy if sync fails.

This makes "stg is the same shape as prod" a mechanical truth, not a hope.

### CI gating summary

| Gate | Tiers | Trigger | Failure means |
|------|-------|---------|---------------|
| `pr.yml` | 1 + 2 | PR to `main` | Merge blocked |
| `deploy.yml` on non-prod | 3 | Push to `develop`/`uat`/`stg` | Deploy blocked for that env |
| `stg-rehearsal.yml` | 3 + 4 + stress | Push to `stg`, or manual trigger | Prod promotion blocked |
| `deploy.yml` on prod | SHA match against last-green stg rehearsal | Push to `prod` | Prod deploy blocked |

## Alternatives considered

**Run everything on every PR.** Rejected. Remote e2e + stress takes 4-8 minutes; running it on every PR would burn minutes and CF budget. Ladder placement is deliberate: fast signals early, expensive signals at the gate where they matter.

**Mock upstreams in remote e2e too.** Rejected. The whole point of tier 4 is to exercise the real upstream fan-out against prod-shaped data. If we mock upstream we lose the signal that goes live.

**Only run stress on-demand.** Rejected for the stg rehearsal — it's a single workflow dispatch already manually-triggered for prod promotion, so "running stress" is not a separate burden. Stress runs on every rehearsal because every rehearsal IS a prod dry-run.

**Keep FR-30 AC-30.3 R2-object sync.** Rejected. Those objects don't exist anymore post-ADR-011. FR-44 AC-44.6 is the corrected form.

**Automate the prod-reviewer SHA-match check.** Deferred, not rejected. AC-30.6 keeps the honor-system check for now. A follow-up task MAY add a small GitHub Actions job that cross-references rehearsal runs via the GH API.

**Include cache prefix in stg sync.** Rejected. Stg must exercise cold-cache every rehearsal because that IS the signal we need. Copying prod's warm cache to stg would let a regression in the cache-write path go undetected.

## Consequences

### Positive

- Composition-level bugs (tiered cache wiring, matchRoute + pipeline interplay) surface before deploy.
- Edge-reality bugs (header passthrough, CORS reflection, cache-control translation) surface before deploy.
- Remote bugs (Access config drift, WAF rule accidentally matching our traffic, upstream key expiry) surface in stg.
- Stress regressions surface with numeric evidence in the rehearsal summary.
- Stg ~= prod guaranteed every rehearsal, not "most rehearsals."

### Negative / costs

- CI minutes: pr.yml goes from ~2min to ~3min (tier 2). `deploy.yml` on non-prod adds ~90s for tier 3. Stg rehearsal goes from ~1min to ~8min (tiers 3 + 4 + stress).
- Upstream budget: stress run hits Congress.gov at ~50 req/s for ~60s per cold scenario. Within the 5000/hr limit but noticeable. Mitigation: stress fixtures MAY be partial-mocked if upstream budget becomes the constraint (AC-44.8 allows this).
- Fixture maintenance: the local e2e fixture server needs canned responses for 7 upstream shapes, refreshed when upstream response formats drift.
- Access service-token scope: tier 4 + stress both need the existing `voter-info-widget-ci` token. No new secrets.

### Migration path

1. Spec (this PR) — FR-44 + ADR-016 + Phase 13 tasks in `docs/tasks.md`.
2. Tier 2 integration tests (AC-44.1, AC-44.2) — pure additions, no deploy coupling.
3. Tier 3 local-e2e harness + golden-flow test (AC-44.3, AC-44.4) + `pr.yml` update.
4. Tier 4 remote-e2e harness + golden-flow twin (AC-44.5) + stg-rehearsal wiring.
5. Stg KV mirror implementation (AC-44.6, AC-44.7) — extends `scripts/sync-stg-data.ts`.
6. Stress scenarios (AC-44.8, AC-44.9) + rehearsal wiring.
7. Prod-promotion reviewer-checks-SHA enforcement (AC-30.6 carry-forward).

Each step is landable independently. Each closes a named acceptance criterion.

## Related

- FR-30 (stg = regression gate) — semantic intent preserved; mechanics move to FR-44.
- FR-26 (deployment story) — unchanged, this ADR just adds test-ladder gates.
- ADR-005 (Cloudflare deployment) — unchanged.
- ADR-011 (KV sole datastore) — FR-44's sync honors the KV-prefix model.
- ADR-014 (tiered cache) — the integration tier in FR-44 is the first thing that exercises the pipeline against real tier implementations.
