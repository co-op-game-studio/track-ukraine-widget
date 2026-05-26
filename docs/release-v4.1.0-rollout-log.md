# v4.1.0 dev rollout log

**Started:** 2026-05-26
**Branch:** `chore/coverage-deep-pass`
**Env scope:** dev only (UAT/stg/prod deferred per user direction)
**Tracking RC:** `v4.1.0-rc1` initial; bumped per iteration

This file tracks live execution of the v4.1.0 release plan against dev.
Format: section per phase, with state markers (⬜/🟡/✅/❌/⚠️) and any
findings. Edited live as work progresses.

---

## Phase 0 — Pre-flight

| Item | State | Notes |
|---|---|---|
| Verify branch state | ✅ | clean (only coverage-tmp + this log file untracked); on chore/coverage-deep-pass |
| Verify commit chain | ✅ | c7f6f9b → a82b2f8 → 95f62b4 confirmed |
| Verify CI secrets present | ✅ | CONGRESS_API_KEY + CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID all in `gh secret list` |
| Verify env vars locally | ⚠️ | CLOUDFLARE_API_TOKEN set in shell. CLOUDFLARE_ACCOUNT_ID not set but pulled from `wrangler whoami` → `ee328c1565b93d82df15c09698e715d3`. CONGRESS_API_KEY missing (only VITE_ prefix in .env); will need to set or source from .env for the smoke run. |

## Phase 1 — Run full test suite + coverage

| Item | State | Notes |
|---|---|---|
| `npm run typecheck` | ✅ | Clean both root + proxy tsconfig |
| `npx vitest run` | ✅ | 156 files, 2186 passing, 5 skipped (~39s wall) |
| `npm run test:coverage` | ✅ | 94.89/87.08/89.83/94.89 — comfortably above 80/80/80/80 floors |
| Build (`npm run build:all`) | ✅ | All three Vite builds + SRI manifest. IIFE: 808kB (gzip 220kB). Admin SPA: 462kB (gzip 130kB). |

## Phase 2 — Live dev smoke (Node CLI)

| Item | State | Notes |
|---|---|---|
| `npx tsx scripts/cli.ts --version` | ✅ | rc1: `4.1.0-rc.1`; rc2 (after fix): `4.1.0-rc1` (renamed) |
| `npx tsx scripts/cli.ts bills seed --help` | ✅ rc2 | `--local` removed in rc2 (no longer applicable with REST transport) |
| `npx tsx scripts/cli.ts bills seed --env dev --limit 1 --verbose` | ❌ rc1 / ✅ rc2 | rc1: SQL-tokenization bug (Issue 1). rc2: 117-HR-2471 cached, 1.5s. |
| `npx tsx scripts/cli.ts bills seed --env dev --limit 5 --verbose` | ✅ rc2 | 5/5 cached, 1.7s, concurrency 4 + rate-limit waits visible |
| Idempotency: run again with same `--limit 5` | ✅ rc2 | 5/5 cached, 1.4s. Zero new rows. |
| Full run: `--env dev` (no limit) | ✅ rc2 | **63/63 processed, 58 cached, 5 freshly pulled, 0 failures, 56.9s wall clock.** 5 newly fresh: 119-HR-4346, 119-HR-3104, 119-HR-2913, 119-SRES-111, 119-SRES-236. |
| D1 post-state verified | ✅ rc2 | 117: 21 bills, 6 became law • 118: 21 bills, 2 became law • 119: 21 bills, 0 became law (live session). Cosponsors: 117: 17/21 bills, 381 rows • 118: 16/21 bills, 285 rows • **119: 18/21 bills, 525 rows** (was 0/21 before). |

## Phase 3 — Apply migration 0010 to dev

| Item | State | Notes |
|---|---|---|
| `wrangler d1 execute viw_researcher_dev --env dev --file ... --remote` | ✅ | DB name is `viw_researcher_dev`, not `voter-info-d1` (latter is binding name). Needed `--config=wrangler.toml` because a stray `wrangler.jsonc` in the parent dir was getting picked up first. 5 changes, 12 rows written, 4.8ms. |
| Verify: `SELECT bill_id, direction FROM bills WHERE bill_id IN ('118-HR-2445','118-S-2552')` | ✅ | Both `neutral`, with AC-59.7 direction_reason. |
| Verify audit rows | ✅ | Both `audit_v4_1_0_hr2445` and `audit_v4_1_0_s2552` present with `action='direction_corrected'`. |
| Re-run migration | ✅ | Idempotent. 2 rows read, 0 rows written on the second pass — INSERT OR IGNORE prevented PK conflict. |

## Phase 4 — Open dev PR

| Item | State | Notes |
|---|---|---|
| Bump version to v4.1.0-rcN | ✅ rc2 | rc1 → 4.1.0-rc.1; rc2 → 4.1.0-rc1 (renamed). Bumped on transport rewrite. |
| Push branch to origin | ✅ | rc2 pushed at 3717a91; merge-from-main pushed at 4d77a5c |
| Open PR chore/coverage-deep-pass → main | ✅ | [PR #120](https://github.com/co-op-game-studio/track-ukraine-widget/pull/120) |
| Merge from origin/main | ✅ | Two conflict files (docs/spec.md, proxy/routes/api-upstream.ts); both were "main also fixed edge-tier bug independently". Took their `edgeKeyToUrl(target, upstreamPath, key)` helper (cleaner extraction), kept my detailed AC-40.11 (with regression-test forbidden case + ADR-019 reference). 157 files / 2189 tests after merge (+3 new tests from their edge-key-to-url.test.ts). |
| Verify CI on PR | ✅ | `lint-typecheck-test` passed in 3m16s. |
| Merge to main (dev-env scope only) | ✅ | Merge commit `9ca48fad` on main at 2026-05-26T20:19:39Z. Branch preserved for any rollback. |

## Phase 5 — Trigger seed workflow on dev

| Item | State | Notes |
|---|---|---|
| `gh workflow run seed-bills.yml --field env=dev` | ✅ | Run 26472884297 triggered at 2026-05-26T20:20:34Z. |
| Watch run | ✅ | Dev seed step ran in 46s. UAT/stg/prod matrix slots correctly skipped per the env-input gate. |
| Verify: `became_law=1` count | ✅ | **8 bills** marked law (exceeds AC-59.5 minimum of 4): 117-HR-2471, 117-HR-6833, 117-HR-6968, 117-HR-7108, 117-HR-7691, 117-S-3522, 118-HR-2670, 118-HR-815. |
| Verify: 119th cosponsors present | ✅ | 18/21 119th bills with cosponsors, 525 cosponsor rows total. Was 0/21 pre-v4.1.0. |
| CI idempotency check | ✅ | CI run was steady-state (`63/63 cached, 0 fresh`) — the 5 freshly-pulled bills from my local run had been written to D1; CI immediately observed them as already-current via the bill-level freshness gate. AC-59.10 byte-identical idempotency verified end-to-end. |

## Phase 6 — Frontend smoke

| Item | State | Notes |
|---|---|---|
| Boot dev admin SPA via Claude-in-Chrome | ✅ | Home Chrome browser selected. User completed CF Access SSO manually. |
| First SPA observation | ⚠️ Issue 3 | PeopleTab showed "510 people · 1276 handles" — no coverage metric, no "no handles tracked" caption. v4.1.0 frontend NOT yet deployed to dev (last Deploy run was 2026-05-06). |
| Trigger Deploy workflow on dev | 🟡 | Run 26474574064 queued at 2026-05-26T20:54:16Z. |
| Settings ▸ Data freshness loads | ⬜ | After deploy completes |
| PeopleTab shows ~535 cards | ⬜ | After deploy completes |
| Megamenu has "Data freshness" link | ⬜ | After deploy completes |

## Phase 7 — Final RC tag + report

| Item | State | Notes |
|---|---|---|
| All phases above ✅ | ⬜ | |
| Tag `v4.1.0-rcN` (final) | ⬜ | After last iteration |
| Update changelog with RC trail | ⬜ | |

---

## Issues found

### Issue 1 — `wrangler d1 execute --command=…` fails when SQL contains commas/spaces (2026-05-26, rc1)

**Symptom:** First real seed call against dev errored with `wrangler d1 execute exit 3221226505: Unknown arguments: bill_id,, congress,, type,, number, FROM, bills, WHERE, bill_id, ORDER, BY, bill_id, ASC, LIMIT, 1`.

**Root cause:** `scripts/lib/d1-client.ts` shells out via `spawn('npx', [..., '--command=<SQL>'], { shell: true })`. On Windows (and probably POSIX too) the shell tokenizes the `--command=` value on whitespace + commas, splitting one SQL statement into many positional args wrangler refuses.

**Severity:** BLOCKER for the seed CLI. The unit tests all use the in-memory `FakeD1`, so this never surfaced.

**Fix in flight (rc2):** rewrite `makeWranglerD1` → `makeRestD1` using the Cloudflare D1 REST API directly (`POST /accounts/{acct}/d1/database/{db_id}/query`). Same auth as `kvInvalidate`. Adds a D1-database-ID map (already discovered from `wrangler.toml`).

**v4.1.0 punch-list addition:** the unit tests for `d1-client.ts` need to grow to cover *real* SQL parsing — a fake that mirrors wrangler's argv tokenization would have caught this. Tracked for v4.1.1.

### Issue 2 — main had its own edge-tier cache fix already (2026-05-26)

**Symptom:** PR #120 opened with `mergeStateStatus: DIRTY` / `mergeable: CONFLICTING`. Conflict files: `docs/spec.md`, `proxy/routes/api-upstream.ts`.

**Root cause:** Between the time I branched off `46ea5bd` and now, `main` landed PR #101 ("Fixed caching bug") which independently fixed the same edge-tier defect with a different but equivalent shape:
- **Main's fix (kept):** extracted helper `edgeKeyToUrl(target, upstreamPath, key)` that appends `cacheKeyToDottedString(key)` to URL pathname with `#` separator. Has its own test file `tests/unit/routes/edge-key-to-url.test.ts` (3 tests).
- **My fix (dropped):** inline lambda setting `searchParams.set('__ck', cacheKeyToDottedString(k))`.

Both encode the full dotted form into the URL; both make the URL injective over CacheKey. Main's is cleaner (extracted helper, dedicated test file).

**Resolution:**
- Took main's `proxy/routes/api-upstream.ts` (`edgeKeyToUrl` helper).
- Kept my more detailed AC-40.11 in `docs/spec.md` (includes forbidden-case test requirement + ADR-019 reference). Updated the AC body to reference the new helper by name.
- My regression test in `tests/unit/routes/query-and-cache.test.ts` survives unchanged — it asserts upstream-call separation regardless of whether the helper uses `#` or `__ck=` to differentiate URLs. Still passes.

**Net:** 157 test files / 2189 tests after the merge (was 156/2186 pre-merge). Typecheck clean. Both AC-40.11 implementations coexist (mine in docs, main's in code) and converge on identical behavior.

**Lesson:** check `gh pr list --state merged --base main` BEFORE branching long-lived release branches — this merge was avoidable. Tracked for v4.1.0 retrospective.

### Issue 3 — dev SPA showed old v4.0.0 build at Phase 6 first attempt (2026-05-26)

**Symptom:** Navigated to `https://dev.vote.cogs.it.com/admin` post-CF-Access-login. PeopleTab header showed "510 people · 1276 handles" — no coverage metric. No "no handles tracked" caption visible.

**Root cause:** Merging PR #120 to main does NOT auto-deploy. The branch model is `main → develop → uat → stg → prod`; Deploy workflow only triggers on push to develop/uat/stg/prod (or `workflow_dispatch`). Last Deploy run was 2026-05-06 (v4.0.0 hotfixes). The dev SPA + Worker still ran the v4.0.0 code; only D1 had been mutated (because the seed CLI talks to D1 directly, bypassing the Worker entirely).

**Resolution:** Triggered `Deploy` workflow with `env=dev` via `workflow_dispatch`. Will re-verify SPA after deploy completes.

**v4.1.0 punch-list addition (consider for v4.1.1):** the rollout-log Phase ordering needs a "Deploy to dev" step BEFORE the SPA smoke step. The current ordering assumed PR merge → deploy, which is wrong for this repo's ladder. Documented for future releases.

### Issue 4 — `workflow_dispatch` on Deploy rejected: "Branch 'main' not allowed to deploy to dev" (2026-05-26)

**Symptom:** Triggered `Deploy` workflow with `env=dev` via `gh workflow run deploy.yml --field env=dev`. Run failed at the `deploy` job: "Branch 'main' is not allowed to deploy to dev due to environment protection rules."

**Root cause:** GitHub environment protection rules on the `dev` environment restrict pushes to specific branches (`develop`, NOT `main`). The branch model is `main → develop → uat → stg → prod` per [memory project_branch_model](memory/project_branch_model.md): main is trunk; promotion to dev requires fast-forwarding `develop` to `main`.

**Resolution:** Switched to `develop` locally (stashed rollout-log edit first), `git merge --ff-only origin/main` (80 commits fast-forwarded clean), `git push origin develop`. Deploy workflow triggered on `push:branches:[develop]` rule (run 26474749521). Switched back to `chore/coverage-deep-pass` and restored stash.

**Pattern for future v4.x rollouts:**
1. Merge PR to main.
2. `git checkout develop && git merge --ff-only origin/main && git push origin develop` (auto-triggers Deploy to dev).
3. Verify dev SPA + endpoints.
4. Promote develop → uat → stg → prod via PRs at each ladder step.

### Issue 5 — Worker deploy failed: `node:crypto` import bleeding from CLI lib (2026-05-26)

**Symptom:** Deploy run 26474749521 cleared typecheck, tests, build, KV publish, D1 migrations — failed at `Deploy Worker` (wrangler) with: `Uncaught Error: No such module "node:crypto". imported from "worker.js"`.

**Root cause:** `scripts/lib/trace.ts` (CLI lib) imported `randomBytes` from `node:crypto`. The Worker adapter `proxy/services/import-bill.ts` imports `makeD1AuditLogger` from `scripts/lib/audit-log.ts`, which transitively imports `scripts/lib/trace.ts`. Vite bundled the whole graph into the Worker; the Cloudflare runtime rejects `node:` imports because nodejs_compat isn't enabled on this Worker.

**Resolution:**
- Rewrote `scripts/lib/trace.ts` to use Web Crypto (`globalThis.crypto.getRandomValues`) instead of `node:crypto`. Web Crypto is native in both Node 19+ and Cloudflare Workers — same code, both runtimes.
- Removed the now-unnecessary `/// <reference types="node" />` directive from `scripts/lib/d1-client.ts` (the REST transport doesn't use any Node builtins).
- Typed `globalThis.crypto` narrowly via a `CryptoLike` interface so we don't pull in `@cloudflare/workers-types` or `lib.dom.d.ts` into the CLI tsconfig.

**v4.1.0 punch-list addition (consider for v4.1.1):**
- Add a CI check that imports `proxy/worker.ts` into a Cloudflare-Worker-shaped vitest environment and asserts no `node:*` imports leak through the dependency graph. Would have caught this at the typecheck step instead of the deploy step.

**rc bump:** v4.1.0-rc2 → v4.1.0-rc3 after the trace.ts rewrite.


## RC bumps

- v4.1.0-rc1: initial cut
- v4.1.0-rc2: switch D1 transport wrangler-shell → REST API (Issue 1)
- v4.1.0-rc3: rewrite scripts/lib/trace.ts to use Web Crypto, removing the node:crypto leak into the Worker bundle (Issue 5)

---

## Decisions made during rollout

(populated as work progresses)
