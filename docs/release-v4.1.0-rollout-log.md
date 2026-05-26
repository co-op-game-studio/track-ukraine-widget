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
| Bump version to v4.1.0-rc1 | ⬜ | package.json |
| Push branch to origin | ⬜ | |
| Open PR chore/coverage-deep-pass → main | ⬜ | gh pr create |
| Verify CI on PR | ⬜ | Should pass against the 80/80/80/80 thresholds |
| Merge to main (dev-env scope only) | ⬜ | gh pr merge |

## Phase 5 — Trigger seed workflow on dev

| Item | State | Notes |
|---|---|---|
| `gh workflow run seed-bills.yml --field env=dev` | ⬜ | First real CI seed |
| Watch run via `gh run watch` | ⬜ | Expect exit 0 |
| Verify: query `bills` for `became_law=1` count | ⬜ | Should be ≥4 (HR-815, HR-2471, HR-6968, HR-7108) |
| Verify: 119th cosponsors+votes present | ⬜ | `SELECT congress, SUM(...)` |

## Phase 6 — Frontend smoke

| Item | State | Notes |
|---|---|---|
| Boot dev admin SPA preview | ⬜ | If CF Access auth needed → ASK USER |
| Settings ▸ Data freshness loads | ⬜ | Shows by-congress, by-direction, etc |
| PeopleTab shows ~535 cards (not 306) | ⬜ | Includes zero-handle members with caption |
| Megamenu has "Data freshness" link | ⬜ | |

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


## RC bumps

- v4.1.0-rc1: initial cut

---

## Decisions made during rollout

(populated as work progresses)
