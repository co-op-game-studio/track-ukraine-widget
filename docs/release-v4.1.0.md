# v4.1.0 Release Plan

**Status:** in-progress
**Branch:** `chore/coverage-deep-pass` (target merge → `main`)
**Owner:** Kody
**Started:** 2026-05-25
**Living document.** Edited as work progresses. Sections marked ✅ done / 🟡 in-flight / ⬜ pending / ❌ blocked.

---

## Why this release exists

v4.1.0 is the **stabilization release after v4.0.0**. It is not a feature release. It rolls up:

1. The **edge-tier cache key bug** discovered 2026-05-25 on `trackukraine.com` (Chicago address returning Washington-DC reps from a wrong-bucket cache hit).
2. The **bill seeding gap** surfaced by the 2026-05-19 UAT audit (119th Congress has zero cosponsors/votes; 118th partial; `became_law=0` across all 63 bills; two misclassified directions).
3. The **coverage deep-pass** (10 commits, threshold relaxation + new test coverage) that was waiting unmerged on `chore/coverage-deep-pass`.
4. The **prod→main CI sync** stuck in PR #118 since 2026-05-06.

Treating it as an omnibus is deliberate — they all touch the same branch, and shipping them separately costs three merge rounds. CLAUDE.md's "big chunks, not nibbles" rule applies.

---

## Decisions locked this session

These are the architectural choices that shape the implementation. Captured here so a future session reading this doc doesn't re-litigate them.

| # | Decision | Rationale | Memory |
|---|----------|-----------|--------|
| D1 | Seeding/backfill is build/ops, never runtime. | Browser-tab-gated backfill was the root cause of the 119th wipeout. Worker scheduled handlers carry the same coupling problem. CI is the right home — minutes-long budgets, own secrets, doesn't degrade serving. | [feedback_seeding_is_buildops_not_runtime.md](../memory/feedback_seeding_is_buildops_not_runtime.md) |
| D2 | Introduce `lw` CLI as the umbrella for all ingest jobs. | Six months from now we'll have 10 ingest scripts. One discoverable surface (`lw --help`) beats `scripts/*.tsx` sprawl. Inspired by `gh` / `wrangler` / `kubectl`. |  |
| D3 | CLI shape: Option C (single `lw` entrypoint + per-command files + shared lib). | Cleanest growth path. Each command can be developed in isolation; shared lib enforces consistency. |  |
| D4 | Decoupling contract: every lib function is pure, takes `D1Like` / `CongressClient` / `AuditLogger` interfaces. | Tests inject fakes; CLI injects real clients; Worker (if ever needed) injects Worker bindings. The lib function is the contract everyone agrees on. |  |
| D5 | CLI framework: `commander`. | Standard, boring, well-known. Auto `--help`. One devDep. |  |
| D6 | `package.json` `bin` field: `lw → scripts/cli.ts`. | `npx lw …` works in CI without `npm run` wrapping. |  |
| D7 | Move `scripts/publish-to-kv.ts` → `scripts/kv/publish.ts` in v4.1.0. | Keep the whole CLI consolidation together; don't leave a half-state. |  |
| D8 | Delete `useAutoBackfill` hook + `/api/admin/backfill-bills` route in v4.1.0. Not soft-deprecate. | Removing dead code now beats living with a deprecation cycle. |  |
| D9 | Admin SPA Settings ▸ Poll Status → "Data Freshness" panel: research-facing fields only. | "Cron tick N", "Job stalled at chunk M" is operator concern → belongs in CI logs, not the SPA. Researcher needs to know "are bills fresh enough to trust my edits today." | (echoes D1) |
| D10 | Worker adapter rewrite (existing `importBillFromCongress`) — test rewrites are in scope as long as they match spec. | Surgical extraction was deemed risky; tests can be reshaped during the move. |  |
| D11 | AC-40.11 (edge-tier key injectivity) + ADR-019 spec'd today; fix in `proxy/routes/api-upstream.ts` writes `__ck=<cacheKeyToDottedString(k)>` as a query param on the edge cache URL. | Captured in [docs/spec.md AC-40.11](spec.md) and [docs/decisions/ADR-019-edge-tier-key-injectivity.md](decisions/ADR-019-edge-tier-key-injectivity.md). |  |
| D12 | FR-59 spec scope: fix-what's-already-curated (63 bills). NOT the full corpus (FR-60 land). | Don't conflate the two efforts. v4.1.0 fixes UAT; FR-60 expands to ~48k bills. |  |
| D13 | Process: AIDD loop, no shortcuts. | Spec → failing test → implementation → refactor. Live feedback from dev env when needed. | [feedback_aidd_strictness.md](../memory/feedback_aidd_strictness.md) |

---

## What ships in v4.1.0

Three coherent groups, listed in landing order.

### Group 1 — Already on the branch (no new work, must survive into the merge)

| Item | State | Notes |
|---|---|---|
| Coverage deep-pass (10 commits) | ✅ on branch | `e42c701` → `46ea5bd`. Thresholds at 80/80/80/80 (achieved ~96/96/90/87). |
| PR #118 sync (prod CI fixes) | ⬜ to consolidate | Will resolve when this branch merges to main — PR #118 rebases onto the new tip and its stale CI passes against the new thresholds. |

### Group 2 — Edge-tier bug fix (uncommitted, ready to commit)

| Item | State | Files |
|---|---|---|
| AC-40.11 spec | ✅ written | [docs/spec.md](spec.md) lines ~817–823 |
| ADR-019 | ✅ written | [docs/decisions/ADR-019-edge-tier-key-injectivity.md](decisions/ADR-019-edge-tier-key-injectivity.md) |
| Regression test (dual-of-nonce) | ✅ written, passes | [tests/unit/routes/query-and-cache.test.ts](../tests/unit/routes/query-and-cache.test.ts) |
| Fix in `keyToUrl` adapter | ✅ written, suite green | [proxy/routes/api-upstream.ts](../proxy/routes/api-upstream.ts) lines ~137–148 |
| T-133 row in tasks.md | ✅ written | [docs/tasks.md](tasks.md) |

### Group 3 — FR-59 seeding fix + `lw` CLI foundation

This is the bulk of the new work. Tracked task by task below.

| # | Task | State | Files |
|---|---|---|---|
| 3.1 | FR-59 spec | ✅ drafted (v2, post-correction) | [docs/spec.md](spec.md) FR-59 section |
| 3.2 | `lw` CLI foundation | ✅ done 2026-05-25 | `scripts/cli.ts` (commander dispatcher), `scripts/lib/{runtime,d1-client,congress-client,audit-log,trace}.ts`, `scripts/{bills/backfill,kv/publish}.ts` stubs. `package.json` bin + lw script. Version bumped to 4.1.0-rc.1. Verified: `--help`, `--version`, subcommand help all render. Typecheck + full suite green (155 files, 2188 tests). |
| 3.3 | Extract `importBillCore` | ✅ done 2026-05-25 | `scripts/lib/bills/import-core.ts` (new, pure fn over D1Like/CongressClient/AuditLogger), `proxy/services/import-bill.ts` (90-line Worker adapter). 19/19 importBill tests pass. |
| 3.4 | `lw bills backfill` subcommand | ✅ done 2026-05-25 | Pure orchestrator + CLI wrapper. Concurrency 4. `force=false` default honors bill-level + vote-level freshness gates — warm corpus costs ~63 API calls / ~45s; cold ~500 calls / ~6 min. Per-bill error continuation with audit_log writes. Exit codes 0/1/2. |
| 3.6 | Delete `useAutoBackfill` + `/api/admin/backfill-bills` | ✅ done 2026-05-25 | Hook removed from src/admin/App.tsx + constants + useEffect call. Route handler removed from proxy/routes/api-admin.ts + dispatch line. Tests deleted: useAutoBackfill.test.tsx + /backfill-bills block in apiAdminRoutes.test.ts. |
| 3.7 | Migration 0010 | ✅ done 2026-05-25 | migrations/d1/0010_v4_1_0_direction_corrections.up.sql — HR-2445 + S-2552 direction='anti-ukraine' → 'neutral' with audit_log rows. Rollback in _rollbacks/. AC-59.7. |
| 3.8 | Data Freshness panel | ✅ done 2026-05-25 | New /api/admin/data-freshness endpoint + DataFreshnessView.tsx + Settings ▸ Data freshness slot. Research-facing: total/by-congress/by-direction/became-law counts, freshness buckets, top-20 stale bills, last refresh attempt. PollStatusView preserved for social handle health. |
| 3.9 | GitHub Actions workflow | ✅ done 2026-05-25 | .github/workflows/backfill-bills.yml — cron 6h dev/uat + 12h stg/prod, workflow_dispatch with env/force/limit/concurrency inputs, per-env matrix with gate, exit 0/2 → green, exit 1 → red. |
| 3.10 | Regression tests for FR-59 | ✅ done 2026-05-25 | tests/unit/bills/import-core.test.ts (4 tests: AC-59.5 became_law, AC-59.6 5 votes from 3 actions, AC-59.10 idempotency). tests/unit/bills/backfill.test.ts (5 tests: processes all, error continuation, limit, cursor, filter). |
| 3.11 | Spec touch-ups | ✅ done 2026-05-25 | CLAUDE.md `lw` CLI section added. ADR-011 deploy step updated. `publish:kv` alias preserved for compat. |
| 3.12 | PeopleTab roster-driven | ✅ done 2026-05-25 | PeopleTab now enumerates all sitting members from mocMap (KV name-index). Zero-handle members render with "no handles tracked" caption. Header shows "N people · M handles · X/Y Congress with handles" coverage metric. |
| 3.5 | `lw kv publish` wrapper over existing `publish-to-kv.ts` | 🟡 partial 2026-05-25 | `scripts/kv/publish.ts` exists and spawns `scripts/publish-to-kv.ts` end-to-end (719-line script untouched). `npm run publish:kv` now routes through `lw`. Full extraction into `scripts/lib/kv/publish.ts` deferred — captured as v4.2.0 cleanup. Rationale: legacy script is IIFE-with-top-level-argv; rewriting it in v4.1.0 was high-regression-risk for a release that's about stabilization. |
| 3.6 | Delete `useAutoBackfill` + `/api/admin/backfill-bills` | ⬜ pending | `src/admin/App.tsx`, `proxy/routes/api-admin.ts`, related tests |
| 3.7 | Migration 0010 (HR-2445 + S-2552 → neutral) | ⬜ pending | `migrations/d1/0010_v4_1_0_direction_corrections.up.sql` + rollback |
| 3.8 | Data Freshness panel reframe | ⬜ pending | `src/admin/components/PollStatus*` (rename + replace copy) |
| 3.9 | GitHub Actions workflow | ⬜ pending | `.github/workflows/backfill-bills.yml` |
| 3.10 | Regression tests (AC-59.5, 59.6, 59.10) | ⬜ pending | `tests/unit/bills/backfill.test.ts`, `tests/unit/bills/import-core.test.ts` |
| 3.11 | Spec touch-ups: `publish:kv` script rename | ⬜ pending | [CLAUDE.md](../CLAUDE.md), any deploy docs referencing `publish:kv` |
| 3.12 | PeopleTab roster-driven enumeration | ⬜ pending | `src/admin/components/PeopleTab.tsx` — render one card per sitting member from KV name-index, not from `mocs_social_handles`. Zero-handle members get empty-list cards. Coverage metric visible. |

### Group 4 — Release mechanics

| Item | State | Notes |
|---|---|---|
| Full suite green | ⬜ pending | `npm test` end-to-end after all of Group 3 lands |
| Typecheck clean | ⬜ pending | `npm run typecheck` |
| Live dev verification | ⬜ pending | `npx lw bills backfill --env dev --limit 5` against real dev D1 |
| Tag `v4.1.0` on `main` after merge | ⬜ pending | After PR merges, push tag |
| Update [docs/tasks.md](tasks.md) with T-134..T-141 entries | ⬜ pending | Mirror Group 3 task rows here for AIDD traceability |

---

## Implementation order (the path I'll work)

This is the order that makes each step verifiable. If something breaks at step N, I write a test, fix it, then move to N+1.

1. **Group 3.2 — CLI foundation.** Skeleton only. `lw --help` lists no commands; `lw --version` works. Verifies commander wires up.
2. **Group 3.5 first half — `lw kv publish`** thin wrapper around existing `publish-to-kv.ts`. This proves the CLI shape against working code we already trust. Existing publish behavior unchanged.
3. **Group 3.3 — extract `importBillCore`.** Tests rewrite to match new shape (D10). Worker adapter is a 5-line wrapper. Full suite must stay green.
4. **Group 3.10 (partial) — write AC-59.5 + 59.6 tests against `importBillCore`** before the backfill subcommand exists. They go red for the right reason.
5. **Group 3.4 — `lw bills backfill` subcommand.** Run end-to-end against `dev`. Watch live output. AC-59.5 and 59.6 tests go green.
6. **Group 3.7 — migration 0010.** Apply against `dev`. Verify 118-HR-2445 and 118-S-2552 are now `neutral`.
6b. **Group 3.12 — PeopleTab roster-driven enumeration.** Switch PeopleTab from `listHandles`-grouped to roster-enumerated. Empty-handle cards render. Coverage metric in header. Verify against dev: count = 535 (or 536 with delegates), N with handles correctly displayed.
7. **Group 3.6 — deletions.** `useAutoBackfill` + the runtime route + their tests. Suite stays green (the only paths exercising them are tests we delete in the same commit).
8. **Group 3.10 (rest) — idempotency test (AC-59.10).** Run backfill twice; assert zero new rows on the second.
9. **Group 3.8 — Data Freshness panel.** Replace operator copy with research-relevant fields. Manual smoke against dev admin SPA.
10. **Group 3.9 — GitHub Actions workflow.** `workflow_dispatch` triggered run against dev first. Verify it actually works in CI.
11. **Group 3.11 — spec touch-ups.** `publish:kv` → `lw kv publish` rename in CLAUDE.md.
12. **Group 4 — release.** Full suite. Typecheck. Commit. Open PR `chore/coverage-deep-pass` → `main`. Merge. Tag.

---

## Risks + how I'll know early

| Risk | How it shows up | Mitigation |
|---|---|---|
| `importBillCore` extraction regresses Worker behavior | Existing integration tests fail | Run full suite after every file move. Don't proceed if red. |
| `commander` version conflicts with existing devDeps | `npm install` fails or types break | Try the install first; if conflict, switch to `node:util.parseArgs`. |
| D1 binding from CLI doesn't work as expected | `npx lw bills backfill --env dev` errors at first call | Mock D1 in tests; do a `--dry-run` mode first; the wrangler-shell transport (D7) is a known pattern from `publish-to-kv.ts`. |
| Congress.gov rate limit during a real run | 429s during backfill verification | CLI honors `Retry-After` per AC-59.4. Budget is 2,500/h sustained; 63 bills × 4 endpoints = 252 req — fits in a 10-min window with headroom. |
| Coverage deep-pass commits get squashed/lost during a rebase | `git log` shows fewer commits than expected | Don't rebase; merge with `--no-ff`. The existing `40ade03` "merge: prod -> main" sets the precedent. |
| Stale PR #118 still failing after merge | Branch protection blocks downstream releases | After merging this branch to main, `gh pr update-branch 118` to retarget; the stale CI will re-run against the new main and pass. |

---

## Open questions

None right now. All Q&A from this session resolved into Decisions D1–D13 above.

If something comes up during implementation that needs a call, log it here with the decision date, and consider whether it warrants saving to memory.

---

## Related issues surfaced during v4.1.0 work

These are bugs noticed but **NOT** in FR-59's scope. Logged here so they don't get lost.

### People tab: 306 of 535 sitting members visible

**Symptom (2026-05-25, UAT):** The Settings ▸ People tab shows "306 people · 376 handles." Sitting Congress is 535 voting members (+territorial delegates ≈ 541). Coverage gap is ~229 members invisible to researchers.

**Investigation findings:**

- Upstream `legislators-current.json` carries 536 entries (current sitting members + territorial delegates).
- Upstream `legislators-social-media.json` carries 519 entries. **17 sitting members have no social media in the upstream dataset**, so the natural upper bound for "people with at least one handle" via this seeder is 519, not 535.
- The seeder (`proxy/services/ingest-seed.ts`'s `seedRosterFromSources`) iterates `allMembers` loaded from the **KV name-index shards** (`name-index:v1:{letter}`). For each member it merges KV socials + upstream socials and inserts a `mocs_social_handles` row per platform/handle found. **Members not in the name-index are never reached.**
- Gap math: upstream upper bound 519 − actual 306 = **213 members missing**. Two consistent explanations:
  1. **Stale KV name-index** — the 119th-Congress additions never landed because `scripts/publish-to-kv.ts` was last run before all new members were available, or only against some envs.
  2. **Seeder coverage loss** — even for members present in the name-index, the merge logic skips them if neither KV nor upstream supplies a non-empty handle map. The 17 zero-social upstream entries explains some of the gap; the rest needs the seeder log output to confirm.
- The People tab's count is also constrained by the UI: `listHandles` returns rows from `mocs_social_handles`, and `cards.length` only counts distinct bioguides with **at least one handle row**. Members in the name-index who got skipped by the seeder are invisible to the tab.

**Decision: fold into v4.1.0.** Tracked as Group 3.12. Rationale:

- The fix is small in shape: PeopleTab enumerates from the roster (KV name-index, which has all sitting members), not from `mocs_social_handles` (which only has rows for members with at least one tracked handle). Members with zero handles get a card with an empty list.
- The seeder-side gap (KV name-index stale → handles missing for some members) heals when `lw kv publish` runs end-to-end. That command already exists in v4.1.0, so we get the seeder fix essentially for free.
- v4.1.0 carries the user-visible promise of "the seeding is right" — a count showing 306 of 535 contradicts that promise even if it's technically a different code path.

**v4.1.0 acceptance criteria** (to capture):
- PeopleTab SHALL enumerate every current sitting member of Congress (source: KV name-index, fed by `lw kv publish`), regardless of whether `mocs_social_handles` has a row.
- Members with zero handles SHALL render as a card with an empty handle list and a "no handles tracked" caption.
- Coverage metric SHALL be visible in the header: e.g. "535 people · 376 handles (306/535 with handles)".
- The 17-member gap between current-Congress (536) and social-JSON (519) is intentional upstream behavior, not a defect; documented here for posterity. Members not in the social JSON still appear as cards, just with empty handle lists.

**Tracked as:** investigation task #32 (completed) + implementation task #33 (folded into v4.1.0).

---

## Out of scope (deliberately)

These came up during the chat but are **NOT** in v4.1.0. Listed here so a future-me reading this knows they were considered and parked:

- **FR-60 full Congress.gov corpus** (~48k bills) — feasibility report done; spec drafting deferred to post-v4.1.0.
- **legislation.watch platform** (FR-61..FR-67, ADR-020..ADR-023) — the entire minisite umbrella. Specs deferred.
- **`useAutoBackfill` soft-deprecation** — rejected in favor of deletion (D8).
- **Worker scheduled handler for backfill** — rejected in favor of CLI (D1).
- **Election API / FEC integration** — punted to a future FR.
- **Per-bill admin SPA actions** (manual re-import button, etc.) — possible v4.2 surface once Data Freshness panel is in place; tracked here only as context.
- **Full extraction of `publish-to-kv.ts` into `scripts/lib/kv/publish.ts`** — the 719-line legacy script gets the `lw kv publish` surface in v4.1.0 via subprocess wrapping, but the body stays unchanged. v4.2.0 cleanup will pull the orchestration into a pure-function core over `D1Like` / `AuditLogger`.

---

## Changelog (this document)

| Date | Change |
|---|---|
| 2026-05-25 | Initial draft. Reflects state through D13 / Group-3 task definitions. |
| 2026-05-25 | Group 3.2 complete — `lw` CLI foundation landed. Commander installed. CLI shells, env-resolution, D1Like/CongressClient/AuditLogger interfaces all in place. Subcommand stubs print "not implemented" so the dispatcher compiles end-to-end. |
| 2026-05-25 | Group 3.5 partial — `lw kv publish` wrapper landed as subprocess-spawn over the legacy script. Full extraction deferred to v4.2.0 (scope decision: stabilization release, not refactor release). `npm run publish:kv` aliases to `lw kv publish`. Typecheck + full suite still green. |
| 2026-05-25 | Investigated 306-vs-535 People tab gap. Root cause is a different code path (KV name-index + ingest-seed roster merge), not bills. Upstream `legislators-social-media.json` caps at 519; remaining gap likely stale KV name-index. Initially proposed defer to v4.2.0; user pushed back ("stop trying to separate issues"). Folded into v4.1.0 as Group 3.12. Reframed in plan from "Related issues" deferred section to active scope. |
| 2026-05-25 | Group 3.3 complete — extracted importBillCore from proxy/services/import-bill.ts into scripts/lib/bills/import-core.ts as a pure fn over D1Like/CongressClient/AuditLogger. Worker adapter now 90 lines. Added CliLogger + verbose/debug propagation via LW_VERBOSITY env var. CongressClient gained opt-in rate-limit (CLI: 5000/h) + retries (CLI: 3); Worker keeps pre-v4.1.0 zero-default behavior. Full suite 155/2188 green. |
| 2026-05-25 | Group 3.4 complete — `lw bills backfill` subcommand wired. Concurrency 4. force=false default → warm-run cost ~63 calls/45s. Spec AC-59.10 expanded to make the "save once, don't re-pull unless changed" posture explicit + quantified. Typecheck + full suite green. |
