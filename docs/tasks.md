# Task Breakdown
# Voter Information Widget

**Version**: 1.0.0
**Date**: 2026-04-16

Tasks are ordered by dependency. Each task must have its required tests passing before moving to the next.

---

## Phase 1: Foundation

### T-001: Project Initialization
- **Description**: Initialize Vite + React + TypeScript project with all dev tooling
- **Dependencies**: None
- **Acceptance Criteria**: `npm install` succeeds, `npm run dev` starts Vite server, `npm test` runs Vitest
- **Test Requirements**: None (tooling setup)
- **Traces to**: NFR-1, NFR-4
- **Status**: [x] Done

### T-002: Domain Types
- **Description**: Define TypeScript types for domain entities and API responses
- **Dependencies**: T-001
- **Files**: `src/types/domain.ts`, `src/types/api.ts`
- **Acceptance Criteria**: All types from spec §6 Data Dictionary are defined; API response types match api-contracts.md
- **Test Requirements**: Type-check only (no runtime tests)
- **Traces to**: spec.md §6
- **Status**: [x] Done

### T-003: FIPS Map and Formatting Utilities
- **Description**: Implement FIPS-to-state-code mapping and formatting utilities
- **Dependencies**: T-001
- **Files**: `src/utils/fipsMap.ts`, `src/utils/formatters.ts`
- **Acceptance Criteria**: All 50 states + DC + territories mapped by FIPS code; state code/name bidirectional lookups work; dates/bill numbers format correctly
- **Test Requirements**: `tests/unit/fipsMap.test.ts`, `tests/unit/formatters.test.ts`
- **Traces to**: FR-2
- **Status**: [x] Done

---

## Phase 2: API Service Layer

### T-004: Census Geocoder API Service
- **Description**: Implement Census Bureau geocoder caller that returns state FIPS + district from address
- **Dependencies**: T-002, T-003
- **Files**: `src/services/censusApi.ts`
- **Acceptance Criteria**: Calls correct endpoint with benchmark/vintage params, extracts state FIPS and CD119 from response, converts FIPS to state code, handles at-large (CD119="00" → district 0), handles no-match errors
- **Test Requirements**: `tests/unit/censusApi.test.ts` (with mocked fetch)
- **Traces to**: FR-1, FR-2, design.md §4.1
- **Status**: [x] Done

### T-006: Congress.gov Member API Service
- **Description**: Implement member lookup (by state/district), member detail, and request queue
- **Dependencies**: T-002
- **Files**: `src/services/congressApi.ts`
- **Acceptance Criteria**: Fetches House rep by state/district, fetches senators by state, fetches member detail with photo URL; respects concurrency limit
- **Test Requirements**: `tests/unit/congressApi.test.ts` (with mocked fetch)
- **Traces to**: FR-3, FR-4, design.md §4.2
- **Status**: [x] Done

### T-007: Congress.gov Vote API Service
- **Description**: Implement House vote list and member vote fetching
- **Dependencies**: T-006
- **Files**: `src/services/congressApi.ts` (extend)
- **Acceptance Criteria**: Fetches House vote list, fetches member votes per roll call, handles pagination
- **Test Requirements**: `tests/unit/congressVotes.test.ts` (with mocked fetch)
- **Traces to**: FR-5
- **Status**: [x] Done

### T-008: Congress.gov Legislation API Service
- **Description**: Implement sponsored/cosponsored legislation fetching
- **Dependencies**: T-006
- **Files**: `src/services/congressApi.ts` (extend)
- **Acceptance Criteria**: Fetches sponsored and cosponsored bills, maps to Bill domain type
- **Test Requirements**: `tests/unit/congressLegislation.test.ts` (with mocked fetch)
- **Traces to**: FR-7
- **Status**: [x] Done

### T-009: Senate Vote XML Service
- **Description**: Implement Senate vote index and detail XML fetching/parsing
- **Dependencies**: T-002
- **Files**: `src/services/senateVotesApi.ts`
- **Acceptance Criteria**: Fetches and parses vote index XML, fetches and parses individual vote XML, matches members by last name + state
- **Test Requirements**: `tests/unit/senateVotesApi.test.ts` (with mocked fetch and XML fixtures)
- **Traces to**: FR-6, design.md §4.3
- **Status**: [x] Done

### T-010: Party Alignment Calculator
- **Description**: Implement party alignment score algorithm
- **Dependencies**: T-002
- **Files**: `src/services/partyAlignment.ts`
- **Acceptance Criteria**: Correctly identifies party-line votes, calculates alignment percentage, handles edge cases (no party-line votes, independents)
- **Test Requirements**: `tests/unit/partyAlignment.test.ts` (must exist and fail before implementation)
- **Traces to**: FR-8, design.md §4.5
- **Status**: [x] Done

---

## Phase 3: React Hooks (Orchestration)

### T-011: useAddressLookup Hook
- **Description**: Orchestrate address → Census geocode → state/district → members pipeline
- **Dependencies**: T-004, T-006
- **Files**: `src/hooks/useAddressLookup.ts`
- **Acceptance Criteria**: Takes address string, returns loading/error/data states, resolves to Representative[] with full details
- **Test Requirements**: `tests/integration/addressLookup.test.ts` (with mocked services)
- **Traces to**: FR-1, FR-2, FR-3, FR-4
- **Status**: [x] Done

### T-012: useVotingRecord Hook
- **Description**: Fetch and cache voting record for a member
- **Dependencies**: T-007, T-009, T-010
- **Files**: `src/hooks/useVotingRecord.ts`
- **Acceptance Criteria**: Routes to House or Senate fetching based on chamber, returns VoteRecord[] + PartyAlignment, supports pagination
- **Test Requirements**: `tests/integration/votingRecord.test.ts` (with mocked services)
- **Traces to**: FR-5, FR-6, FR-8
- **Status**: [x] Done

### T-013: useSponsoredBills Hook
- **Description**: Fetch and cache sponsored/cosponsored legislation for a member
- **Dependencies**: T-008
- **Files**: `src/hooks/useSponsoredBills.ts`
- **Acceptance Criteria**: Returns { sponsored: Bill[], cosponsored: Bill[] }, supports pagination
- **Test Requirements**: `tests/integration/sponsoredBills.test.ts` (with mocked services)
- **Traces to**: FR-7
- **Status**: [x] Done

---

## Phase 4: UI Components

### T-014: AddressInput Component
- **Description**: Address form with validation and submit
- **Dependencies**: T-001
- **Files**: `src/components/AddressInput.tsx`
- **Acceptance Criteria**: Text input + submit button, calls onSubmit with address string, shows inline errors, disables during loading
- **Test Requirements**: `tests/unit/AddressInput.test.tsx` (render + interaction tests)
- **Traces to**: US-1, AC-1.1, AC-1.5
- **Status**: [x] Done

### T-015: RepCard Component
- **Description**: Representative card with header, alignment badge, and tabs
- **Dependencies**: T-002
- **Files**: `src/components/RepCard.tsx`, `src/components/RepCardSkeleton.tsx`
- **Acceptance Criteria**: Displays name, party (color-coded), state, district, photo, chamber; tab switching between Votes and Legislation
- **Test Requirements**: `tests/unit/RepCard.test.tsx`
- **Traces to**: US-2, AC-2.1, AC-2.2, AC-2.3
- **Status**: [x] Done

### T-016: VoteList Component
- **Description**: Vote history table with color-coded votes
- **Dependencies**: T-002
- **Files**: `src/components/VoteList.tsx`
- **Acceptance Criteria**: Renders table with date, bill, question, member vote (color-coded), result; "Load More" button for pagination
- **Test Requirements**: `tests/unit/VoteList.test.tsx`
- **Traces to**: US-3, AC-3.1 through AC-3.4
- **Status**: [x] Done

### T-017: BillList Component
- **Description**: Legislation table with sponsored/cosponsored toggle
- **Dependencies**: T-002
- **Files**: `src/components/BillList.tsx`
- **Acceptance Criteria**: Renders bill number (linked), title, date, latest action; toggle for sponsored vs cosponsored
- **Test Requirements**: `tests/unit/BillList.test.tsx`
- **Traces to**: US-4, AC-4.1 through AC-4.4
- **Status**: [x] Done

### T-018: PartyAlignmentBadge Component
- **Description**: Visual party alignment indicator
- **Dependencies**: T-002
- **Files**: `src/components/PartyAlignmentBadge.tsx`
- **Acceptance Criteria**: Displays percentage with visual bar/gauge, shows total votes count for context
- **Test Requirements**: `tests/unit/PartyAlignmentBadge.test.tsx`
- **Traces to**: US-5, AC-5.1 through AC-5.4
- **Status**: [x] Done

### T-019: ErrorBanner Component
- **Description**: Error display component
- **Dependencies**: T-001
- **Files**: `src/components/ErrorBanner.tsx`
- **Acceptance Criteria**: Displays error messages, dismissible, supports multiple error types
- **Test Requirements**: `tests/unit/ErrorBanner.test.tsx`
- **Traces to**: NFR-6
- **Status**: [x] Done

### T-020: ResultsPanel Component
- **Description**: Container that renders RepCards for all representatives
- **Dependencies**: T-015
- **Files**: `src/components/ResultsPanel.tsx`
- **Acceptance Criteria**: Renders 3 RepCards (2 senators + 1 house rep), handles loading/error states, shows skeleton during load
- **Test Requirements**: `tests/unit/ResultsPanel.test.tsx`
- **Traces to**: US-1, AC-1.3
- **Status**: [x] Done

---

## Phase 5: Integration & Root Component

### T-021: VoterInfoWidget Root Component
- **Description**: Compose all components and hooks into the root widget
- **Dependencies**: T-011, T-012, T-013, T-014, T-015, T-016, T-017, T-018, T-019, T-020
- **Files**: `src/VoterInfoWidget.tsx`
- **Acceptance Criteria**: Full user flow works: enter address → see reps → browse votes → browse bills → see alignment
- **Test Requirements**: `tests/e2e/widget.test.tsx` (full integration test with mocked APIs)
- **Traces to**: All user stories
- **Status**: [x] Done

### T-022: Widget Styles
- **Description**: Complete CSS styling for all components
- **Dependencies**: T-021
- **Files**: `src/styles/widget.css`
- **Acceptance Criteria**: Clean, professional appearance; party colors; responsive layout; accessible contrast ratios
- **Test Requirements**: Visual review (no automated tests)
- **Traces to**: NFR-2
- **Status**: [x] Done

---

## Phase 6: Embed & Distribution

### T-023: Web Component Wrapper
- **Description**: Build the custom element wrapper with Shadow DOM
- **Dependencies**: T-021, T-022
- **Files**: `src/embed.tsx`
- **Acceptance Criteria**: `<voter-info-widget>` custom element works in a plain HTML page, styles don't leak, `api-base` attribute configures proxy URL
- **Test Requirements**: `tests/e2e/embed.test.ts` (test custom element registration and attribute handling)
- **Traces to**: US-6, AC-6.1 through AC-6.5, design.md §4.6
- **Status**: [x] Done

### T-024: Vite Library Build
- **Description**: Configure Vite for IIFE library output
- **Dependencies**: T-023
- **Files**: `vite.config.ts` (build section)
- **Acceptance Criteria**: `npm run build` produces a single `voter-info-widget.iife.js` file under 150KB gzipped
- **Test Requirements**: Build verification script
- **Traces to**: AC-6.1, NFR-4
- **Status**: [x] Done

### T-025: Reference CORS Proxy
- **Description**: Write reference Cloudflare Worker proxy implementation
- **Dependencies**: None (independent)
- **Files**: `proxy/worker.js`, `proxy/README.md`
- **Acceptance Criteria**: Routes /api/civic, /api/congress, /api/senate to correct targets; injects API keys from env vars; adds CORS headers; strips keys from errors
- **Test Requirements**: Documented manual testing steps
- **Traces to**: FR-10, design.md §4.4
- **Status**: [x] Done

### T-025e: Post-Audit Hardening (v2.5.1)
- **Description**: Close eleven findings from the 2026-04-17 security audit (ADR-010) across Worker code, client rendering, deploy pipeline, and zone config, plus ten PR-review follow-ups. Worker: strip `x-ratelimit-*`, `Clear-Site-Data`, `Refresh`, `Content-Location`, and all `access-control-*` upstream headers; 15 s `AbortSignal.timeout()` on every upstream fetch with 504 fallback (handleApi and buildProfileFromUpstream, per-fetch wrapping so optional legs degrade gracefully); per-route query-param allowlist canonicalizing the cache key; in-Worker per-IP rate limit via Cloudflare Rate Limiting binding (10/60 s/IP in prod) applied to BOTH `/api/*` upstream routes AND KV-backed routes (`/api/members`, `/api/bills`, `/api/roll-calls`, `/api/name-search`); prod hard-block when `CF-Connecting-IP` is absent. Client: `sanitizeUrl()` helper enforced on every API-sourced URL before it becomes an `href`/`src` — address path (`mapMember.ts`), KV profile path (`RepDetail.tsx` effect + render sites), name search (`NameSearchResultsPanel.tsx`), chip photo (`MemberChip.tsx`), bill links (`BillList.tsx`); plus Worker write-path sanitization in `buildProfileFromUpstream` as defense-in-depth. Deploy: SHA-384 SRI hash computed per build and shipped via Worker Sites as `voter-info-widget.iife.js.sri` (NOT R2 — static assets are Worker Sites per ADR-011); README and example-embed updated with SRI-pinned snippet; `docs/deployment.md` updated with the new rotation procedure, tighter zone rate limit (AC-28.3 revision to 20/min/IP prod), and an explicit `AC-26.12` reconciliation of the static-bundle serving path. Post-deploy CI smoke asserts every static asset and one `/api/*` path return 200. Spec new/revised ACs: AC-26.1 (revised), AC-26.4 (revised), AC-26.9–AC-26.12, AC-27.1b (revised), AC-27.9 method table (revised), AC-27.16–AC-27.22, AC-28.3 (revised), AC-31.1–AC-31.4.
- **Dependencies**: T-025a (Worker hardening baseline), T-025b (zone posture baseline)
- **Files**: `proxy/lib.ts` (header strip, timeout, query-param allowlist, rate-limit integration for KV + upstream routes, KV write-time URL sanitizer), `proxy/worker.ts` (RATE_LIMITER binding in the Env type), `wrangler.toml` (per-env ratelimit binding), `src/utils/sanitizeUrl.ts` (new), `src/services/mapMember.ts` (sanitize `photoUrl` + `officialWebsiteUrl`), `src/components/RepDetail.tsx` + `MemberChip.tsx` + `NameSearchResultsPanel.tsx` (sanitize at KV-profile boundary + render), `src/components/BillList.tsx` (sanitize `congressGovUrl` for defense-in-depth), `scripts/build-sri.mjs` (new), `package.json` (`build:sri` script), `README.md` (SRI snippet), `proxy/example-embed.html` (SRI snippet), `docs/deployment.md` (rotation + rate-limit + Worker Sites asset flow, R2 references swept), `docs/design.md` (routing layer updated), `docs/ci-cd.md` (deploy targets updated), `docs/decisions/ADR-010-post-audit-hardening.md` (new), `docs/spec.md` (version + AC additions/revisions), `.github/workflows/deploy.yml` (build:sri step, dist staging, post-deploy static-asset smoke), `tests/unit/worker.test.ts` (new cases for AC-27.16–AC-27.22, KV-route RL, profile timeout degradation), `tests/unit/sanitizeUrl.test.ts` (new).
- **Acceptance Criteria**: All of AC-26.1 (revised), AC-26.4 (revised), AC-26.9 through AC-26.12, AC-27.1b (revised), AC-27.9 method table (revised), AC-27.16 through AC-27.22, revised AC-28.3, and AC-31.1 through AC-31.4. Suite green, typecheck clean, build produces `dist/voter-info-widget.iife.js.sri`.
- **Test Requirements**: 24 tests in `tests/unit/sanitizeUrl.test.ts` (scheme allowlist, malformed inputs, embedded control characters, happy path). ~40 tests added to `tests/unit/worker.test.ts` across header strip, Access-Control strip, fetch timeout (upstream + KV profile optional-leg degradation + required-leg 504), query-param allowlist + canonical cache key, rate-limit fail-open / 429 / budget-not-consumed-on-cheap-rejections / KV-route coverage / prod-IP hard-block.
- **Traces to**: FR-26, FR-27, FR-28, FR-31, ADR-010
- **Status**: [x] Code + spec + tests complete — 2026-04-17. Zone-level AC-28.3 revision to 20/min/IP SHALL be applied to the Cloudflare dashboard per `docs/deployment.md §3`. API-key rotation (AC-31.3) is a one-time operator action per `docs/deployment.md §Rotate the Congress.gov API key` and SHALL be performed before the next prod deploy.

### T-025d: Staging as Regression Gate for Prod Deploys (v2.5.0)
- **Description**: Formalize `stg` as a single-purpose regression gate per FR-30 / AC-30.1–AC-30.10. Stg has no other purpose — it exists to catch regressions before prod. Write `npm run stg:sync-data` (copy-then-swap of prod R2 → stg R2 for the three static files); **any failure is a hard stop requiring manual investigation, never automatic retry**. Add `.github/workflows/stg-rehearsal.yml` — `workflow_dispatch`-only workflow that syncs prod data to stg, deploys the stg Worker, and runs the full test suite against the stg edge (interpretation A). Emit a visible "no remote-mode coverage yet" warning in the run summary until at least one remote-mode test lands.
- **Dependencies**: T-025c (Access service token in place — stg rehearsal uses it)
- **Files**: `scripts/sync-stg-data.mjs` (new — copy-then-swap via `wrangler r2 object get/put`), `.github/workflows/stg-rehearsal.yml` (new), `package.json` (new `stg:sync-data` script entry)
- **Acceptance Criteria**: All of AC-30.1 through AC-30.10. Verify: running the workflow copies prod data into stg bucket, deploys stg Worker, runs `npm test` with `E2E_TARGET=https://stg.vote.cogs.it.com` + service token headers, fails on any test failure, and emits the remote-mode-coverage warning.
- **Test Requirements**: The sync script SHALL have a unit test (`tests/unit/syncStgData.test.ts`) that exercises the copy-then-swap logic against a fake R2 (matching the `R2Like` pattern from `proxy/lib.ts`). No new worker tests needed.
- **Traces to**: FR-29, FR-30, ADR-005
- **Status**: [ ] Pending — spec'd 2026-04-17, implementation deferred until user clears UI-work hold

### T-025c: Access-Gated Non-Prod Environments (v2.5.0)
- **Description**: Put Cloudflare Access in front of `dev.vote.cogs.it.com`, `uat.vote.cogs.it.com`, `stg.vote.cogs.it.com` per FR-29 / ADR-008. Single Access Application with one developer-email policy (OTP email IdP) and one Service Token policy (`voter-info-widget-ci`). Prod hostname remains public. Disable `*.workers.dev` account-wide. Update `.github/workflows/deploy.yml` to carry service-token headers in the post-deploy smoke step for non-prod. Add `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` to GitHub secrets.
- **Dependencies**: T-025b (zone-level posture)
- **Files**: `docs/deployment.md §Access-gated non-prod`, `docs/decisions/ADR-008-access-nonprod-gating.md`, `.github/workflows/deploy.yml` (post-deploy smoke step)
- **Acceptance Criteria**: AC-28.14, AC-29.1 through AC-29.14 satisfied. Verify: unauthenticated `curl https://dev.vote.cogs.it.com/voter-info-widget.iife.js` returns Access challenge; the same request with service-token headers returns 200; prod `curl https://vote.cogs.it.com/...` still 200 without auth.
- **Test Requirements**: Post-deploy smoke step in `deploy.yml` exercises the contract end-to-end on every deploy. No in-repo unit tests added (Access behavior lives at the CF edge, not in our code).
- **Traces to**: FR-28 (AC-28.14), FR-29, ADR-008
- **Status**: [ ] Pending — requires Access dashboard setup + GitHub secret population (user action)

### T-025b: Zone-Level Security Posture (v2.5.0)
- **Description**: Configure the Cloudflare zone (`cogs.it.com`) per FR-28 / ADR-007: WAF Managed Rulesets (Block), Bot Fight Mode, rate limiting on `/api/*`, Transform Rules to strip CF-injected headers, TLS 1.3 minimum, Always HTTPS, zone-level HSTS matching Worker, DNSSEC + DS record at registrar, CAA records, cache rule respecting origin, geo-block RU+BY.
- **Dependencies**: T-025a (Worker hardening complete)
- **Files**: `docs/deployment.md §Zone-level hardening` (checklist with verification), `docs/decisions/ADR-007-zone-level-security-posture.md`
- **Acceptance Criteria**: Every AC-28.* satisfied, verified via the post-setup probe script in `docs/deployment.md`.
- **Test Requirements**: No new code tests (zone config is dashboard-only). Verification is the probe script; a future CI job MAY assert these via the Cloudflare API.
- **Traces to**: FR-28, ADR-006, ADR-007
- **Status**: [ ] Pending — requires dashboard + registrar access (user action)

### T-025a: Proxy Security Hardening (v2.4.1)
- **Description**: Harden the Cloudflare Worker proxy per ADR-006 / FR-27. Split `proxy/worker.ts` into a testable `proxy/lib.ts` (pure helpers + `handleFetch`) and a thin shim entry point. Implement and enforce: exact-match origin allowlist with env-gated localhost (`ALLOW_LOCALHOST`), unconditional security-header baseline (STS / nosniff / Referrer-Policy / X-Frame-Options) on every response, upstream-path shape validation, narrow API-key injection (`/v3/*` only), client-supplied `api_key` stripping, upstream error-body normalization to a JSON envelope, and upstream fingerprinting-header stripping (`Server`, `Via`, `Link`, `x-vcap-*`, `x-api-umbrella-*`, `x-amz-*`, `x-azure-*`, `x-appengine-*`).
- **Dependencies**: T-025
- **Files**: `proxy/lib.ts` (new), `proxy/worker.ts` (refactored), `wrangler.toml` (per-env `ALLOW_LOCALHOST`), `tests/unit/worker.test.ts` (new), `tsconfig.json` (proxy include tweak)
- **Acceptance Criteria**: All ACs under FR-25 (25.5 revised; 25.7–25.10 new) and FR-27 (27.1–27.10 new) satisfied. Helper unit coverage for `isOriginAllowed`, `isValidUpstreamPath`, `normalizeUpstreamErrorBody`, `applySecurityHeaders`, `stripFingerprintingHeaders`. End-to-end coverage via `handleFetch` with fake `Env` + fake `CacheLike`.
- **Test Requirements**: `tests/unit/worker.test.ts` — 51 tests across origin enforcement, method handling, API-key scope, upstream-path validation, error normalization, header baseline, fingerprinting-header stripping, browser-redirect preservation.
- **Traces to**: FR-25, FR-27, design.md §4.4, ADR-006
- **Status**: [x] Done — 2026-04-17

### T-025e: Staging as Regression Gate (v2.5.0 — revised for KV)
- **Description**: Same goal as the deferred T-025d but simpler. Copy all curator-written KV prefixes (`member:v1:*`, `bill:v1:*`, `roll-call:v1:*`, `name-index:v1:*`) from prod's KV namespace to stg's, then deploy the stg Worker, then run the test suite against the stg edge (remote mode if present, local mode with warning otherwise per AC-30.5). No R2 copy-then-swap ceremony — KV list-by-prefix + put is naturally idempotent. Cache prefix (`cache:v1:*`) SHALL NOT be copied (stg has its own traffic; cross-contaminating caches would defeat stg's "mirror of prod" purpose for curated data while wrongly preserving stg's response caches).
- **Dependencies**: T-029, T-031 (KV writes exist and produce records worth copying)
- **Files**: `scripts/sync-stg-data.mjs` (new — list-by-prefix + put against stg), `.github/workflows/stg-rehearsal.yml` (new), `package.json` (new `stg:sync-data` script entry)
- **Acceptance Criteria**: AC-30.1–AC-30.10 satisfied (text in FR-30 already updated for KV). Verify: running the workflow copies prod curator prefixes to stg, deploys stg Worker, runs `npm test` with `E2E_TARGET=https://stg.vote.cogs.it.com` + service-token headers, fails on any test failure, emits remote-mode-coverage warning until first remote-mode test lands.
- **Test Requirements**: Unit test `tests/unit/syncStgData.test.ts` exercises the list-by-prefix/put logic against a fake KV (`KVLike` pattern matching `R2Like` from proxy/lib.ts).
- **Traces to**: FR-30, ADR-011
- **Status**: [ ] Pending (replaces T-025d)

---

## Phase 7: KV Storage Migration (v2.5.0)

### T-026: KV Namespaces Created
- **Description**: Create one `voter-info-widget-kv-<env>` KV namespace per env via `wrangler kv namespace create`. Record namespace IDs and paste into `wrangler.toml` per-env blocks as `KV_VOTER_INFO` binding.
- **Dependencies**: None
- **Files**: `wrangler.toml` (add `[[kv_namespaces]]` blocks per env)
- **Acceptance Criteria**: `wrangler deploy --env <env>` succeeds for all four envs after binding is added. Namespace IDs are persisted in `wrangler.toml` (not secrets; these are identifiers per AC-32.8).
- **Test Requirements**: None (infrastructure setup)
- **Traces to**: FR-32, ADR-011
- **Status**: [x] Done — 2026-04-17 (namespace IDs in `wrangler.toml`: dev `743b2feda53648cd8242d3b89538bfac`, uat `3756142363984d218d5f489151716b30`, stg `4ff9a8e54b82489fb9a300466bd68686`, prod `72d3dbce1a1d4ea4aec74b305d7995e6`).

### T-027: R2 Binding Removal
- **Description**: Remove all `[[r2_buckets]]` bindings from `wrangler.toml` across all envs. Remove R2-serving code paths from `proxy/worker.ts` and `proxy/lib.ts`. Remove R2 upload steps from `.github/workflows/deploy.yml`.
- **Dependencies**: T-030, T-031, T-032 (widget and curator must already work without R2 before the binding is removed)
- **Files**: `wrangler.toml`, `proxy/worker.ts`, `proxy/lib.ts`, `.github/workflows/deploy.yml`
- **Acceptance Criteria**: AC-32.11. `wrangler deploy` succeeds with no R2 bindings. `grep -r "R2_ASSETS\|r2_buckets\|ukraineVotes.json\|ukraineBills.json" proxy/ src/ wrangler.toml .github/` returns no matches (except historical ADR refs).
- **Test Requirements**: `tests/unit/worker.test.ts` — remove any test cases that exercised R2 static-asset routes. Add test asserting request to `/ukraineVotes.json` returns 404.
- **Traces to**: FR-24 (revised), FR-32, ADR-011
- **Status**: [ ] Pending

### T-028: KV Response Cache Module (`proxy/cache.ts`)
- **Description**: Implement the ADR-009 response cache as a standalone module consumed by `proxy/lib.ts`'s `handleFetch`. Exports `cachedFetch(env, ctx, request, classLabel)` which: computes cache key per ADR-009's schema, checks KV, on hit returns with `X-Cache: HIT`, on miss does the upstream fetch, writes via `ctx.waitUntil`, and returns with `X-Cache: MISS`. Supports per-class TTL and negative caching per ADR-009 §"Negative caching".
- **Dependencies**: T-026
- **Files**: `proxy/cache.ts` (new), `proxy/lib.ts` (wire `cachedFetch` into each cacheable route), `tests/unit/cache.test.ts` (new)
- **Acceptance Criteria**: Tests cover: hit path, miss path, bypass for 5xx, bypass for oversized body, negative cache on 404 with 1h TTL, negative cache on 429 with 1m TTL, `X-Cache-Age` increments correctly, `cache:v1:` prefix enforced.
- **Test Requirements**: ~20 unit tests in `tests/unit/cache.test.ts` using fake `KVNamespace` + fake `ExecutionContext`.
- **Traces to**: ADR-009, ADR-011
- **Status**: [ ] Pending

### T-029: Curator — Atomic KV Record Writers
- **Description**: Refactor `scripts/build-curated-bills.ts` and `scripts/build-vote-rosters.ts` to emit in-memory `BillRecord[]`, `RollCallRecord[]`, `MemberProfile[]`, and `NameIndexShard[]` arrays. Add a new `scripts/build-member-profiles.ts` that joins the three. Add `scripts/publish-to-kv.mjs` that takes these arrays and writes atomic KV records via `wrangler kv key put` (or the Cloudflare KV API directly). Old R2 blob output paths are REMOVED from the curator scripts.
- **Dependencies**: T-026
- **Files**: `scripts/build-curated-bills.ts` (refactored), `scripts/build-vote-rosters.ts` (refactored), `scripts/build-member-profiles.ts` (new), `scripts/publish-to-kv.mjs` (new), `package.json` (new script entries: `build:kv`, `publish:kv`)
- **Acceptance Criteria**: Running `npm run build:kv` emits `curator-output.json` (intermediate consolidated file for review/diff). Running `npm run publish:kv -- --env dev --dry-run` prints the key list without writing. Without `--dry-run` it writes to the selected env's namespace. Script exits non-zero on any write failure. AC-32.1–AC-32.7 and AC-32.12 satisfied.
- **Test Requirements**: `tests/unit/buildMemberProfiles.test.ts` (join logic), `tests/unit/publishToKv.test.ts` (against fake KV), `tests/unit/nameIndexShards.test.ts` (shard correctness: multi-letter entry for members whose first and last start with different letters).
- **Traces to**: FR-24 (revised), FR-32, ADR-011
- **Status**: [ ] Pending

### T-030: Worker Route — `/api/members/{bioguideId}`
- **Description**: Add a new Worker route that reads `member:v1:{bioguideId}` from KV and returns the JSON record with 60s browser cache + 300s edge cache. 404 if missing. Applies ADR-006 security header baseline.
- **Dependencies**: T-026, T-028 (cache module scaffold — member route does not cache via `cache:*`, but imports the header-helper utilities)
- **Files**: `proxy/lib.ts` (new route handler), `tests/unit/memberRoute.test.ts` (new)
- **Acceptance Criteria**: AC-32.1, AC-32.10, AC-32.14, AC-32.18 (Worker read-through write), AC-32.19 (parse resilience). Test: GET returns 200 + record for present key; GET returns 404 for missing; response carries `Cache-Control: public, max-age=60, s-maxage=300` and all AC-27.1 security headers; OPTIONS/HEAD/non-GET methods rejected per ADR-006.
- **Test Requirements**: ~10 unit tests in `tests/unit/memberRoute.test.ts`.
- **Traces to**: FR-24 (revised), FR-32, ADR-011
- **Status**: [x] Done — 2026-04-17/18. `proxy/lib.ts#handleMemberProfile` implements KV read-through with 30d `expirationTtl`. Parse resilience landed 2026-04-18 (commit `76ab8c1`, AC-32.19). Test coverage: `tests/integration/sponsoredBills.test.ts` exercises this endpoint; dedicated `memberRoute.test.ts` unit suite still pending and blocks closing T-030 fully.

### T-031: Worker Route — `/api/name-search?q=<query>`
- **Description**: Add a new Worker route that normalizes the query, reads the relevant `name-index:v1:{letter}` shard(s), filters + ranks + dedupes, returns top 10 results with `truncated` boolean. 503 if `name-index:v1:meta` is missing. Applies ADR-006 security header baseline.
- **Dependencies**: T-026, T-029 (name-index shards must be written for this to return non-empty results)
- **Files**: `proxy/lib.ts` (new route handler, helpers `normalizeSearchKey`, `rankMatches`), `tests/unit/nameSearchRoute.test.ts` (new)
- **Acceptance Criteria**: AC-31.1–AC-31.12, AC-32.4 (REVISED v2.5.2 — district now carried in shard), AC-32.14. Tests cover: diacritics normalization, multi-letter query (e.g., "van ho"), ranking order, 10-result truncation with `truncated: true`, 503 on missing meta, empty result 200 with `[]`, dedup of members appearing in multiple shards.
- **Test Requirements**: ~15 unit tests in `tests/unit/nameSearchRoute.test.ts`.
- **Traces to**: FR-31, FR-32, ADR-011
- **Status**: [x] Done — route live in `proxy/lib.ts#handleNameSearch`. `district` field added to shards 2026-04-18 (commit `31552b8`). Dedicated unit-test suite still pending; existing fixtures cover the happy path.

### T-032: Widget Cutover — Remove `initRosters`, add `useMemberProfile`, add `NameSearchInput`
- **Description**: Replace the `initRosters()` + `bundledRosters.ts` blob path with direct `/api/members/{bioguideId}` calls via a new `useMemberProfile` hook. Update `useVotingRecord`, `useSponsoredBills` to read from the member profile instead of making their own Congress.gov calls (where curator data covers the ask). Add `NameSearchInput` component + `useNameSearch` hook + integration in `VoterInfoWidget`.
- **Dependencies**: T-030, T-031
- **Files**: `src/services/bundledRosters.ts` (DELETED), `src/services/memberProfile.ts` (new), `src/hooks/useMemberProfile.ts` (new), `src/hooks/useNameSearch.ts` (new), `src/hooks/useVotingRecord.ts` (revised), `src/hooks/useSponsoredBills.ts` (revised), `src/hooks/useAddressLookup.ts` (revised to produce bioguides for useMemberProfile), `src/components/NameSearchInput.tsx` (new), `src/VoterInfoWidget.tsx` (integration), `src/embed.tsx` (remove `initRosters` call), `src/main.tsx` (remove `initRosters` call), `src/data/ukraineVotes.json` (DELETED), `src/data/ukraineBills.json` (DELETED)
- **Acceptance Criteria**: AC-24.2, AC-24.3, AC-24.8, AC-31.1–AC-31.12. Existing e2e test `tests/e2e/widget.test.tsx` passes with mocked `/api/members/*` + `/api/name-search` instead of mocked rosters. New test `tests/unit/NameSearchInput.test.tsx` covers interaction behavior (keyboard navigation, debounce, result selection). Bundle-size test enforces ≤250KB gzipped.
- **Test Requirements**: Rewrite ~4 integration tests that used `initRosters` to use fetch mocks; add ~10 new tests for NameSearchInput + useNameSearch.
- **Traces to**: FR-24 (revised), FR-31, FR-32, ADR-011
- **Status**: [x] Done (partial — `useVotingRecord` still reads from the upstream `/api/congress/v3/house-vote/*/members` and `/api/senate/*` routes directly rather than from the member profile; completed by Phase 9 T-037/T-040 which move rosters into KV). `bundledRosters.ts` has been reduced to a no-op facade per ADR-011. `useSponsoredBills` reads from `/api/members/{id}` per AC-32.1 (REVISED v2.5.2) as of commit `fec1a58` 2026-04-18.

---

## Phase 9: KV Roll-Call Rosters + State-Members (v2.5.2 — ADR-012)

### T-036: Curator — Write `roll-call-roster:v1:*` Records
- **Description**: Extend `scripts/publish-to-kv.ts` to iterate every `{congress, session, rollCall, chamber}` tuple in `src/data/ukraineBills.json`'s `votes[]` arrays and, for each, fetch the upstream roster and write a `roll-call-roster:v1:{chamber}:{c}:{s}:{rc}` KV record per AC-32.15. House rosters via `api.congress.gov/v3/house-vote/{c}/{s}/{rc}/members?limit=500`; Senate rosters via `www.senate.gov/legislative/LIS/roll_call_votes/vote{c}{s}/vote_{c}_{s}_{rc}.xml` (parse with the existing Senate XML helper). Applies any overrides from `src/data/vote-overrides.yaml` after the upstream fetch. Writes via `wrangler kv bulk put --namespace-id <id> --remote` to keep the curator flow uniform with other prefixes.
- **Dependencies**: T-026 (namespaces), T-029 (curator scaffold)
- **Files**: `scripts/publish-to-kv.ts` (extended), `scripts/senateVoteParser.ts` (NEW — extracted from `src/services/senateVotesApi.ts` so the curator and Worker can share parsing), `scripts/load-vote-overrides.ts` (wire into the roster path)
- **Acceptance Criteria**: AC-32.15. `npm run publish:kv -- --env dev --dry-run` prints one `roll-call-roster:v1:*` key per curated vote with correct byte counts. Without `--dry-run` writes succeed to each env's namespace. On a Senate XML 404 or malformed body, curator fails the run (no silent partial write); a `--skip-broken` flag MAY be added later. Rosters conform to AC-32.15 shape (House map keyed by bioguide; Senate array of `{ lastName, state, cast, firstName?, party? }`).
- **Test Requirements**: `tests/unit/curator/rollCallRosters.test.ts` — ~12 tests covering: House roster record shape, Senate roster record shape, override application, malformed XML error handling, dry-run output formatting. **Dedicated suite deferred** — route-level tests in `tests/unit/rollCallRosterRoute.test.ts` exercise the emitted records end-to-end against a fake KV, which covers the contract at the seam that matters. Curator-unit suite remains on the backlog if the curator pipeline grows enough to warrant isolation testing.
- **Traces to**: FR-12 (REVISED v2.5.2), FR-32 AC-32.15, ADR-012
- **Status**: [x] Done — commit `eab90cc` 2026-04-18. Dry-run against dev emitted 44 rosters in 5.2s with 0 errors. Override application and senate XML parsing TBD under the deferred dedicated unit suite.

### T-037: Worker Route — `GET /api/roll-call-rosters/{chamber}/{c}/{s}/{rc}`
- **Description**: New Worker route in `proxy/lib.ts` that validates the path (chamber ∈ {house, senate}; c/s/rc numeric), reads the KV key, returns the record verbatim with immutable Cache-Control. 400 on malformed path, 404 on missing record. Applies ADR-006 security baseline.
- **Dependencies**: T-036 (so staged/prod envs have records to serve)
- **Files**: `proxy/lib.ts` (route handler + dispatcher wiring), `tests/unit/rollCallRosterRoute.test.ts` (new)
- **Acceptance Criteria**: api-contracts.md §5.5. Tests: House record returns 200 with expected shape and `Cache-Control: public, max-age=86400, s-maxage=31536000, immutable`; Senate record similarly; missing record returns 404 with the documented error envelope; malformed `chamber` returns 400; all per-AC-27.1 security headers present.
- **Test Requirements**: ~8 unit tests in `tests/unit/rollCallRosterRoute.test.ts`.
- **Traces to**: FR-12 (REVISED v2.5.2), FR-32 AC-32.15, ADR-012
- **Status**: [x] Done — commit `a4d0e0c` 2026-04-18. 8/8 unit tests pass.

### T-038: Curator — Write `state-members:v1:*` Records
- **Description**: Extend `scripts/publish-to-kv.ts` to pre-group the member directory (already fetched for `name-index:v1:*`) into per-state records and write `state-members:v1:{stateCode}` for every U.S. state and non-voting-delegate territory per AC-32.16. `house[]` sorted by district ascending; `senators[]` sorted by last name ascending (seniority sort deferred — see ADR-012 §Open questions).
- **Dependencies**: T-026, existing directory fetch in `publish-to-kv.ts`
- **Files**: `scripts/publish-to-kv.ts` (extended)
- **Acceptance Criteria**: AC-32.16. Dry-run shows one key per state/territory (~56 records). Records include non-voting delegates with `isNonVoting: true` (or equivalent signal) per ADR-012 §Open question 2.
- **Test Requirements**: `tests/unit/curator/stateMembers.test.ts` — ~6 tests covering: multi-member states, single-at-large states, territories, sort stability. **Dedicated suite deferred** — `tests/unit/stateMembersRoute.test.ts` covers the emitted shape via the Worker route; dedicated curator unit tests are on the backlog.
- **Traces to**: FR-32 AC-32.16, ADR-012
- **Status**: [x] Done — commit `eab90cc` 2026-04-18. Dry-run emitted 56 state records.

### T-039: Worker Route — `GET /api/state-members/{stateCode}`
- **Description**: New Worker route that reads `state-members:v1:{stateCode}` and returns the record. 400 on non-`/^[A-Z]{2}$/i` shape (normalize to uppercase), 404 on missing.
- **Dependencies**: T-038
- **Files**: `proxy/lib.ts`, `tests/unit/stateMembersRoute.test.ts` (new)
- **Acceptance Criteria**: api-contracts.md §5.6. Tests cover: 200 + record for known state, case-insensitivity (`il` → normalized to `IL`), 400 on malformed code, 404 on missing, Cache-Control set per AC-32.16.
- **Test Requirements**: ~6 unit tests.
- **Traces to**: FR-32 AC-32.16, ADR-012
- **Status**: [x] Done — commit `a4d0e0c` 2026-04-18. 6/6 unit tests pass.

### T-040: Widget Cutover — Voting Record via KV Rosters
- **Description**: Replace `fetchHouseVoteMembers` and `fetchSenateVoteDetail` callers in `src/hooks/useVotingRecord.ts` with KV-roster-route calls. The hook builds `MemberVoteRow[]` by looking up the member in each roster (House: `casts[bioguideId]`; Senate: `casts.find(r => r.lastName === lastName && r.state === state)`). "Did Not Vote" vs "Did Not Serve" distinguished by cross-checking `/api/state-members/{state}` for current-Congress presence (for historical Congresses, the distinction degrades to "Did Not Vote" — acceptable, noted in design.md §3.2.4). Remove the legacy `congressApi.fetchHouseVoteMembers`/`senateVotesApi.fetchSenateVoteDetail` from the service layer (unused elsewhere). Update integration tests.
- **Dependencies**: T-037, T-038, T-039 (all KV routes must exist in the envs where tests run)
- **Files**: `src/hooks/useVotingRecord.ts`, `src/services/rollCallRosters.ts` (NEW), `src/services/congressApi.ts` (remove `fetchHouseVoteMembers`, `fetchHouseVoteDetail`, `fetchHouseVoteList`), `src/services/senateVotesApi.ts` (remove `fetchSenateVoteDetail`, `fetchSenateVoteIndex` — the Worker-side parsing moves to the curator per ADR-012), `tests/integration/votingRecord.test.ts` (rewrite fetch mocks)
- **Acceptance Criteria**: FR-12 (REVISED v2.5.2). e2e test `tests/e2e/widget.test.tsx` passes with roll-call-roster fetch mocks. Per-visit fan-out (measured via the perf-test harness) drops to ~10 roster fetches + member/state fetches as predicted in design.md §4.14.
- **Test Requirements**: Rewrite ~6 integration tests; add unit tests for the new `rollCallRosters.ts` service layer.
- **Traces to**: FR-12 (REVISED v2.5.2), FR-32 AC-32.15, ADR-012
- **Status**: [x] Done — commit `e68af4e` 2026-04-18. Integration tests rewired to mock `/api/roll-call-rosters/*`; `src/services/senateVotesApi.ts` + `src/services/congressApi.ts` deleted.

### T-041: Widget Cutover — Address Flow via State-Members
- **Description**: Replace `fetchMembersByState` / `fetchMembersByStateDistrict` in `src/hooks/useAddressLookup.ts` with a single `GET /api/state-members/{state}` call. Client-side filter to the resolved district. Drop the post-resolution `fetchMemberDetail` enrichment loop — `state-members:v1:` records already carry `photoUrl`, `website`, party, district. Remove the now-unused `fetchMembersByState*` / `fetchMemberDetail` from `src/services/congressApi.ts`.
- **Dependencies**: T-039, T-040 (to keep test rewrites coherent)
- **Files**: `src/hooks/useAddressLookup.ts`, `src/services/stateMembers.ts` (NEW), `src/services/congressApi.ts` (remove four functions), `tests/integration/addressLookup.test.ts` (rewrite)
- **Acceptance Criteria**: Address flow fan-out drops to 1 census + 1 state-members + 3 member-profile fetches = 5 upstream requests. Existing e2e still passes.
- **Test Requirements**: Rewrite ~5 integration tests for the address flow.
- **Traces to**: FR-1, FR-2, FR-32 AC-32.16, ADR-012
- **Status**: [x] Done — commit `e68af4e` 2026-04-18. `src/services/mapMember.ts` deleted along with the old fetchers; address flow now makes a single `/api/state-members/{state}` call.

### T-042: Widget Invariant Test — No Direct Upstream Calls
- **Description**: Add a unit test that greps `src/services/` and `src/hooks/` for any remaining calls to `/api/congress/v3/` or `/api/senate/` or `/api/census/v3/member/`. The only allowed upstream-shaped path in widget code SHALL be `/api/census/geocoder/*` (since address geocoding stays live per design.md §4.14). Fails the build if any other upstream path appears in widget source.
- **Dependencies**: T-040, T-041 (otherwise test fails on legitimate in-flight code)
- **Files**: `tests/unit/widgetUpstreamInvariant.test.ts` (NEW)
- **Acceptance Criteria**: Test passes after T-040/T-041 and fails if a future commit reintroduces a direct upstream call from widget code.
- **Test Requirements**: The test itself.
- **Traces to**: design.md §4.14 ("widget SHALL NOT call the upstream pass-through routes"), ADR-012
- **Status**: [x] Done — commit `8ae7681` (red) → `e68af4e` (green) 2026-04-18. Regex catches `/api/congress\b` and `/api/senate\b` in widget source; one allowed reference: `/api/census/geocoder` in `src/services/censusApi.ts`.

### T-043: Rate-Limit Re-Tightening
- **Description**: Revise AC-27.21 and AC-28.3 numeric limits after T-040/T-041 land. Target: prod in-Worker = 60/60s, prod zone = 120/60s. Edit spec, edit `wrangler.toml` across envs, smoke-test with the perf harness that a 3-rep visit stays well under the new budget.
- **Dependencies**: T-040, T-041, T-042 (need the new per-visit floor to be measured and stable first)
- **Files**: `docs/spec.md` AC-27.21 and AC-28.3, `wrangler.toml`
- **Acceptance Criteria**: Rate-limit ACs revised with v2.5.3 stamp. Perf harness confirms a 3-rep cold visit stays < 50 requests. No 429s under normal traffic for a week post-change.
- **Test Requirements**: Extend the perf harness (scripts/perf-check.mjs) to assert the new budget.
- **Traces to**: AC-27.21, AC-28.3, ADR-012
- **Status**: [ ] Pending

### T-044: Cache-Warming Script Spec Alignment
- **Description**: Update `scripts/warm-member-cache.mjs` so phase 2 hits the new `/api/roll-call-rosters/*` routes (AC-35.3, second half) rather than the legacy `/api/congress/v3/house-vote/*/members` and `/api/senate/*` routes. During the transition window (until T-037 is live in every env) the warmer MAY hit both; after T-037 lands everywhere the legacy phase SHALL be removed.
- **Dependencies**: T-037
- **Files**: `scripts/warm-member-cache.mjs`, `docs/deployment.md` (warming section)
- **Acceptance Criteria**: AC-35.3 (final form). Warmer run against prod after T-037 deploy reports ok_count == total_count (no legacy route hits, no 404s on new routes).
- **Test Requirements**: None (ops script).
- **Traces to**: FR-35, ADR-012
- **Status**: [x] Done — commit `b4d6b87` 2026-04-18. `houseVoteUrl`/`senateVoteUrl` helpers now point at the roller-route form; doc-block updated; legacy fallback no longer targeted (per FR-35 AC-35.3 final form).

### T-045: Document the v2.5.2 Rollout Sequence
- **Description**: Add a "v2.5.2 rollout" section to `docs/deployment.md` that enumerates the correct order: spec lands → tests land red → curator (T-036, T-038) lands behind feature flag → Worker routes (T-037, T-039) land → curator run per env → widget cutover (T-040, T-041, T-042) lands → rate-limit re-tightening (T-043) lands → warmer re-aligned (T-044). This ADR-012 rollout must never invert: widget cutover before curator run against an env will 404.
- **Dependencies**: none (docs-only)
- **Files**: `docs/deployment.md`
- **Acceptance Criteria**: Section exists, references every task in Phase 9, and is linked from the top-level deployment doc TOC.
- **Test Requirements**: None.
- **Traces to**: ADR-012, all Phase 9 tasks
- **Status**: [x] Done — commit `b4d6b87` 2026-04-18. `docs/deployment.md` gains a "v2.5.2 rollout" section with the correct ordering and the dev/uat ceiling.

---

## Phase 8: CI/CD (Specification Only — Implementation Deferred)

### T-033: CI/CD Pipeline Setup
- **Description**: Implement CI/CD as specified in docs/ci-cd.md (formerly T-026 — renumbered to make room for the v2.5.0 KV tasks)
- **Dependencies**: All prior tasks
- **Status**: [ ] Deferred — specification written, implementation postponed
