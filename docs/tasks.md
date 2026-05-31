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
- **Status**: [x] DELETED 2026-04-19 — superseded by T-025e (KV-native replacement). The R2 copy-then-swap ceremony this task described predates ADR-011's datastore migration; see T-025e for the current shape. Kept as a pointer here; the block below is retained only as an historical marker, not as a live task.

### T-025c: Access-Gated Non-Prod Environments (v2.5.0)
- **Description**: Put Cloudflare Access in front of `dev.vote.cogs.it.com`, `uat.vote.cogs.it.com`, `stg.vote.cogs.it.com` per FR-29 / ADR-008. Single Access Application with one developer-email policy (OTP email IdP) and one Service Token policy (`voter-info-widget-ci`). Prod hostname remains public. Disable `*.workers.dev` account-wide. Update `.github/workflows/deploy.yml` to carry service-token headers in the post-deploy smoke step for non-prod. Add `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` to GitHub secrets.
- **Dependencies**: T-025b (zone-level posture)
- **Files**: `docs/deployment.md §Access-gated non-prod`, `docs/decisions/ADR-008-access-nonprod-gating.md`, `.github/workflows/deploy.yml` (post-deploy smoke step)
- **Acceptance Criteria**: AC-28.14, AC-29.1 through AC-29.14 satisfied. Verify: unauthenticated `curl https://dev.vote.cogs.it.com/voter-info-widget.iife.js` returns Access challenge; the same request with service-token headers returns 200; prod `curl https://vote.cogs.it.com/...` still 200 without auth.
- **Test Requirements**: Post-deploy smoke step in `deploy.yml` exercises the contract end-to-end on every deploy. No in-repo unit tests added (Access behavior lives at the CF edge, not in our code).
- **Traces to**: FR-28 (AC-28.14), FR-29, ADR-008
- **Status**: [x] Done — 2026-04-19. Access application configured by user with OTP email policy + service-token policy; `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` populated in GitHub secrets; `.github/workflows/deploy.yml` post-deploy smoke carries the service-token headers on dev/uat/stg; prod hostname remains public. Verified: unauthenticated curl to `https://dev.vote.cogs.it.com/voter-info-widget.iife.js` returns Access challenge; service-token-authenticated request returns 200; prod unauthenticated returns 200.

### T-025b: Zone-Level Security Posture (v2.5.0)
- **Description**: Configure the Cloudflare zone (`cogs.it.com`) per FR-28 / ADR-007: WAF Managed Rulesets (Block), Bot Fight Mode, rate limiting on `/api/*`, Transform Rules to strip CF-injected headers, TLS 1.3 minimum, Always HTTPS, zone-level HSTS matching Worker, DNSSEC + DS record at registrar, CAA records, cache rule respecting origin, geo-block RU+BY.
- **Dependencies**: T-025a (Worker hardening complete)
- **Files**: `docs/deployment.md §Zone-level hardening` (checklist with verification), `docs/decisions/ADR-007-zone-level-security-posture.md`
- **Acceptance Criteria**: Every AC-28.* satisfied, verified via the post-setup probe script in `docs/deployment.md`.
- **Test Requirements**: No new code tests (zone config is dashboard-only). Verification is the probe script; a future CI job MAY assert these via the Cloudflare API.
- **Traces to**: FR-28, ADR-006, ADR-007
- **Status**: [ ] Pending — requires Cloudflare dashboard + registrar access (user action). Detailed sub-checklist: (1) WAF Managed Rulesets on (start in Log mode, soak 24h to check for false positives on widget traffic, then flip to Block); (2) Bot Fight Mode on; (3) Zone-level rate limit on `/api/*` — current target 120/60s/IP per AC-28.3 v2.5.3; (4) Transform Rules stripping `CF-Ray` and `CF-Connecting-IP` from outbound; (5) TLS 1.3 minimum; (6) Always HTTPS on; (7) Zone-level HSTS matching Worker; (8) DNSSEC enabled + DS record pasted at registrar (takes ~15 min to propagate); (9) CAA records permitting only Cloudflare + Let's Encrypt; (10) Cache Rule "Respect origin cache-control" per AC-28.10; (11) Geo-block RU + BY. `docs/deployment.md §Zone-level hardening` has the verification probe script.

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
- **Status**: [ ] Pending — **Respec 2026-04-19 (v2.6.0)**: prefix list SHALL be `bill:v1:*`, `roll-call:v1:*`, `name-index:v1:*`, `roll-call-roster:v1:*`, `state-members:v1:*` (five prefixes; `member:v1:*` intentionally excluded — stg lazily rebuilds profiles; `cache:v1:*` excluded — env-local response cache). ADR-012 added `roll-call-roster:v1:*` + `state-members:v1:*` to the copy set after the original T-025e was written. The partial implementation in `scripts/sync-stg-data.ts` (copies 3 prefixes via `wrangler kv key list` + `put`) SHALL be extended to 5 and paired with `.github/workflows/stg-rehearsal.yml`. Not a blocker for v2.6.0 release — schedule after Phase 11 (tiered-cache refactor) so the stg rehearsal exercises the new cache pipeline, not the legacy curator path.

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

### T-027: R2 Binding Removal (v2.5.0 R2-as-datastore removal)
- **Description**: Remove all `[[r2_buckets]]` bindings from `wrangler.toml` across all envs. Remove R2-serving code paths from `proxy/worker.ts` and `proxy/lib.ts`. Remove R2 upload steps from `.github/workflows/deploy.yml`. Sweep stale R2 comments from `proxy/lib.ts` (lines 7, 10, 239) and `scripts/build-sri.mjs` (line 9). Delete `scripts/build-vote-rosters.ts` and the `ukraineVotes.json` artifact it produces (dead code post-ADR-011).
- **Dependencies**: T-030, T-031, T-032
- **Files**: `wrangler.toml`, `proxy/worker.ts`, `proxy/lib.ts`, `.github/workflows/deploy.yml`, `scripts/build-sri.mjs`, `scripts/build-vote-rosters.ts`
- **Acceptance Criteria**: AC-32.11. `wrangler deploy` succeeds with no R2 bindings. `grep -r "R2_ASSETS\|r2_buckets\|ukraineVotes.json" proxy/ src/ wrangler.toml .github/` returns no matches (`ukraineBills.json` is legitimately retained as the curated-bill source of truth).
- **Test Requirements**: Confirm dist/ audit shows no R2-era keys.
- **Traces to**: FR-24 (revised), FR-32, ADR-011
- **Status**: [x] Done — 2026-04-19. Binding removal is already in effect (wrangler.toml has had no `[[r2_buckets]]` entries since the ADR-011 migration). Remaining code sweep (stale comments + dead script) absorbed into **T-054** under Phase 11, since the new R2 tier (FR-41) reintroduces R2 with a different binding name (`R2_STATIC`) and different purpose; the two do not collide. **IMPORTANT:** This task retired `R2_ASSETS` (static-asset serving, replaced by Worker Sites). The new `R2_STATIC` binding under FR-41 is an archive-only tier for upstream bytes, unrelated to ADR-011's concern.

### T-028: KV Response Cache Module (SUPERSEDED by Phase 11)
- **Description**: The standalone ADR-009 KV response cache module described here was never implemented. It has been **superseded by FR-40 / ADR-014**, which subsumes the KV response cache into a unified tiered cache layer (tier 1) alongside the edge cache (tier 0) and the R2 static archive (tier 2). The `cache:v1:` KV prefix reserved by this task is retained and consumed by the new `KvTier` implementation. Standalone `proxy/cache.ts` module is NOT created — its responsibilities live in `proxy/cache/kv-tier.ts` per FR-42's topology.
- **Dependencies**: N/A — superseded.
- **Files**: No longer applicable. See Phase 11 tasks (T-055..T-063) for the tiered-cache implementation.
- **Acceptance Criteria**: Superseded by AC-40.1..AC-40.10, AC-41.1..AC-41.12.
- **Test Requirements**: Superseded by Phase 11 test plan (per-tier unit tests + TieredCache composition tests).
- **Traces to**: ADR-009 (superseded by ADR-014), FR-40
- **Status**: [x] Done (SUPERSEDED) — 2026-04-19. Task redirected to Phase 11.

### T-029: Curator — Atomic KV Record Writers
- **Description**: Refactor `scripts/build-curated-bills.ts` and `scripts/build-vote-rosters.ts` to emit in-memory `BillRecord[]`, `RollCallRecord[]`, `MemberProfile[]`, and `NameIndexShard[]` arrays. Add `scripts/publish-to-kv.ts` that writes atomic KV records via `wrangler kv bulk put --remote`.
- **Dependencies**: T-026
- **Files**: `scripts/publish-to-kv.ts`, `package.json` (`build:kv`, `publish:kv`)
- **Acceptance Criteria**: AC-32.1–AC-32.7 and AC-32.12 satisfied.
- **Test Requirements**: Route-level tests (`rollCallRosterRoute.test.ts`, `stateMembersRoute.test.ts`) cover the contract at the seam that matters. Dedicated `publishToKv.test.ts` remains backlog.
- **Traces to**: FR-24 (revised), FR-32, ADR-011
- **Status**: [x] Done — closed implicitly by Phase 9 (T-036, T-038). `scripts/publish-to-kv.ts` is live and has been exercised end-to-end against dev and uat namespaces for all six prefix kinds (member, bill, roll-call, name-index, roll-call-roster, state-members). **Deprecation note (2026-04-19):** per ADR-014/ADR-015, this curator script will be retired once Phase 11 lands — prewarming becomes a client of the Worker's public API, and the script is replaced by `scripts/warm.ts` (T-063).

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
- **Test Requirements**: Extend the perf harness (scripts/perf-check.mjs) to assert the new budget. **Deferred** — the post-ADR-012 fan-out of ~49 is measured from design.md §4.14; the perf harness change stays on the backlog, not blocking T-043.
- **Traces to**: AC-27.21, AC-28.3, ADR-012
- **Status**: [x] Done (spec only) — spec revised v2.5.3; `wrangler.toml` updated (prod/stg 60/60s, uat 120/60s); zone-level rule AC-28.3 adjustment is a CF dashboard action (user-only), tracked separately.

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

---

## Phase 10: Observability + Error Envelope (v2.6.0 — ADR-013)

### T-046: Structured Log Helper (`proxy/observability/log.ts`)
- **Description**: Implement `logEvent(ctx, { event, level, ...fields })` per FR-39. JSON-per-line via `console.log`. Secret redaction applied. No throws.
- **Dependencies**: T-047 (trace ID present in ctx)
- **Files**: `proxy/observability/log.ts` (new), `tests/unit/observability/log.test.ts` (new)
- **Acceptance Criteria**: AC-39.1 through AC-39.5.
- **Test Requirements**: ~8 tests — serialization, redaction, circular-ref fallback, level filtering, ctx threading.
- **Traces to**: FR-39
- **Status**: [x] Done (2026-04-19) — Shipped in feat(phase10) commit 9a50bef. proxy/observability/log.ts with 16 tests.

### T-047: Trace-ID Generation + Propagation (`proxy/observability/trace.ts`)
- **Description**: Implement `generateOrEchoTraceId(request)` per FR-36 AC-36.1. Validate pattern `/^tr_[0-9a-f]{16}$/`. Thread trace ID through every response, every upstream fetch, every log line.
- **Dependencies**: none
- **Files**: `proxy/observability/trace.ts` (new), `tests/unit/observability/trace.test.ts` (new)
- **Acceptance Criteria**: AC-36.1 through AC-36.4, AC-36.7.
- **Test Requirements**: ~10 tests — pattern validation, malformed-header replacement, crypto.randomUUID path, deterministic echo.
- **Traces to**: FR-36
- **Status**: [x] Done (2026-04-19) — Shipped in feat(phase10) commit 9a50bef. proxy/observability/trace.ts with 19 tests.

### T-048: Canonical Error Envelope (`proxy/observability/error-envelope.ts`)
- **Description**: Implement `ErrorEnvelope` type, closed-enum error codes, `asResponse(envelope, { status, headers })` helper. Migrate every existing error emitter in the proxy to use this path in the same PR. Delete `normalizeUpstreamErrorBody` + legacy shape consumers.
- **Dependencies**: T-047 (trace ID)
- **Files**: `proxy/observability/error-envelope.ts` (new), `proxy/lib.ts` or post-refactor modules (migrate callers), `src/services/errorEnvelope.ts` (new — widget-side parser), `tests/unit/observability/errorEnvelope.test.ts` (new), `tests/unit/errorEnvelope.widget.test.ts` (new)
- **Acceptance Criteria**: AC-37.1 through AC-37.8.
- **Test Requirements**: ~15 tests — one per error code value, retryable-flag matrix, widget-side parser, `Retry-After` on 429, userMessage vs message separation.
- **Traces to**: FR-37
- **Status**: [x] Done (2026-04-19) — Shipped in feat(phase10) commit 9a50bef. proxy/observability/error-envelope.ts + src/services/errorEnvelope.ts with 35 tests. Proxy-side error-emitter migration rides Phase 12 atomic rewrite.

### T-049: Workers Analytics Engine Binding + Writer (`proxy/observability/analytics.ts`)
- **Description**: Add `[[analytics_engine_datasets]]` binding per env in `wrangler.toml` (dataset `voter_info_widget_${ENV_NAME}`). Implement `writeAnalyticsPoint(env, ctx, payload)` helper. Wire into every `/api/*` response path via `ctx.waitUntil`. Writer SHALL NOT throw; failures fall through to `logEvent`.
- **Dependencies**: T-047
- **Files**: `wrangler.toml`, `proxy/observability/analytics.ts` (new), `tests/unit/observability/analytics.test.ts` (new)
- **Acceptance Criteria**: AC-38.1 through AC-38.6.
- **Test Requirements**: ~8 tests — field shape assertion, waitUntil wrapping, error fallback, per-env dataset naming, top-level-exception still emits.
- **Traces to**: FR-38
- **Status**: [x] Done (2026-04-19) — Shipped in feat(phase10) commit 9a50bef. proxy/observability/analytics.ts with 15 tests. Per-env [[analytics_engine_datasets]] in wrangler.toml.

### T-050: Widget Error UI with Trace-ID Surface
- **Description**: Update `ErrorBanner`, any error-bearing components (`ResultsPanel`, `RepDetail`, `NameSearchResultsPanel`) to render the FR-37 envelope's `userMessage` + trace ID. "Try again" button only on `retryable: true`. Trace ID styled muted + monospace + selectable.
- **Dependencies**: T-048 (widget-side parser exists)
- **Files**: `src/components/ErrorBanner.tsx`, `src/components/ResultsPanel.tsx`, `src/components/RepDetail.tsx`, `src/components/NameSearchResultsPanel.tsx`, relevant hook error handling, `tests/unit/ErrorBanner.test.tsx` (extend), plus new error-state tests per component
- **Acceptance Criteria**: AC-36.5, AC-36.6, AC-37.5, AC-37.8.
- **Test Requirements**: ~12 tests — trace-ID rendering, retry button presence/absence, userMessage rendering, accessibility of the retry control, fallback when trace ID absent.
- **Traces to**: FR-36, FR-37
- **Status**: [x] Done (2026-04-19) — Shipped in feat(phase10) commit 9a50bef. ErrorBanner gained traceId + onRetry props. Widget-side parseErrorEnvelope. Full un-skip of T-093 hook-wiring tests lands with T-097.

---

## Phase 11: Tiered Cache + R2 Static Archive (v2.6.0 — ADR-014)

### T-055: `CacheTier<V>` Interface + `CacheKey` + `CacheEntry` + `WritePolicy` types
- **Description**: Define the type surface per FR-40 AC-40.1..AC-40.4.
- **Dependencies**: none
- **Files**: `proxy/cache/tier.ts` (new), `proxy/cache/key.ts` (new — `CacheKey` + `CacheKind` enum), `proxy/cache/policy.ts` (new — `WritePolicy`), `tests/unit/cache/key.test.ts` (new)
- **Acceptance Criteria**: AC-40.1, AC-40.2, AC-40.3, AC-40.4.
- **Test Requirements**: ~6 tests for CacheKey serialization helpers.
- **Traces to**: FR-40
- **Status**: [x] Done (2026-04-19) — Shipped in feat(phase11) commit a3632f5. proxy/cache/{key,policy,tier}.ts with 10 tests.

### T-056: `TieredCache<V>` Composition Class (`proxy/cache/tiered-cache.ts`)
- **Description**: Implement the composition class per AC-40.5. Reads top-down, promotes on hit via `ctx.waitUntil`, stores-all-writable on miss. Tests use three `FakeTier`s.
- **Dependencies**: T-055
- **Files**: `proxy/cache/tiered-cache.ts` (new), `tests/fakes/fake-tier.ts` (new), `tests/unit/cache/tiered-cache.test.ts` (new)
- **Acceptance Criteria**: AC-40.5, AC-40.10.
- **Test Requirements**: ~12 tests — tier-order reads, promote-on-hit, store-on-miss, policy filter, waitUntil wrapping, idempotency, miss-all null.
- **Traces to**: FR-40
- **Status**: [x] Done (2026-04-19) — Shipped in feat(phase11) commit a3632f5. proxy/cache/tiered-cache.ts with 14 tests.

### T-057: `EdgeTier` Implementation (`proxy/cache/edge-tier.ts`)
- **Description**: Wraps `caches.default`. Serializes CacheKey to the canonical upstream URL. Translates `WritePolicy` into `Cache-Control` headers for storage.
- **Dependencies**: T-055
- **Files**: `proxy/cache/edge-tier.ts` (new), `tests/unit/cache/edge-tier.test.ts` (new)
- **Acceptance Criteria**: AC-40.1 (Edge implementation), AC-40.9 (header emission).
- **Test Requirements**: ~8 tests against `FakeCache` — get/put roundtrip, TTL header translation, immutable flag.
- **Traces to**: FR-40
- **Status**: [x] Done (2026-04-19) — Shipped in feat(phase11) commit cc71079. proxy/cache/edge-tier.ts with 9 tests.

### T-058: `KvTier` Implementation (`proxy/cache/kv-tier.ts`)
- **Description**: Wraps `KV_VOTER_INFO`. Serializes CacheKey to `cache:v1:{kind}:{serialized-params}`. Honors `expirationTtl` from `WritePolicy.maxAge`. Handles JSON serialization of the stored `CacheEntry` envelope.
- **Dependencies**: T-055
- **Files**: `proxy/cache/kv-tier.ts` (new), `tests/unit/cache/kv-tier.test.ts` (new)
- **Acceptance Criteria**: AC-40.1 (KV implementation).
- **Test Requirements**: ~10 tests against `FakeKv` — get/put, TTL, prefix enforcement, envelope parse failures, null on miss.
- **Traces to**: FR-40
- **Status**: [x] Done (2026-04-19) — Shipped in feat(phase11) commit cc71079. proxy/cache/kv-tier.ts with 10 tests.

### T-059: `R2Tier` Implementation (`proxy/cache/r2-tier.ts`)
- **Description**: Wraps `R2_STATIC`. Serializes CacheKey per AC-41.2. Gates writes on `policy.immutable === true && entry.sessionStatus === 'frozen'`. Stores metadata per AC-41.5. Serves verbatim bytes per AC-41.6.
- **Dependencies**: T-055, T-060 (congress-calendar — need currentCongress for eligibility)
- **Files**: `proxy/cache/r2-tier.ts` (new), `tests/unit/cache/r2-tier.test.ts` (new)
- **Acceptance Criteria**: AC-41.1, AC-41.2, AC-41.3, AC-41.5, AC-41.6.
- **Test Requirements**: ~15 tests against `FakeR2` — key serialization per kind, gate enforcement (policy.immutable false skips, sessionStatus live skips), metadata persistence, content-type roundtrip.
- **Traces to**: FR-41
- **Status**: [x] Done (2026-04-19) — Shipped in feat(phase11) commit cc71079. proxy/cache/r2-tier.ts with 19 tests.

### T-060: Congress Calendar Helpers (`proxy/upstreams/congress-calendar.ts`)
- **Description**: Pure functions `currentCongress(now)`, `currentSession(now)`, `isCongressFrozen(congress, session, now)`. Handle boundary dates (119th Congress: 2025-01-03 to 2027-01-03; sessions 1 odd years, 2 even years).
- **Dependencies**: none
- **Files**: `proxy/upstreams/congress-calendar.ts` (new), `tests/unit/upstreams/congress-calendar.test.ts` (new)
- **Acceptance Criteria**: AC-41.4.
- **Test Requirements**: ~10 tests — boundary dates, mid-year session computation, frozen/live classification.
- **Traces to**: FR-41
- **Status**: [x] Done (2026-04-19) — Shipped in feat(phase11) commit cc71079. proxy/upstreams/congress-calendar.ts with 19 tests.

### T-061: `UpstreamFetcher<V>` Interface + Per-Upstream Implementations
- **Description**: One fetcher per upstream: `SenateXmlFetcher`, `HouseRosterFetcher`, `HouseVoteDetailFetcher`, `BillActionsFetcher`, `BillSummariesFetcher`, `MemberDetailFetcher`, `CensusGeocoderFetcher`. Each `≤80 lines`. Each knows its upstream URL, parse, and `sessionStatus` classification.
- **Dependencies**: T-055, T-060
- **Files**: `proxy/upstreams/fetcher.ts` (interface), `proxy/upstreams/senate-xml-fetcher.ts`, `proxy/upstreams/senate-xml-parser.ts`, `proxy/upstreams/house-roster-fetcher.ts`, `proxy/upstreams/house-vote-detail-fetcher.ts`, `proxy/upstreams/bill-actions-fetcher.ts`, `proxy/upstreams/bill-summaries-fetcher.ts`, `proxy/upstreams/member-detail-fetcher.ts`, `proxy/upstreams/census-geocoder-fetcher.ts`, one test file per fetcher.
- **Acceptance Criteria**: AC-40.7, AC-41.4, AC-41.7 (Senate XML parse + defer-save to KV).
- **Test Requirements**: ~6–10 tests per fetcher against a mock `fetch`. Parser module gets its own coverage (XML shape, malformed-input resilience).
- **Traces to**: FR-40, FR-41
- **Status**: [x] Done (2026-04-19) — Shipped in feat(phase11+12-prep) commit 814c75e. All 7 fetchers + registry + Senate XML parser with 73 fetcher tests. Parser tightened post-audit in commit 431de03 (T-096 finding).

### T-062: `serveCached` Pipeline (`proxy/cache/pipeline.ts`)
- **Description**: The single request-dispatch function for every cacheable route per AC-40.6. Emits `X-Cache` + `X-Cache-Tier` headers. On upstream error emits FR-37 envelope + FR-39 log + FR-38 data point.
- **Dependencies**: T-056, T-057, T-058, T-059, T-061, plus Phase 10 (T-047, T-048, T-049 for error path)
- **Files**: `proxy/cache/pipeline.ts` (new), `proxy/routes/cache-config.ts` (new — per-route policy map), `tests/unit/cache/pipeline.test.ts` (new)
- **Acceptance Criteria**: AC-40.6, AC-40.8, AC-40.9, AC-41.9.
- **Test Requirements**: ~15 tests — hit path per tier (3 tests), miss-all path, upstream 429 (FR-37 rate_limited envelope), upstream 5xx, upstream timeout, config-driven policy enforcement, header emission.
- **Traces to**: FR-40
- **Status**: [x] Done (2026-04-19) — Shipped in feat(phase11) commit cc71079. proxy/cache/pipeline.ts + proxy/routes/cache-config.ts with 23 tests.

### T-063: Unified Prewarmer (`scripts/warm.ts`)
- **Description**: Replace `scripts/publish-to-kv.ts` + `scripts/warm-member-cache.mjs` with a single `scripts/warm.ts` that issues HTTP GETs to the target Worker for every prewarmable key. Walks current-Congress member directory + curated roll-calls, issues bounded-concurrency GETs, reports success/failure counts. Supports CF Access service-token headers.
- **Dependencies**: Phase 11 cache pipeline live in at least one env (so warmer has something to hit).
- **Files**: `scripts/warm.ts` (new), `scripts/publish-to-kv.ts` (DELETED), `scripts/warm-member-cache.mjs` (DELETED), `scripts/build-curated-bills.ts` (retained — builds the in-repo `ukraineBills.json`, unchanged), `package.json` (unify scripts)
- **Acceptance Criteria**: AC-35.1 through AC-35.6 (revised v2.6.0), AC-42.8, AC-41.8.
- **Test Requirements**: `tests/unit/warm.test.ts` — flag parsing, concurrency semantics, Access header threading, exit-code on failures. No network in unit tests.
- **Traces to**: FR-35 (revised), FR-41, FR-42
- **Status**: [ ] Deferred (2026-04-19) — DEFERRED — Replaces publish-to-kv.ts + warm-member-cache.mjs with scripts/warm.ts HTTP client. Coupled to live-wiring of serveCached in Phase 12.

### T-064: Per-Env R2 Bucket Provisioning
- **Description**: Create `voter-info-widget-archive-${env}` R2 buckets per env. Add `[[r2_buckets]]` bindings to `wrangler.toml` for each env as `R2_STATIC`. Document the provisioning step in `docs/deployment.md §R2 static archive tier`. Deploy workflow fails fast if binding is configured but bucket is absent (AC-41.11).
- **Dependencies**: none (operator action, code-light)
- **Files**: `wrangler.toml`, `docs/deployment.md`
- **Acceptance Criteria**: AC-41.1, AC-41.11.
- **Test Requirements**: None (infrastructure).
- **Traces to**: FR-41
- **Status**: [x] Done (2026-04-19) — Shipped in feat(phase11+12-prep) commit 814c75e. Per-env [[r2_buckets]] R2_STATIC bindings in wrangler.toml. Operator SHALL run wrangler r2 bucket create before first deploy.

---

## Phase 12: Proxy Module Decomposition (v2.6.0 — ADR-015)

### T-070: Scaffold New Module Tree Under `proxy/`
- **Description**: Create the empty directory skeleton per FR-42: `proxy/routes/`, `proxy/cache/`, `proxy/upstreams/`, `proxy/security/`, `proxy/observability/`, `proxy/kv/`. Each dir gets re-export shims from `proxy/lib.ts` for the one-shot migration period. This is a pure housekeeping move so subsequent file moves land at stable import paths.
- **Dependencies**: none
- **Files**: the new directory tree + re-export shim files.
- **Acceptance Criteria**: Every existing test passes against the stub-re-export layout.
- **Test Requirements**: None beyond existing suite (green baseline).
- **Traces to**: FR-42
- **Status**: [x] Partial (v2.6.0 scaffold). Complete: `proxy/cache/*` (owned implementations — T-055..T-059/T-062), `proxy/upstreams/*` (owned implementations — T-060/T-061/registry), `proxy/observability/*` (owned implementations — Phase 10 T-046..T-049), `proxy/routes/cache-config.ts` (owned — T-062), `proxy/security/{origin-allowlist,url-validator,headers}.ts` (re-export shims from lib.ts), `proxy/kv/{name-index,member-profile}.ts` (re-export shims from lib.ts). Remaining: `proxy/security/{cors,rate-limit,query-filter}.ts`, `proxy/kv/prefixes.ts`, and the route-family split under `proxy/routes/*` — these land atomically with T-075 because they're not pure helpers (they need to move together with their callers).

### T-071: Migrate `proxy/security/*` Modules
- **Description**: Move origin allowlist, CORS, security headers, rate-limit gate, URL validator, query filter out of `proxy/lib.ts` into their own files per FR-42 topology. Each file ≤300 lines. Tests split into `tests/unit/security/*.test.ts`.
- **Dependencies**: T-070
- **Files**: `proxy/security/origin-allowlist.ts`, `proxy/security/cors.ts`, `proxy/security/headers.ts`, `proxy/security/rate-limit.ts`, `proxy/security/query-filter.ts`, `proxy/security/url-validator.ts`, matching test files.
- **Acceptance Criteria**: AC-42.1, AC-42.2, AC-42.3, AC-42.6.
- **Test Requirements**: Port existing tests from `worker.test.ts` into per-module test files.
- **Traces to**: FR-42
- **Status**: [ ] Deferred (2026-04-19) — Deferred — Shims in proxy/security/* re-export from lib.ts today. Physical extraction lands atomically with T-075 (route-handler migration) because both changes share the god-module teardown path. Tests pass through the shims with no path change.

### T-072: Migrate `proxy/observability/*` Modules
- **Description**: Move Phase 10 observability code (already in its own files by T-046..T-049) into the final topology + tighten interfaces.
- **Dependencies**: T-070, Phase 10 complete
- **Files**: `proxy/observability/trace.ts`, `proxy/observability/log.ts`, `proxy/observability/analytics.ts`, `proxy/observability/error-envelope.ts`.
- **Acceptance Criteria**: AC-42.1, AC-42.2, AC-42.3.
- **Test Requirements**: Existing Phase 10 tests remain green.
- **Traces to**: FR-42
- **Status**: [ ] Deferred (2026-04-19) — Deferred — proxy/observability/* already owns its implementations as of Phase 10. No code migration required; the task closes when T-075 updates call-sites to use the direct paths instead of lib.ts re-exports.

### T-073: Migrate `proxy/kv/*` Helpers
- **Description**: Move `KV_PREFIXES` constant, `MemberProfile` type, `NameIndexEntry`, `normalizeSearchKey`, `rankMatches` into `proxy/kv/`.
- **Dependencies**: T-070
- **Files**: `proxy/kv/prefixes.ts`, `proxy/kv/member-profile.ts`, `proxy/kv/name-index.ts`, matching tests.
- **Acceptance Criteria**: AC-42.1, AC-42.2, AC-42.3.
- **Test Requirements**: Port existing tests.
- **Traces to**: FR-42
- **Status**: [ ] Deferred (2026-04-19) — Deferred — Shims in proxy/kv/{name-index,member-profile}.ts re-export from lib.ts. KV_PREFIXES is not yet exposed; lands with T-075.

### T-074: Migrate Cache + Upstream Modules (Phase 11 outputs)
- **Description**: Phase 11's cache + upstream modules (T-055..T-061) land in the final topology. This task is the acceptance gate that the Phase 11 tree conforms to FR-42 constraints (file sizes, cross-layer import rules, dependency injection).
- **Dependencies**: T-070, Phase 11 (T-055..T-063) complete
- **Files**: `proxy/cache/*`, `proxy/upstreams/*`.
- **Acceptance Criteria**: AC-42.1 through AC-42.7, AC-42.9.
- **Test Requirements**: `madge --circular proxy/` returns no cycles. `tsc --noEmit` clean.
- **Traces to**: FR-42
- **Status**: [ ] Deferred (2026-04-19) — Deferred — proxy/cache/* and proxy/upstreams/* already own their implementations. Acceptance gate (madge + tsc) runs once Phase 12 route-handler migration lands.

### T-075: Migrate Route Handlers (`proxy/routes/*`)
- **Description**: One file per route family. Each handler is a class implementing `RouteHandler` per AC-42.4. Each uses `serveCached` (from T-062) for cached routes. Each migrates in its own commit with its tests moved in the same commit.
- **Dependencies**: T-070, T-074
- **Files**: `proxy/routes/api-congress.ts`, `api-senate.ts`, `api-census.ts`, `api-members.ts`, `api-name-search.ts`, `api-roll-call-rosters.ts`, `api-state-members.ts`, `api-bills.ts`, `preview.ts`, `not-found.ts`, `cache-config.ts`. Tests move to `tests/unit/routes/*.test.ts`.
- **Acceptance Criteria**: AC-42.4, AC-42.6, AC-42.7.
- **Test Requirements**: Port + split existing `worker.test.ts` (1678 lines) into per-route test files, each ≤300 lines.
- **Traces to**: FR-42
- **Status**: [ ] Deferred (2026-04-19) — Deferred — Route-handler extraction is the hot path of Phase 12. Requires concurrent migration of proxy/lib.ts handlers + the 1678-line worker.test.ts split into per-route files + wiring serveCached into live routes. Biggest single change in the project; deserves its own PR with dedicated review.

### T-076: `router.ts` + `worker.ts` Final Wiring
- **Description**: Implement `proxy/router.ts` — a small class that holds a registry of `RouteHandler`s and dispatches via `pattern` + `methods`. `proxy/worker.ts` shrinks to ≤100 lines: instantiate tier clients, instantiate cache, instantiate fetchers, instantiate handlers, instantiate router, export the `fetch` callback that delegates to router.
- **Dependencies**: T-075
- **Files**: `proxy/router.ts` (new), `proxy/worker.ts` (rewritten).
- **Acceptance Criteria**: AC-42.1 (worker ≤100 lines), AC-42.4 (handlers via router), AC-42.6 (no behavior change).
- **Test Requirements**: End-to-end smoke — full existing test suite runs against the new entry point and is green.
- **Traces to**: FR-42
- **Status**: [ ] Deferred (2026-04-19) — Deferred — Depends on T-075.

### T-077: Delete `proxy/lib.ts` + Enforce File-Size Cap
- **Description**: Final cutover. Verify nothing imports from `proxy/lib.ts`; delete the file. Add a lint rule or pre-commit check enforcing the 300-line cap per AC-42.2 so this never recurs.
- **Dependencies**: T-076
- **Files**: Delete `proxy/lib.ts`. Add lint rule config.
- **Acceptance Criteria**: AC-42.1, AC-42.2 (forward-enforced).
- **Test Requirements**: Full suite green. `grep -r "from .*proxy/lib" proxy/ tests/ src/` returns no matches.
- **Traces to**: FR-42
- **Status**: [ ] Deferred (2026-04-19) — Deferred — Final cutover. Depends on T-075 + T-076.

---

## Phase 13: Test Ladder + CI Gating + Stress Testing (v2.6.0 — FR-44 / ADR-016)

### T-080: `serveCached` Integration Test (tier 2)
- **Description**: New `tests/integration/serveCached.test.ts` composing a real `TieredCache<string>` + real `EdgeTier` + real `KvTier` + real `R2Tier` + real `createUpstreamRegistry`, with only bindings faked (fake KV, fake R2, fake `caches.default`, stubbed `fetch`). Covers: cold-all-tiers → upstream → writes all eligible; edge hit; KV hit + promote to edge; R2 hit + promote to KV + edge; R2-ineligible route (member-detail) never writes to R2; upstream 429 → FR-37 envelope; upstream 5xx → retryable envelope; contentType roundtrip through tiers.
- **Dependencies**: All Phase 11 tasks (T-055..T-062) — already landed.
- **Files**: `tests/integration/serveCached.test.ts` (new) + `tests/integration/fixtures/fake-bindings.ts` (shared fake-bindings helper, split out to respect FR-42 AC-42.2 300-line cap).
- **Acceptance Criteria**: AC-44.1. 13 tests (target was ~12).
- **Test Requirements**: Itself — this IS the integration test.
- **Traces to**: FR-44, FR-40, ADR-014, ADR-016
- **Status**: [x] Done — 2026-04-19. Authored via subagent, verified locally (full suite green, typecheck + lint clean). Split file at 244 + 118 lines respects the cap.

### T-081: `matchRoute` × `serveCached` Integration Test (tier 2)
- **Description**: New `tests/integration/matchRoute.test.ts` driving 20+ sample `/api/*` paths through `matchRoute` → `serveCached` → fake tiers + stubbed fetch. Asserts header shape (`X-Cache`, `X-Cache-Tier`, `X-Trace-Id`) and FR-37 envelope on error for every CacheKind.
- **Dependencies**: T-080 (shares fixture pattern).
- **Files**: `tests/integration/matchRoute.test.ts` (new).
- **Acceptance Criteria**: AC-44.2. 24 tests across 9 describe blocks.
- **Test Requirements**: Itself.
- **Traces to**: FR-44
- **Status**: [x] Done — 2026-04-19. Authored via subagent, verified locally. File is exactly 300 lines (at cap). Every CacheKind matchRoute handles is covered; negative cases confirm KV-backed routes (members, bills, roll-call-rosters, name-search) correctly return null.

### T-082: Local E2E Worker Harness (tier 3)
- **Description**: Boot `wrangler dev --env preview` on a random free port. Stand up a Node fixture HTTP server on a second port returning canned Congress/Senate/Census responses. Point the Worker's upstream URLs at the fixture server via an `UPSTREAM_OVERRIDE_*` env var set. Expose helpers (`startWorker`, `startFixtureServer`, `teardown`) for e2e tests to consume.
- **Dependencies**: Phase 11 wiring of `serveCached` into live routes (pending, queued for Phase 12 atomic rewrite).
- **Files**: `tests/e2e/harness.ts` (new — shared by local + remote), `tests/e2e/worker-local.test.ts` (new), `scripts/start-fixture-server.ts` (new), `package.json` script entry `test:e2e:local`.
- **Acceptance Criteria**: AC-44.3, AC-44.4, AC-44.14. At least one assertion SHALL verify cache-tier serves on a second request (`X-Cache-Tier: edge` or `kv`). Duration ≤90 s.
- **Test Requirements**: Itself. Gated as a required CI job on `pr.yml`.
- **Traces to**: FR-44, ADR-016
- **Status**: [ ] Pending

### T-083: Remote E2E Harness + Golden-Flow Twin (tier 4)
- **Description**: Parallel `tests/e2e/remote.test.ts` using the shared `harness.ts` helpers but configured via `E2E_TARGET=https://...` + `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`. Remote-mode tests SHALL consult `E2E_TARGET` at module top and skip with a console note when unset (AC-44.13), so `npm test` locally keeps passing. At least the golden-flow from T-082 SHALL have a remote-mode twin here. Resolves the long-aspirational AC-30.5.
- **Dependencies**: T-082 (shared harness).
- **Files**: `tests/e2e/remote.test.ts` (new), `package.json` `test:e2e:remote` entry.
- **Acceptance Criteria**: AC-44.5, AC-44.13, AC-44.14, AC-30.5 (closed).
- **Test Requirements**: Itself.
- **Traces to**: FR-44, FR-30, ADR-016
- **Status**: [ ] Pending

### T-084: Stg KV Mirror — Full Prod-Prefix Sync
- **Description**: Extend `scripts/sync-stg-data.ts` to copy ALL six curator-owned prefixes verbatim from prod → stg (`member:v1:*`, `bill:v1:*`, `roll-call:v1:*`, `name-index:v1:*`, `roll-call-roster:v1:*`, `state-members:v1:*`). SHALL NOT copy `cache:v1:*` or R2 archive (stg must exercise cold-cache). Fail-loud on any write error. Supports `--dry-run` that prints the key counts per prefix.
- **Dependencies**: T-026 (KV namespaces exist).
- **Files**: `scripts/sync-stg-data.ts` (extend), `tests/unit/syncStgData.test.ts` (new — unit-test the copy loop against fake KVs).
- **Acceptance Criteria**: AC-44.6. Supersedes FR-30 AC-30.3.
- **Test Requirements**: Unit test covers: all 6 prefixes enumerated; cache prefix never in the copy set; error on write fails the run; dry-run prints counts, writes nothing.
- **Traces to**: FR-44, FR-30 (AC-30.3 superseded)
- **Status**: [ ] Pending

### T-085: Stg Rehearsal Workflow — Wire Sync + E2E + Stress
- **Description**: Create/extend `.github/workflows/stg-rehearsal.yml` to run in order: (1) `npm run stg:sync-data` (AC-44.6), (2) `wrangler deploy --env stg`, (3) `npm run test:e2e:local` smoke, (4) `E2E_TARGET=https://stg.vote.cogs.it.com npm run test:e2e:remote` (AC-44.5), (5) `npm run test:stress` against stg (AC-44.8). Any failure aborts; run summary SHALL emit stress budget numbers (AC-44.12).
- **Dependencies**: T-083, T-084, T-086.
- **Files**: `.github/workflows/stg-rehearsal.yml` (new).
- **Acceptance Criteria**: AC-44.7, AC-44.9, AC-44.10, AC-44.12.
- **Test Requirements**: Manual trigger + inspect run summary contains stress numbers.
- **Traces to**: FR-44, FR-30, ADR-016
- **Status**: [ ] Pending

### T-086: Stress Scenarios — Visitor-Flow Workload
- **Description**: `tests/stress/visitor-flow.stress.ts` exercising parametrized concurrent-visitor workload. Two scenarios: cold (fresh R2 + KV, 50 concurrent for 60s) and warm (same load after cold, caches warm). Assertions: p95 ≤ 5s, 0 Worker 5xx, upstream 429 ≤ 0 warm / ≤ 5 cold. Service token bypasses per-IP limit so stress can exceed 60/60s. Captures req/sec, p95, error rate, cache-hit ratio per tier — emitted to stdout for the workflow summary (AC-44.12).
- **Dependencies**: T-083 (same harness patterns for auth).
- **Files**: `tests/stress/visitor-flow.stress.ts` (new), `tests/stress/harness.ts` (new — concurrency + metrics helpers), `package.json` `test:stress` script.
- **Acceptance Criteria**: AC-44.8, AC-44.12. Duration ≤4 min.
- **Test Requirements**: Itself.
- **Traces to**: FR-44, ADR-016
- **Status**: [ ] Pending

### T-087: CI Gating — `pr.yml` Runs Tiers 1 + 2, Enforces 80% Branch Coverage on Changed Paths
- **Description**: Extend `.github/workflows/pr.yml` so the required `lint-typecheck-test` job runs both unit and integration tests (merge-blocking on failure). Add a separate `coverage-guard` job that runs `vitest --coverage --coverage.thresholds.branches=80` scoped to files changed in the PR under `proxy/**`, `src/services/**`, or curator scripts. Marks the PR failing if coverage drops below 80% on any touched module.
- **Dependencies**: T-080, T-081 (integration tests must exist first).
- **Files**: `.github/workflows/pr.yml` (extend).
- **Acceptance Criteria**: AC-44.10, AC-44.11.
- **Test Requirements**: Manual verification — open a PR that removes test coverage, confirm CI fails.
- **Traces to**: FR-44, ADR-016
- **Status**: [ ] Pending

### T-088: `deploy.yml` — Tier 3 Gate on Non-Prod Deploys
- **Description**: Extend `.github/workflows/deploy.yml` so pushes to `develop`, `uat`, `stg` run `test:e2e:local` BEFORE `wrangler deploy`. Failure blocks the deploy for that env. Prod continues to require the SHA-match-to-stg-rehearsal check per AC-30.6.
- **Dependencies**: T-082.
- **Files**: `.github/workflows/deploy.yml` (extend).
- **Acceptance Criteria**: AC-44.10.
- **Test Requirements**: Intentional failing e2e run verifies deploy is blocked.
- **Traces to**: FR-44, ADR-016
- **Status**: [ ] Pending

### T-089: Reconcile FR-30 AC-30.3 with FR-44 AC-44.6
- **Description**: In `docs/spec.md`, append "SUPERSEDED by FR-44 AC-44.6 (2026-04-19)" note to AC-30.3, AC-30.5. Preserve existing text as a historical marker — do NOT delete. Update `docs/deployment.md` stg-rehearsal section to reference FR-44 mechanics.
- **Dependencies**: FR-44 spec landed (this PR).
- **Files**: `docs/spec.md` (note additions), `docs/deployment.md` (section rewrite).
- **Acceptance Criteria**: Spec is internally consistent; no reader of FR-30 is misdirected to an obsolete sync procedure.
- **Test Requirements**: None (docs-only).
- **Traces to**: FR-44, FR-30
- **Status**: [ ] Pending

### T-090: Automate Prod-Promotion SHA-Match Check (AC-30.6 carry-forward)
- **Description**: Small GitHub Actions script invoked on push to `prod` that uses the GH API to locate the latest green `stg-rehearsal.yml` run at the same SHA. Fails the prod-deploy workflow if none found. Removes the honor-system element of AC-30.6.
- **Dependencies**: T-085 (stg rehearsal workflow exists).
- **Files**: `.github/workflows/deploy.yml` (new job `verify-stg-rehearsal`), small JS/TS checker script.
- **Acceptance Criteria**: AC-30.6 tightened from honor-system to mechanical.
- **Test Requirements**: Manual verification — attempt a prod push without a matching stg run; workflow blocks.
- **Traces to**: FR-44, FR-30 AC-30.6, ADR-016
- **Status**: [ ] Pending (lowest-priority of Phase 13)

### T-091: Integration — UpstreamRegistry Completeness (INT-1 / AC-44.15)
- **Description**: Integration test verifying every `CacheKind` matchRoute emits has a registered fetcher in `createUpstreamRegistry`. Enumerates sample CacheKeys for every kind matchRoute handles + a negative case for an unhandled kind.
- **Dependencies**: T-080, T-081 (pattern references).
- **Files**: `tests/integration/upstreamRegistry.test.ts` (new, 69 lines).
- **Acceptance Criteria**: AC-44.15. 11 tests (enumerated via `it.each`).
- **Test Requirements**: Itself.
- **Traces to**: FR-44 AC-44.15
- **Status**: [x] Done — 2026-04-19. Authored via subagent.

### T-092: Integration — Voting-Record Valence Chain (INT-2 / AC-44.16)
- **Description**: Composes `useVotingRecord` hook with real `rollCallRosters` + real `valence` + real `ukraineScore` services against fake fetch returning realistic House + Senate roster shapes. Asserts Yea→Aye normalization, roster-shape differences (bioguide map vs. last-name array), Did-Not-Vote markers, contributing count.
- **Dependencies**: T-080.
- **Files**: `tests/integration/votingRecord.valence.test.ts` (new, 238 lines).
- **Acceptance Criteria**: AC-44.16. 5 tests.
- **Test Requirements**: Itself.
- **Traces to**: FR-44 AC-44.16
- **Status**: [x] Done — 2026-04-19. Authored via subagent. Note: hook treats "member absent from roster" as "Did Not Serve" (filtered from `flat` entirely), not "Did Not Vote". Test asserts observable behavior (`flat.length === 0`).

### T-093: Integration — Hook Error → ErrorBanner Propagation (INT-3 / AC-44.17)
- **Description**: Renders each error-emitting hook-owning component (`ResultsPanel`, `NameSearchResultsPanel`, `RepDetail`) with a fake fetch returning a realistic FR-37 envelope for 429/500/404/400. Asserts ErrorBanner renders userMessage, traceId line, "Try again" button iff retryable.
- **Dependencies**: FR-43 ErrorBanner updates (already shipped).
- **Files**: `tests/integration/hookErrorBanner.test.tsx` (new, 172 lines).
- **Acceptance Criteria**: AC-44.17. 4 tests (1 pass, 3 skipped with rationale).
- **Test Requirements**: Itself.
- **Traces to**: FR-44 AC-44.17, FR-37
- **Status**: [x] Done (partial) — 2026-04-19. Test shipped as-is with 3 skipped entries documenting real wiring gaps: `NameSearchResultsPanel` renders errors as ad-hoc `<div role=status>` (no ErrorBanner); `RepDetail` forwards hook errors into `VoteList`/`BillList` sub-renderers (no ErrorBanner); `useAddressLookup` services convert non-ok responses via `throw new Error(...)` stringification, dropping the FR-37 envelope. See **T-097** for the wiring follow-up.

### T-094: Integration — sanitizeUrl at Render Boundary (INT-4 / AC-44.18)
- **Description**: Renders `MemberChip`, `BillList`, `RepDetail` with malicious URL values in every href/src field. Asserts no `<a href>`/`<img src>` in rendered DOM retains dangerous schemes. One positive-case test confirms valid https:// URLs pass through unchanged.
- **Dependencies**: none.
- **Files**: `tests/integration/sanitizeUrlBoundary.test.tsx` (new, 214 lines).
- **Acceptance Criteria**: AC-44.18. 4 tests.
- **Test Requirements**: Itself.
- **Traces to**: FR-44 AC-44.18
- **Status**: [x] Done — 2026-04-19. Authored via subagent. Finding: all three components DO sanitize at render boundary. Attack vectors: `javascript:`, `data:text/html`, `vbscript:`, `file://`, whitespace-prefixed `"   javascript:..."`. Positive test confirms real `https://*.senate.gov` + `https://www.congress.gov/...` URLs pass through unchanged.

### T-095: Integration — Observability Thread (INT-5 / AC-44.19)
- **Description**: Exercises a fake request flowing through `resolveTraceId` → `serveCached` → upstream-error → `asErrorResponse` → `logEvent` → `writeAnalyticsPoint`. Asserts same trace ID appears in response header, envelope, log line, analytics data point indexes[0].
- **Dependencies**: T-080 (pattern).
- **Files**: `tests/integration/observabilityThread.test.ts` (new, 174 lines).
- **Acceptance Criteria**: AC-44.19. 3 tests.
- **Test Requirements**: Itself.
- **Traces to**: FR-44 AC-44.19, FR-36, FR-37, FR-38, FR-39
- **Status**: [x] Done (partial) — 2026-04-19. Test shipped. Finding: `serveCached` does NOT currently invoke `logEvent` or `writeAnalyticsPoint` on its error or success paths. Test directly invokes both helpers with the same trace ID after the `serveCached` call to verify helper plumbing, and documents the gap. See **T-098** for the pipeline-wiring follow-up.

### T-096: Integration — Senate XML Parser Resilience (INT-6 / AC-44.20)
- **Description**: Exercises `SenateXmlFetcher` against fake fetch returning valid XML, HTML error page, truncated XML, empty 200. Asserts happy-path succeeds; malformed inputs throw catchable errors (not uncaught exceptions).
- **Dependencies**: none.
- **Files**: `tests/integration/senateXmlFetcherResilience.test.ts` (new). Parser tightened in `proxy/upstreams/senate-xml-parser.ts` to require `</roll_call_vote>` closing tag — a real bug the test surfaced (truncated XML silently returned empty roster pre-fix).
- **Acceptance Criteria**: AC-44.20. 3 tests.
- **Test Requirements**: Itself.
- **Traces to**: FR-44 AC-44.20, FR-41 AC-41.7
- **Status**: [x] Done — 2026-04-19. 3 tests green. Parser tightened in same commit to throw on truncated bodies (previously accepted silently).

### T-097: Wire FR-37 Envelope Through Widget Hooks (discovered via T-093 audit)
- **Description**: Audit from T-093 found that `useAddressLookup`, `useNameSearch`, `useVotingRecord`, `useSponsoredBills` services currently normalize non-ok responses to plain `new Error(...)` strings and drop the FR-37 envelope body. Only `VoterInfoWidget` renders `ErrorBanner`; other components (`NameSearchResultsPanel`, `RepDetail`'s vote/bill lists) render ad-hoc error divs. Work: (a) service layer should `parseErrorEnvelope(await response.json())` and attach the envelope to thrown errors; (b) every hook-owning component should render `ErrorBanner` with `userMessage` + `traceId` + `onRetry`; (c) retryable vs non-retryable drives retry-button visibility.
- **Dependencies**: T-048 (envelope module already shipped), T-050 (ErrorBanner accepts traceId + onRetry already).
- **Files**: `src/services/errorEnvelope.ts` gained `EnvelopedError` + `throwFromResponse` + `getEnvelopeFromError`. Services wired: `censusApi.ts`, `stateMembers.ts`, `rollCallRosters.ts`, `useSponsoredBills.ts` (hook-level fetch). Components extended: `VoterInfoWidget.tsx` (pulls envelope off lookup.error; binds onRetry to last-submitted address), `VoteList.tsx` + `BillList.tsx` (optional errorTraceId + errorOnRetry props render via ErrorBanner when present). `NameSearchResultsPanel` intentionally skipped — its error surface routes through `NameSearchInput`'s icon affordance by design.
- **Acceptance Criteria**: Extends AC-37.5, AC-37.8 coverage to the three hook-owning surfaces that render ErrorBanner. T-093's previously-skipped envelope tests un-skip for VoterInfoWidget, RepDetail (bills-retryable), RepDetail (bills-non-retryable). Remaining skip is documented-intentional (name-search routes differently).
- **Test Requirements**: 3 of the 4 T-093 tests un-skipped and green (`hookErrorBanner.test.tsx`). Envelope helper tests added to `errorEnvelopeWidget.test.ts` (4 new — `throwFromResponse` happy path, plain-Error fallback, `getEnvelopeFromError` on plain + non-Error values).
- **Traces to**: FR-37 AC-37.5, AC-37.8
- **Status**: [x] Done (2026-04-19) — service-boundary envelope plumbing + component opt-in props land together. useVotingRecord's intentional "swallow transient roster errors as Did Not Serve" behavior preserved; test rescoped to the bills path where the hook DOES propagate. Retry button bound to original caller state (last-submitted address for lookup; hook's `load()` for detail).

### T-098: Wire `logEvent` + `writeAnalyticsPoint` into `serveCached` Pipeline (discovered via T-095 audit)
- **Description**: Audit from T-095 found that `proxy/cache/pipeline.ts#serveCached` currently calls `asErrorResponse` on the upstream-error path but does NOT invoke `logEvent` or `writeAnalyticsPoint`. Trace ID is emitted into the response header + envelope (good) but does not reach Workers Logs or Analytics Engine for that request (bad — the primary observability goal of FR-36/FR-38/FR-39 is broken). Work: in `serveCached`, on the `catch` block AND on success, emit one `logEvent` (on error only, level=error) and one `writeAnalyticsPoint` (on every request) with the canonical fields from AC-38.2. Inject `LogContext` + `AnalyticsDatasetLike` + `env` label through `ServeCachedInput`.
- **Dependencies**: T-046, T-047, T-048, T-049 (all observability helpers shipped).
- **Files**: `proxy/cache/pipeline.ts` (extend ServeCachedInput, add calls), `tests/integration/observabilityThread.test.ts` (tighten assertions to verify pipeline-invoked calls, not manual ones).
- **Acceptance Criteria**: AC-38.2, AC-38.6, AC-39.2 become verifiable end-to-end.
- **Test Requirements**: 5 tests in `observabilityThread.test.ts` (up from 3) covering pipeline-invoked log+analytics on error, analytics-only on success, cache-hit analytics with cacheTier reflecting serving tier, no-observability back-compat, resolveTraceId round-trip.
- **Traces to**: FR-38 AC-38.2, FR-38 AC-38.6, FR-39 AC-39.2, FR-44 AC-44.19
- **Status**: [x] Done (2026-04-19) — `serveCached` extended with optional `ServeCachedObservability` bundle (env, routeClass, upstreamName, analytics binding). Success paths silent per AC-39.3; retryable errors log at `warn`, non-retryable at `error`. Back-compat preserved when field absent. Route handlers wire observability in Phase 12 T-075.

### T-099: UAT-driven UkraineScoreBadge responsive redesign + per-member breakdown + chip state line
- **Description**: Post-UAT feedback on the v2.6.0 score badge: (1) promote the title/score/descriptor into a single responsive row — title left, label+justification stacked and right-justified against the value at ≥640px, collapsing to a two-row grid with inline "label · justification" at <640px; (2) add a click-to-expand breakdown panel showing this member's actual contributing actions (sponsored/cosponsored bills + every row in `VotingRecordData.flat`) with per-row sign, amp×weight, contribution, and a footer with Σ/Σ = score; (3) make the gradient-bar+obstruction region a second toggle for the same panel; (4) color-code breakdown rows by valence using the existing `--viw-valence-*` tokens; (5) keep the bar and obstruction note ABOVE the panel in DOM order so expand/collapse never pushes them off-screen; (6) add a state-name line to every `MemberChip` (search chips were state-ambiguous for senators). Also fixed a display bug where `.viw-detail-slot`'s implicit grid column tracked the widest child's intrinsic size, pushing the detail panel 20px past its parent and clipping the right border on narrow viewports — constrained via `grid-template-columns: minmax(0, 1fr)`.
- **Dependencies**: FR-43 (shipped in v2.6.0), FR-15 (valence token palette), US-7.
- **Files**: `src/components/UkraineScoreBadge.tsx` (new `voting` + `bills` props, header split into title row + context-stack + value + caret, expandable breakdown panel with `<table>` of per-action contributions, secondary `.viw-score-bar-toggle` wrapping bar+obstruction), `src/components/RepDetail.tsx` (wires `votingRecord.data` + `bills.data` into the badge), `src/components/MemberChip.tsx` (adds `.viw-chip-state` line via `stateCodeToName`), `src/styles/widget.css` (responsive grid for header, breakdown table styling incl. mobile card-row layout, valence tinting on breakdown rows, short/full text variants, `.viw-detail-slot` grid column fix, `.viw-chip-state` styles).
- **Acceptance Criteria**: AC-43.4 (revised), AC-43.9, AC-43.10, AC-43.11, AC-43.12, AC-43.13, AC-7.8 (all new or revised in `docs/spec.md` under FR-43 and US-7).
- **Test Requirements**: `tests/unit/UkraineScoreBadge.test.tsx` extended — (a) existing tests updated to match new DOM (label stack instead of `.viw-score-context strong`, header row selector change); (b) new `FR-43 UAT: breakdown panel` describe-block with 5 tests covering default-collapsed state, header toggle, bar-region toggle, per-action row rendering + valence classes, skipped-row marking, footer Σ/score output; (c) new `FR-43 UAT: responsive text variants` describe-block asserting both `.viw-title-full`/`.viw-title-short` and `.viw-justification-full`/`.viw-justification-short` are present in DOM for CSS-driven swap. `tests/unit/MemberChip.test.tsx` extended with AC-7.8 coverage (full name rendering + unknown-code fallback). `tests/unit/ResultsPanel.test.tsx` test rescoped to target the heading element specifically since "Illinois" now also appears in chip state lines.
- **Traces to**: FR-43 AC-43.4 (revised), AC-43.9–AC-43.13; US-7 AC-7.8.
- **Status**: [x] Done (2026-04-19). 35 UkraineScoreBadge tests + 9 MemberChip tests + 6 scoreBreakdownPanel integration tests + 3 widget e2e tests + full suite of 895 tests green. Spec updated first (AIDD Phase 1), existing tests reconciled + new tests written (Phase 2), implementation followed (Phase 3). No `normalizeUpstreamErrorBody`-style debt introduced: the new behavior is purely additive to the React component tree. ADR not required — design follows the existing FR-43 palette and tokens.

### T-100: Structured Bill · Action cell + per-row expand in score breakdown (post-UAT feedback follow-up)
- **Description**: Second round of UAT feedback on T-099: the breakdown's "Bill / Vote" column was a single long string ("$95B National Security Supplemental (Apr 2024, incl. $61B Ukraine + REPO Act) — Senate actions: Senate agreed to the House amendment…") that pushed the numeric cells off the viewport and buried the actual slug. Refactor the cell into three stacked pieces of structured data — **slug** (e.g., `HR 815`, `S. 1241`), **description** (curated one-sentence bill label, truncated at 72 chars), and **action caption** (e.g., `Cloture — Voted Aye`, `Final passage — Voted Nay`, `Cosponsored`) — and make any row whose description or clerk-action text exceeds its inline display a `<button>` that toggles per-row expand revealing the full bill label and full clerk-action text. Drop the separate "Action" column now that its content lives inside the bill cell.
- **Dependencies**: T-099 (baseline breakdown panel already landed).
- **Files**: `src/components/UkraineScoreBadge.tsx` (new `formatBillSlug()` + `VOTE_KIND_LABEL` lookup, `BreakdownRow` restructured into `{slug, description, action, actionDetail}`, per-row `expandedRows` Set state, row cell renders `.viw-score-row-bill-slug`/`-desc`/`-action`/`-detail` children), `src/styles/widget.css` (grid-based `.viw-score-row-bill-toggle` layout; stacked children in column 1 with caret in column 2; mobile grid template updated to drop the removed action column).
- **Acceptance Criteria**: AC-43.14 (new, in `docs/spec.md` under FR-43).
- **Test Requirements**: 3 new unit tests in `tests/unit/UkraineScoreBadge.test.tsx` under `FR-43 UAT: structured bill cell + row-level expand` describe-block — structured fields render, long-detail rows become toggle buttons with `aria-expanded` + `.viw-score-row-bill-detail` appearing on expand, short rows render without a toggle wrapper. Existing integration + e2e assertions updated to address the restructured cell (slug/desc/action selectors instead of joint `.viw-score-row-bill` textContent match).
- **Traces to**: FR-43 AC-43.14.
- **Status**: [x] Done (2026-04-19). 895 tests green across unit/integration/e2e. Visual verification in preview: HR 815 rows show slug + description + "CLOTURE — VOTED AYE" / "WAIVE BUDGET — VOTED AYE" / "MOTION TO TABLE — VOTED AYE" / "FINAL PASSAGE — VOTED AYE" captions; valence tinting intact; caret inline next to numeric columns; clicking caret reveals the full Record-Vote-Number clerk text inline.

### T-101: Test Coverage Reporting & Thresholds (FR-45)
- **Description**: Formalize per-tier + combined coverage collection with honest file exclusions and merge-blocking thresholds. Prior state: `test:coverage` existed but had no config, no exclusions, and the `coverage/` directory on disk was stale from an unknown hand-run. The release-worthiness audit (2026-04-19) called out that the "99.8% overall lines" reading was misleading — `scripts/`, entry points, dev harness, and type-only files were all bloating the denominator.
- **Dependencies**: FR-44 (test ladder already in place; this adds the measurement surface on top).
- **Files**: `vitest.config.ts` (new `test.coverage` block with provider v8, include/exclude lists per AC-45.1, thresholds per AC-45.2, 5 reporters), `package.json` (4 new scripts: `test:coverage:unit`, `:integration`, `:e2e`, `:all`), `scripts/coverage-report.mjs` (new; roll-up reads 4 per-tier `coverage-summary.json` and prints a Markdown-compatible delta table), `.gitignore` (`coverage/` added), `tests/unit/coverageThresholds.test.ts` (new meta-test per AC-45.5).
- **Acceptance Criteria**: AC-45.1 through AC-45.7 (new, in `docs/spec.md` under FR-45).
- **Test Requirements**: 5 meta-tests in `coverageThresholds.test.ts` (provider, threshold floors, include lists, exclude lists, reporter list). Integration: running `npm run test:coverage` SHALL exit 0 (thresholds met — current library coverage 96.25%/88.38%/94.19%/96.25%) and produce `coverage/combined/coverage-summary.json`. Running `npm run test:coverage:all` SHALL produce all 4 summaries and the roll-up script SHALL print a 4-row table without error.
- **Traces to**: FR-45 AC-45.1–AC-45.7; incidentally addresses the release-worthiness audit item **S12** ("coverage report scope is narrow").
- **Status**: [x] Done (2026-04-19). Measured post-honest-denominator coverage: **combined 96.25% statements / 88.38% branches / 94.19% functions / 96.25% lines** — comfortably above the 85/80 floor. Unit tier alone: 87.82%; integration alone: 58.89%; e2e alone: 23.75% (both per-tier numbers are cumulative-floor-over-combined, not regressions — they measure "what each tier would cover if it ran in isolation").

### T-102: About-the-System Info Panel (FR-46)
- **Description**: Add a lightweight, zero-network info panel explaining *why* the scoring system works the way it does. UAT observed that voters got a number and a per-action breakdown but no domain reasoning for why a cloture vote is weight 0.45, why sponsorships amplify 1.5×, or what the curated JSON actually contains. Panel opens from a new `(i) About this system` button in the widget footer; renders the formula, valence table (driven directly from `services/valence.ts` constants), weight table, confidence tiers, data sources, and a collapsible sample entry from the real curated JSON. Uses FR-43's click-anywhere-inside-to-close affordance + Escape-key dismiss for consistency with the score-breakdown panel.
- **Dependencies**: FR-15 (valence tokens), FR-16 (scoring), FR-43 (panel affordance pattern).
- **Files**: `src/components/AboutSystemPanel.tsx` (new; ~180 LOC), `src/VoterInfoWidget.tsx` (wires it into `.viw-root-footer`), `src/styles/widget.css` (new `.viw-about*` styles, reuses `--viw-valence-*-bg` tokens for the valence table tinting).
- **Acceptance Criteria**: AC-46.1–AC-46.6 (new, in `docs/spec.md` under FR-46).
- **Test Requirements**: 8 unit tests in `tests/unit/AboutSystemPanel.test.tsx` covering trigger/open behavior, valence table order + constants match, weight table key rows, sample-JSON toggle with real curated content, Escape-to-close, click-whitespace-to-close with nested-button guard. 2 integration tests in `tests/integration/aboutPanel.test.tsx` verifying footer-mount and aria-controls independence from the score-breakdown panel's controller (AC-46.6).
- **Traces to**: FR-46 AC-46.1–AC-46.6.
- **Status**: [x] Done (2026-04-19). 911 tests green (unit + integration + e2e), combined coverage 96.25%. Visual verification in preview: footer shows `ⓘ ABOUT THIS SYSTEM` button; expanded panel renders formula, 5-row valence table with color tints, 8-row weight table with 2 EXCLUDED rows, confidence + data-sources copy, and the real HR 2471 curated entry in a formatted `<pre>` block when the sample toggle is clicked.

### T-103: Wire trace-id + log + analytics through the router (B2 audit blocker)
- **Description**: The release-worthiness audit (2026-04-19) flagged **B2** — only the tiered-cache `serveCached` pipeline emits `X-Trace-Id` on responses and calls `logEvent` / `writeAnalyticsPoint`. Every other code path — KV-backed routes (`/api/members/*`, `/api/name-search`, `/api/state-members/*`, `/api/roll-call-rosters/*`, `/api/bills/*`, `/api/roll-calls/*`), origin-denial 403s, rate-limit 429s, 4xx validation, preflight 204s, preview/embed HTML, and any non-tiered passthrough — ships with no trace header and writes no analytics point. Confirmed by Grep: `proxy/router.ts` never calls `resolveTraceId` or the observability helpers; `proxy/routes/*` except `api-upstream.ts` have no mentions either. The `api-upstream.ts` fallback at line 172 uses `Math.random().toString(16).slice(2, 18).padEnd(16, '0')` — not guaranteed to match the canonical `tr_<16hex>` pattern required by AC-36.1.

  Real-world symptom (UAT, 2026-04-19): operator searching Cloudflare Logpush / Workers Analytics for a trace ID sees traces only for tiered-cache requests; KV-backed routes, errors, and static HTML are invisible. The audit's AC-36.2 compliance is therefore false in production.

- **Dependencies**: FR-36 (trace), FR-38 (analytics), FR-39 (logs), FR-44 (observability threading is spec'd, just not wired).
- **Proposed approach**:
  1. Add a single `traceContext` middleware at the router entry point (`dispatch`/`handleFetch`) that calls `resolveTraceId(request)` once per request and threads the result through the async call chain via a parameter (not a global — Workers have no AsyncLocalStorage guarantee in our compatibility_date).
  2. Every handler signature that returns a `Response` gains a `traceId: string` parameter. The `applyTraceHeaderToResponse()` helper (already exists) writes `X-Trace-Id` on the final response before `dispatch` returns it.
  3. `asErrorResponse` / 403 / 429 / 404 / 405 / preflight response helpers all accept `traceId` and set the header; error envelopes already have a `traceId` field (FR-37) — the helpers just need it plumbed in.
  4. `writeAnalyticsPoint(env.ANALYTICS, ctx, { … traceId, status, routeClass, … })` fires once per request in a `ctx.waitUntil`, from `dispatch` right before return.
  5. Remove the `Math.random()` fallback in `api-upstream.ts:172` — it's unreachable once (1) lands, and it violates the canonical pattern.
- **Files** (estimated): `proxy/router.ts` (add middleware + thread traceId through every handler call), all files in `proxy/routes/*` (accept traceId, pass to error helpers), `proxy/security/{origin-allowlist,rate-limit}.ts` (already-exists-as-shaped helpers need traceId threaded), `proxy/observability/error-envelope.ts` (already supports it — just needs every caller to pass it). Tests: `proxy` integration tests should assert `X-Trace-Id` header presence on every non-200 fixture response.
- **Acceptance Criteria**: Re-compliance with AC-36.2, AC-38.2, AC-39.2 across all route classes (not just tiered-cache). Every `/api/*` response — success or error — carries a well-formed `tr_<16hex>` `X-Trace-Id`. Every `/api/*` request writes exactly one analytics point. Every error path calls `logEvent`.
- **Test Requirements**: New integration suite `tests/integration/traceAllRoutes.test.ts` exercising each route class (KV-profile, KV-roster, name-search, state-members, bills, roll-calls, census, senate-xml, tiered-cache hit, tiered-cache miss, origin-denied, rate-limited, preflight, preview HTML) and asserting every response carries `X-Trace-Id`. Assert Analytics Engine fake received one point per call. Assert Logpush fake received one event per error.
- **Traces to**: audit B2, FR-36 AC-36.2, FR-38 AC-38.2, FR-39 AC-39.2, FR-44 AC-44.19.
- **Status**: [x] Done (2026-04-19). Single middleware in `proxy/router.ts#handleFetch`: resolves trace id once per request, stamps `X-Trace-Id` on every outbound response (after `applySecurityHeaders` + `stripFingerprintingHeaders`), writes one `writeAnalyticsPoint` per request with `{routeClass, upstreamName, errorCode, env, statusCode, latency, traceId}`, emits `logEvent` at `warn` for 4xx and `error` for 5xx (success paths silent per AC-39.3). Also: replaced the `Math.random()` trace fallback in `api-upstream.ts:172` with `resolveTraceId(request)` so the canonical `tr_<16hex>` pattern is guaranteed; added `Access-Control-Expose-Headers: X-Trace-Id, X-Cache, X-Cache-Tier, X-Proxy-Cache` to `corsHeaders` (audit B3 bonus). Tests: 10 integration tests in `tests/integration/traceAllRoutes.test.ts` exercising KV 404, origin-denied 403, method-not-allowed 405, unknown-path 404, upstream 2xx, upstream 500, client-supplied trace echo, malformed-trace replacement, Access-Control-Expose-Headers, one-analytics-point-per-request. All green. B2 closed.

### T-104: Curator pre-curation pass — add confidence-flagged bill additions (deferred behind T-103)
- **Description**: Pre-curated list of confident additions to `scripts/build-curated-bills.ts` seed beyond what landed in the 2026-04-19 UAT expansion. User explicitly deferred these until T-103 (observability debt) is cleared — bundled here so they're not forgotten.
- **Additions to verify/add**:
  - **117th Congress:**
    - HR 7900 — FY23 NDAA (neutral, Ukraine amendments on floor — same treatment as HR 2670) — *already in the updated seed from 2026-04-19; verify at curator run*
    - HR 7500 — "Russia and Belarus SDN List Mirroring Act" (pro-ukraine)
    - HR 4350 — FY22 NDAA (neutral, Ukraine amendments) — *already added 2026-04-19*
    - HRES 1032 — "Condemning Russia's invasion" (pro-ukraine)
    - SRES 500 — "Expressing solidarity with Ukraine" (pro-ukraine) — *already added 2026-04-19 via `sres 500`*
    - HR 6968 — "Suspending Normal Trade Relations with Russia and Belarus Act" (pro-ukraine, became PL 117-110) — *already added 2026-04-19*
    - HR 6891 — "Ending Importation of Russian Oil Act" (pro-ukraine, became PL 117-109) — *note: 2026-04-19 seed added HR 6968 with that label; need to verify whether the Russian-oil ban's correct number is 6968 or 6891 (both show up in different sources)*
  - **118th Congress:**
    - S 316 — Ukraine aid reporting (pro-ukraine)
    - HR 540 — Ukraine aid transparency (pro-ukraine)
    - HRES 888 — Supporting Ukraine on anniversary (pro-ukraine)
    - SRES 101 — Supporting Ukraine on anniversary (pro-ukraine) — *already added 2026-04-19*
    - HR 1117 — "No Stolen Aid Act" / Ukraine accountability (pro-ukraine)
  - **Explicit skips (recorded so they're not re-proposed):**
    - HR 3935 — FAA Reauthorization (Russian-aviation sanctions are tangential)
    - HR 6126 — standalone Israel supplemental, no Ukraine
    - 119th HRES 211 — unconfirmed number
    - 119th S 845 — likely redundant with S 1241
- **Dependencies**: T-103 (observability must be fixed first so the curator re-run can be observed end-to-end via traces).
- **Files**: `scripts/build-curated-bills.ts` (seed additions), `scripts/vote-overrides.yaml` (any needed per-vote corrections found during verification).
- **Test Requirements**: After curator runs, `src/data/ukraineBills.json` SHALL have entries for every new seed with non-null `title`; any entry where the curator returned 404 (bad number) SHALL be removed from the seed or corrected. `tests/unit/AboutSystemPanel.test.tsx` AC-46.3 SHALL still render the three direction tabs with updated counts.
- **Traces to**: spec FR-46's KEEP-IN-SYNC rule.
- **Status**: [x] Done (2026-04-19). Applied via v0.1.0 review ledger (`docs/curated-bills-v0.1.0.md`): 18 wrong-number entries removed, 2 renames (HR 855 direction pro-ukraine, HR 6891 label to actual Congress.gov title), 27 new candidates added via web-verified search. Post-curator re-run: **62 bills · 55 pro / 2 anti / 5 neutral · 59 roll-call votes**. Title-grep audit flagged 5 entries (FY22 CR, April 2024 supplemental, NYET Act, PEACE Act, UNGA-dissent SRES) whose titles lack literal Ukraine/Russia terms but are confirmed Ukraine-substantive on review. All 923 tests green, 0 regressions. Further per-vote NDAA-amendment curation (HR 2670, HR 4350, HR 7900, HR 8070) deferred to v0.2.0.

### T-105: Isolated per-branch preview deploys (FR-47)
- **Description**: Full-isolation preview envs per FR-47 (supersedes the initial shared-env approach). Pushing to `preview/<slug>` triggers CI that creates a fresh KV namespace (`voter-info-widget-preview-<slug>`), a fresh R2 bucket (`voter-info-widget-archive-preview-<slug>`), a fresh analytics dataset, and deploys a Worker (`voter-info-widget-proxy-preview-<slug>`) with those resources bound. KV is seeded from the dev namespace's curator output so previews have data. Branch delete triggers Worker + KV + R2 teardown. Slug derivation is a pure-function module with its own test suite.
- **Dependencies**: FR-47 (new spec), reuses existing Cloudflare secrets + `wrangler-action@v3`.
- **Files**:
  - `scripts/preview-slug.mjs` — new pure-function module: `deriveSlug(branchName)` + `resourceNames(slug)`; CLI entry so the workflow calls it via `node scripts/preview-slug.mjs "$BRANCH"`.
  - `tests/unit/previewSlug.test.ts` — 9 tests covering strip/lowercase/collapse, reserved-slug rejection, reserved-prefix rejection, length cap, resource-name derivation, CF 63-char limit fit.
  - `wrangler.toml` — replaced the old `env.preview` with an `env.preview-template` block. Defaults only (vars, assets, rate-limit). KV/R2/analytics/name are provided via `wrangler deploy --kv-namespace --r2-bucket --var --name` CLI flags per-deploy.
  - `.github/workflows/preview.yml` — new 3-job workflow: `resolve` (slug+resource-names from branch), `deploy` (create/reuse KV + R2 → seed KV from dev → deploy Worker → sticky PR comment), `teardown` (delete Worker + KV + R2, continue-on-error per AC-47.10).
- **Acceptance Criteria**: AC-47.1 through AC-47.12 (spec).
- **Test Requirements**: 9 unit tests in `previewSlug.test.ts` (all green). CI-layer lifecycle is validated on first use by pushing `preview/smoke-test`. No integration test for the actual CF resource create — that's a manual smoke step documented in `docs/deployment.md`.
- **Prerequisites for first use**:
  1. Verify `CLOUDFLARE_API_TOKEN` has the scopes: Worker Scripts (edit), KV (edit), R2 (edit), Analytics (edit).
  2. (Optional) Wildcard DNS `*.preview.vote.cogs.it.com` → Worker route. The first iteration emits the raw `*.workers.dev` URL so previews work without DNS.
  3. (Optional) Cloudflare Access application covering the wildcard hostname, matching the dev/uat Access policy.
- **Traces to**: FR-47, FR-26, FR-44.
- **Status**: [x] Done (2026-04-19). Spec FR-47 + pure slug module + workflow + tests all landed. 935 tests passing, typecheck clean, coverage 96.19/88.8/93.25/96.19. First-push validation deferred until the human pushes a `preview/*` branch (auto-mode safety: CF resource creation is a shared-system write; requires explicit user trigger via a real push or workflow_dispatch).

### T-106: Documentation secret-leakage audit (NFR-7)
- **Description**: On 2026-04-19, a grep-based audit ran over `docs/`, `.github/`, tracked workflows, and root `package.json` / `wrangler.toml` to verify zero actual secrets. Findings categorized into (a) NON-SECRET routing identifiers (KV namespace IDs, R2 bucket names — safe to commit), (b) git-public metadata (owner email, already in commit history), (c) gitignored files (`.env`, scratch JSON), (d) secret-handling prose that discusses flow without leaking values.
- **Findings**: 0 actual leaks. Full table documented in NFR-7.2–7.5 + the commit summary for this task.
- **Follow-up**: NFR-7.4 specifies a CI grep gate (`scripts/secret-scan.mjs`) that rejects commits introducing literal secret patterns into tracked files. Deferred from this task — tracked as T-107 to bundle with the stress-test / remote-mode work.
- **Traces to**: NFR-7.1–7.5.
- **Status**: [x] Audit complete 2026-04-19. CI grep gate deferred to T-107.

## Phase 14: V4 — Researcher Backend + Editorial Surfaces (v2.7.0 — ADR-017 / ADR-018)

**Target**: Sunday 2026-05-09 ~midnight US off-hours. Tier model:
- **Tier A (must-ship)**: T-107 .. T-122 — D1, auth, publish pipeline, admin SPA, score weight, embed tabs + comments.
- **Tier B (stretch)**: T-123 .. T-127 — Bayesian shrink, Insufficient-record badge, About-panel feed, stats endpoint.
- **Tier C (explicit slip)**: T-128 .. T-130 — frozen-JSON CI gate, Discord SSO migration, video-quote rendering polish.

### T-107: D1 schema migration `0001_init.sql` (FR-49)
- **Description**: Author the SQLite-flavored DDL per design.md §4.16. Tables: `researchers`, `bills`, `votes`, `comments`, `social_posts`, `quotes`, `score_adjustments`, `audit_log`. ULID PKs, indices, FK cascades on votes/comments/posts/quotes; audit_log NOT cascading.
- **Dependencies**: None.
- **Files**: `migrations/d1/0001_init.sql` (new).
- **Acceptance Criteria**: AC-49.1, AC-49.2, AC-49.5.
- **Test Requirements**: `tests/unit/d1Schema.test.ts` — DDL parses against a sql.js fixture; FKs CASCADE on bill delete (votes + comments removed); audit_log row survives row-delete; ULID format `^[0-9A-HJKMNP-TV-Z]{26}$` for inserted PKs.
- **Traces to**: FR-49, ADR-017, design.md §4.16.
- **Status**: [ ] Pending.

### T-108: ULID helper (`src/utils/ulid.ts`) (FR-49 AC-49.5)
- **Description**: Tiny pure helper to emit ULIDs. No external dep — Crockford-base32 + `crypto.getRandomValues`. Exposed as `newUlid()` and `isUlid(s)`. Lives under `src/utils/` so both widget and worker (via cross-include) can consume it.
- **Dependencies**: None.
- **Files**: `src/utils/ulid.ts` (new), `tests/unit/ulid.test.ts`.
- **Acceptance Criteria**: AC-49.5.
- **Test Requirements**: 10 generated ULIDs match the regex; lexicographic order matches generation order; collision-resistance smoke (10k unique).
- **Traces to**: FR-49.
- **Status**: [ ] Pending.

### T-109: `wrangler.toml` hardening (`workers_dev=false`, `preview_urls=false`, D1 binding, CF Access env vars) (FR-49 AC-49.1, FR-50 AC-50.1, AC-50.2)
- **Description**: Set `workers_dev = false` and `preview_urls = false` at the top level so the Worker is unreachable outside the gated zone hostname. Add `[[d1_databases]]` block per env (dev/uat/stg/prod) for `D1_VOTER_INFO` (database name `viw_researcher_<env>`, `database_id` filled per env after `wrangler d1 create`, `migrations_dir = "migrations/d1"`). Add `CF_ACCESS_TEAM = ""` and `CF_ACCESS_AUD = ""` placeholders per env. Document the per-env database IDs and CF Access app IDs in `docs/deployment.md`.
- **Dependencies**: T-107.
- **Files**: `wrangler.toml`, `docs/deployment.md`.
- **Acceptance Criteria**: AC-49.1, AC-49.6, AC-50.1, AC-50.2.
- **Test Requirements**: Manual: `wrangler d1 list --env dev` shows the database; `wrangler deploy --env dev` succeeds with `workers_dev = false`. Smoke: a hand-crafted `curl` to the workers.dev URL returns 404 (or no response).
- **Traces to**: FR-49, FR-50.
- **Status**: [x] Done — workers_dev/preview_urls disabled; D1 + CF Access env vars wired per env. Database IDs + CF Access AUD tags need to be filled in by ops once provisioned.

### T-110: Worker env types — `D1_VOTER_INFO` + `CF_ACCESS_TEAM` + `CF_ACCESS_AUD` (FR-49, FR-50)
- **Description**: Extend `proxy/env.ts#ProxyEnv` with `D1_VOTER_INFO?: D1Like`, `CF_ACCESS_TEAM?: string`, `CF_ACCESS_AUD?: string`, and `D1Like` / `D1PreparedStatementLike` / `D1ResultLike` minimal interface types so tests can fake D1 without a heavy dep.
- **Dependencies**: T-109.
- **Files**: `proxy/env.ts`.
- **Acceptance Criteria**: AC-49.1, AC-50.2.
- **Test Requirements**: Existing `kvPrefixes.test.ts` + `proxyEnv` type-check passes.
- **Traces to**: FR-49, FR-50.
- **Status**: [x] Done — D1Like/D1PreparedStatementLike/D1ResultLike types added; CF_ACCESS_TEAM/AUD bindings wired.

### T-111a: CF Access JWT verifier (`proxy/security/cf-access-jwt.ts`) (FR-50 AC-50.2)
- **Description**: Pure-WebCrypto RS256 JWT verifier for Cloudflare Access tokens. Verifies signature against the team JWKS at `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (cached in module-scope memo + KV `cache:v1:cf-access-jwks`, 1 h TTL). Checks `aud` matches `CF_ACCESS_AUD`, `iss` matches `https://<team>.cloudflareaccess.com`, `exp` future, `iat`/`nbf` not future (60 s clock skew).
- **Dependencies**: T-110.
- **Files**: `proxy/security/cf-access-jwt.ts` (new), `tests/unit/cfAccessJwt.test.ts`.
- **Acceptance Criteria**: AC-50.2.
- **Test Requirements**: 11 unit tests covering: valid signed token accepted; malformed token rejected; forged signature rejected; bad `aud` rejected; bad `iss` rejected; expired rejected; future-iat rejected; unknown `kid` rejected; non-RS256 rejected; jwks_unavailable on JWKS endpoint failure; `aud` array containing the configured value accepted.
- **Traces to**: FR-50.
- **Status**: [x] Done — 11/11 green. Real RS256 sign + verify, real forgery rejection.

### T-111b: Admin actor extraction (`proxy/security/admin-actor.ts`) (FR-50 AC-50.2)
- **Description**: Wraps the JWT verifier. Exports `extractAdminActor(request, env): Promise<{ email } | Response>`. Reads `Cf-Access-Jwt-Assertion`, calls `verifyCfAccessJwt`, extracts `email` from the **verified claims** (NOT from the loose `Cf-Access-Authenticated-User-Email` header). Returns FR-37-shape Response envelopes on every failure mode (`admin_misconfigured` / `admin_jwt_required` / `admin_jwt_invalid` / `admin_jwks_unavailable` / `admin_actor_missing`).
- **Dependencies**: T-111a.
- **Files**: `proxy/security/admin-actor.ts` (new), `tests/unit/adminActor.test.ts`.
- **Acceptance Criteria**: AC-50.1, AC-50.2.
- **Test Requirements**: 7 unit tests: returns email from verified JWT; IGNORES the plain email header (defense against spoofing); 401 on missing JWT; 401 on forged JWT; 500 on missing CF_ACCESS_TEAM/AUD; 500 on missing email claim; extraHeaders forwarded into error responses.
- **Traces to**: FR-50.
- **Status**: [x] Done — 7/7 green.

### T-112: D1 access helpers (`proxy/d1/admin-store.ts`) (FR-50, FR-51)
- **Description**: Thin typed wrappers over `D1_VOTER_INFO`. Per resource: `list`, `get`, `create`, `update`, `delete` with built-in `audit_log` insertion atomic with the mutation via `D1.batch()`. ULID assignment, timestamp population, FK validation. Each `create` / `update` / `delete` accepts the validated admin email + the inbound request's trace ID and writes the `audit_log` row carrying that trace ID (FR-50 AC-50.7).
- **Dependencies**: T-107, T-108.
- **Files**: `proxy/d1/admin-store.ts` (new), `tests/unit/adminStore.test.ts`.
- **Acceptance Criteria**: AC-50.3, AC-50.7, AC-54.1, AC-54.5.
- **Test Requirements**: in-memory D1 fixture (sql.js or hand-rolled); CRUD round-trips; audit row inserted on each write with `trace_id`; forced audit-insert failure rolls back the row write (assert no row visible after); ULID-shaped IDs.
- **Traces to**: FR-50, FR-51, FR-54.
- **Status**: [ ] Pending.

### T-113: Worker route `proxy/routes/api-admin.ts` (FR-50, FR-58)
- **Description**: Mount admin CRUD endpoints per api-contracts.md §7.3 + audit endpoints §7.4. Each route: parse path → `extractAdminActor` → validate body → `admin-store` call → emit one `logEvent` per write at `level: info` carrying `trace_id`, `actor_email`, `action`, `target_table`, `row_id`, outcome (FR-50 AC-50.6) → return `{ row, audit }` or FR-37 error envelope. `OPTIONS` returns 204.
- **Dependencies**: T-111b, T-112.
- **Files**: `proxy/routes/api-admin.ts` (new), `tests/integration/adminRoutes.test.ts`.
- **Acceptance Criteria**: AC-50.1, AC-50.3, AC-50.4, AC-50.6, AC-58.1.
- **Test Requirements**: full CRUD round-trip per resource (~25 tests); whoami; auth-failure shapes (401 admin_jwt_required, 401 admin_jwt_invalid); validation failures (invalid weight, invalid platform, unknown bill_id); structured log emitted per write with the trace ID.
- **Traces to**: FR-50, FR-58, AC-54.1.
- **Status**: [ ] Pending.

### T-114: Worker read routes for embed (FR-53, FR-58)
- **Description**: New routes `GET /api/comments/{billId}`, `GET /api/social-posts/{bioguideId}`, `GET /api/quotes/{bioguideId}`, `GET /api/audit/public` reading from KV records under `comment:v1:*`, `social-post:v1:*`, `quote:v1:*`, `audit-feed:v1:public`. 404 returns FR-37 envelope; embed-side hooks treat 404 as empty per AC-53.5.
- **Dependencies**: T-110.
- **Files**: `proxy/routes/api-comments.ts`, `proxy/routes/api-social-posts.ts`, `proxy/routes/api-quotes.ts`, `proxy/routes/api-audit-public.ts` (new), `tests/unit/embedReadRoutes.test.ts`.
- **Acceptance Criteria**: AC-51.4..AC-51.6, AC-53.5, AC-58.2..AC-58.5.
- **Test Requirements**: each route returns the canonical shape; 404 envelope shape; cache-control header; redaction on `audit/public` (no `before`/`after`/`reason`).
- **Traces to**: FR-51, FR-53, FR-58.
- **Status**: [ ] Pending.

### T-115: Worker read route `/api/stats/v1/summary` (FR-56)
- **Description**: New route reading `stats:v1:summary` from KV, returning verbatim or 503 with `Retry-After: 60` per AC-56.4. Rate-limited at 30/60s.
- **Dependencies**: T-110.
- **Files**: `proxy/routes/api-stats.ts` (new), `tests/unit/apiStats.test.ts`.
- **Acceptance Criteria**: AC-56.1..AC-56.4.
- **Test Requirements**: shape match against fixture; 503 path on missing record; rate-limit budget separate.
- **Traces to**: FR-56.
- **Status**: [ ] Pending.

### T-116: Router wiring for V4 routes (FR-50, FR-53, FR-56, FR-58)
- **Description**: Extend `proxy/router.ts#dispatch` with new path matches: `/api/admin/*`, `/api/comments/*`, `/api/social-posts/*`, `/api/quotes/*`, `/api/audit/public`, `/api/stats/*`, `/admin` (asset path). Update `classifyRoute` so analytics labels are correct (`admin`, `comments`, `social-posts`, `quotes`, `audit-public`, `stats`, `admin-spa`).
- **Dependencies**: T-113, T-114, T-115.
- **Files**: `proxy/router.ts`, `tests/unit/router.test.ts`.
- **Acceptance Criteria**: AC-50.1, AC-50.4, AC-50.6.
- **Test Requirements**: each new path is dispatched to the correct handler; classifyRoute returns the new labels.
- **Traces to**: FR-50, FR-53, FR-56, FR-58.
- **Status**: [ ] Pending.

### T-117: `scripts/seed-d1-from-json.ts` (FR-49 AC-49.3)
- **Description**: Read `src/data/ukraineBills.json`, INSERT bills + nested votes into D1. Idempotent (UPSERT by `bill_id` + `(chamber,congress,session,roll_call)`). Sets `audit_log.actor_email = 'seed'`, `reason = 'bootstrap from ukraineBills.json'`.
- **Dependencies**: T-107, T-108.
- **Files**: `scripts/seed-d1-from-json.ts`, `tests/unit/seedFromJson.test.ts`.
- **Acceptance Criteria**: AC-49.3.
- **Test Requirements**: against in-memory D1 fixture; first run inserts N bills + M votes; second run inserts 0; audit log has 1 row per inserted entity with actor='seed'.
- **Traces to**: FR-49.
- **Status**: [ ] Pending.

### T-118: `scripts/publish-d1-to-kv.ts` (FR-51, FR-55, FR-56, FR-58)
- **Description**: The full publish pipeline per design.md §4.17. Reads D1, projects per-prefix records, diff-skips no-ops, writes `bill:v1:*` (FR-32 shape), `comment:v1:*`, `social-post:v1:*`, `quote:v1:*`, `stats:v1:summary` (FR-56), `audit-feed:v1:full`, `audit-feed:v1:public` (FR-58). Computes party priors (FR-55 AC-55.6) and writes `partyPrior` into `member:v1:*`. Supports `--dry-run`.
- **Dependencies**: T-107, T-112.
- **Files**: `scripts/publish-d1-to-kv.ts`, `tests/integration/publishD1ToKv.test.ts`.
- **Acceptance Criteria**: AC-51.1..AC-51.9, AC-54.3, AC-55.6, AC-56.5, AC-58.3.
- **Test Requirements**: seed with 3 bills + 2 reps + 2 comments + 1 post + 1 quote → publish → assert KV records match expected JSON; second consecutive publish writes zero keys (determinism); dry-run prints diff but writes nothing; party priors computed correctly with N=2 full-confidence reps.
- **Traces to**: FR-51, FR-55, FR-56, FR-58.
- **Status**: [ ] Pending.

### T-119: `.github/workflows/publish-d1.yml` cron (FR-51 AC-51.8)
- **Description**: Schedule `*/15 * * * *` against dev + uat. Manual `workflow_dispatch` against stg + prod. Uses `wrangler d1 execute` for read; writes through the existing `KV_VOTER_INFO` binding via `wrangler kv:key put`. Logs the diff summary; non-zero on any error.
- **Dependencies**: T-118.
- **Files**: `.github/workflows/publish-d1.yml` (new), `tests/ops/cron.publish.test.ts`.
- **Acceptance Criteria**: AC-51.8.
- **Test Requirements**: workflow file syntax (yaml-lint via existing scaffolding); no inline secrets (NFR-7).
- **Traces to**: FR-51.
- **Status**: [ ] Pending.

### T-120: Admin SPA — Vite config + entry (FR-52)
- **Description**: New Vite config `vite.admin.config.ts` with separate entry `src/admin/main.tsx` and HTML shell `src/admin/index.html`. Output to `dist/admin/`. `package.json` scripts `dev:admin`, `build:admin`. Worker `ASSETS` binding serves it at `/admin`.
- **Dependencies**: None.
- **Files**: `vite.admin.config.ts`, `src/admin/main.tsx`, `src/admin/index.html`, `package.json`.
- **Acceptance Criteria**: AC-52.1, AC-52.2.
- **Test Requirements**: build succeeds; dist/admin contains index.html + IIFE bundle; smoke test loads at `/admin` against local Worker.
- **Traces to**: FR-52.
- **Status**: [ ] Pending.

### T-121: Admin SPA — six tabs + drawer editor (FR-52, FR-58)
- **Description**: Tabs: Bills, Votes, Comments, Social Posts, Quotes, Recent Activity. List-detail layout per design.md §4.20. Optimistic updates with revert + toast on non-2xx (AC-52.4). Whoami badge (AC-52.6).
- **Dependencies**: T-113, T-120.
- **Files**: `src/admin/components/*` (Tabs, BillEditor, VoteEditor, CommentEditor, SocialPostEditor, QuoteEditor, RecentActivity), `src/admin/hooks/useFetcher.ts`, `tests/unit/admin-spa.test.tsx`.
- **Acceptance Criteria**: AC-52.3..AC-52.8, AC-54.4.
- **Test Requirements**: each tab renders mocked data; editor saves PATCH; non-2xx surfaces toast + reverts optimistic update; weight slider clamps to [0,5] step 0.05.
- **Traces to**: FR-52, FR-54, FR-58.
- **Status**: [ ] Pending.

### T-122: Embed VoteList CommentExpand (FR-53.1)
- **Description**: New `src/components/CommentExpand.tsx` (presentational) + `src/hooks/useRepComments.ts` (fetcher). VoteList renders the expand affordance only on rows with comments per AC-53.1. Expanded state shows comment markdown + score-adjustment chip per AC-53.3.
- **Dependencies**: T-114.
- **Files**: `src/components/CommentExpand.tsx`, `src/components/VoteList.tsx` (modify), `src/hooks/useRepComments.ts`, `tests/integration/embed.commentExpand.test.ts`.
- **Acceptance Criteria**: AC-53.1, AC-53.3, AC-53.5.
- **Test Requirements**: row with comment renders chevron; row without comment does not; expanding shows markdown + chip; missing endpoint (404) renders no chevron and no error banner.
- **Traces to**: FR-53.
- **Status**: [ ] Pending.

### T-123: Embed Statements + Quotes tabs (FR-53.2, FR-53.3)
- **Description**: New `src/components/SocialPostsList.tsx` + `QuotesList.tsx` (presentational). `RepDetail.tsx` grows a tab strip per design.md §4.21. Default tab = Record. Tab state persists across rep-detail open/close; not in URL. Mobile horizontal-scroll tab strip.
- **Dependencies**: T-114.
- **Files**: `src/components/RepDetail.tsx` (modify), `src/components/SocialPostsList.tsx`, `src/components/QuotesList.tsx`, `src/hooks/useRepStatements.ts`, `src/hooks/useRepQuotes.ts`, `tests/integration/embed.tabs.test.ts`.
- **Acceptance Criteria**: AC-53.2, AC-53.3, AC-53.6, AC-53.7.
- **Test Requirements**: tabs render in order Record / Statements / Quotes; default = Record; clicking tab switches content; missing endpoints render empty states; mobile breakpoint applies stacked-card layout.
- **Traces to**: FR-53.
- **Status**: [ ] Pending.

### T-124: Score — FR-55 Bayesian shrink + Insufficient-record badge (Tier B)
- **Description**: Extend `src/services/ukraineScore.ts`: add `NEW_REP_THRESHOLD = 2`, extend `ConfidenceTier` with `'insufficient'`, add `priors?: { partyPrior }` parameter, return `rawScore` field. Update `UkraineScoreBadge.tsx` to render "Insufficient record" + neutral gray for the new tier.
- **Dependencies**: T-118 (publish writes `partyPrior` into `member:v1:*`).
- **Files**: `src/services/ukraineScore.ts`, `src/components/UkraineScoreBadge.tsx`, `tests/unit/score.bayesianShrink.test.ts`.
- **Acceptance Criteria**: AC-55.1..AC-55.7.
- **Test Requirements**: rep with 0 votes → null score; 1 vote → null + 'insufficient'; GOP rep with 1 pro vote + partyPrior=-0.4 → final score ≈ -0.16 (after shrink); GOP rep with 20 pro votes → +1.0 (no shrink at full); partyPrior=null → no shrink.
- **Traces to**: FR-55, ADR-018.
- **Status**: [ ] Pending.

### T-125: Score — FR-54 per-vote weight regression test (DEFERRED)
- **Description**: Snapshot test asserting score parity between pre-V4 baseline and post-V4 D1-driven path. **Deferred** — not in V4 cut, can be added later when the parity question is asked.
- **Acceptance Criteria**: AC-54.3 (the AC remains in the spec; this task does not satisfy it in V4).
- **Traces to**: FR-54.
- **Status**: [ ] Deferred — add when needed.

### T-126: About panel — Recent researcher updates feed (Tier B, FR-53.4)
- **Description**: Extend `src/components/AboutSystemPanel.tsx` with a section that fetches `/api/audit/public?limit=20` and renders the redacted list (actor local-part, action verb, target, relative time). 401/403 → render nothing (no error banner).
- **Dependencies**: T-114.
- **Files**: `src/components/AboutSystemPanel.tsx`, `src/hooks/useResearcherAuditPublic.ts`, `tests/integration/aboutPanelFeed.test.ts`.
- **Acceptance Criteria**: AC-53.4.
- **Test Requirements**: feed renders 20 rows; 401 response renders nothing; redaction integrity (no email domains visible).
- **Traces to**: FR-53, FR-58.
- **Status**: [ ] Pending.

### T-127: Stats endpoint smoke + cron-emission (Tier B, FR-56)
- **Description**: The stats record is written by T-118 (publish pipeline). This task: smoke-test the read route end-to-end (fixture publish → fixture KV → fetch → assert shape) and document the public consumer contract.
- **Dependencies**: T-115, T-118.
- **Files**: `tests/integration/statsEndToEnd.test.ts`.
- **Acceptance Criteria**: AC-56.1..AC-56.5.
- **Test Requirements**: full pipeline integration test; rate-limit isolation from other public routes.
- **Traces to**: FR-56.
- **Status**: [ ] Pending.

### T-128: `ukraineBills.json` frozen-file CI gate (Tier C, FR-49 AC-49.4)
- **Description**: `scripts/json-frozen-check.mjs` — fail the PR check if `src/data/ukraineBills.json` content hash differs from a committed-known hash UNLESS the PR title contains `[seed-update]`. Documented escape hatch for the rare case the seed needs to change post-V4.
- **Dependencies**: T-117 lands and the seed runs in dev/uat/stg/prod.
- **Files**: `scripts/json-frozen-check.mjs`, `.github/workflows/pr.yml` (extend).
- **Acceptance Criteria**: AC-49.4.
- **Test Requirements**: a test PR that mutates the file fails CI; a `[seed-update]`-titled PR passes.
- **Traces to**: FR-49.
- **Status**: [ ] Pending — Tier C, may slip past Sunday.

### T-129: Discord SSO migration plan (Tier C, FR-57)
- **Description**: NOT IMPLEMENTED in V4. Captured as a placeholder task so future cycles have a starting point. The migration is documented in FR-57 and ADR-017's Migration Outline.
- **Dependencies**: V4 lands and runs stably for ≥1 week.
- **Files**: TBD when scheduled.
- **Acceptance Criteria**: TBD (FR-57 has none in v2.7.0).
- **Test Requirements**: TBD.
- **Traces to**: FR-57.
- **Status**: [ ] Deferred.

### T-131: V4 D1→KV→embed round-trip integration test (RC gate, FR-44 AC-44.21)
- **Description**: New `tests/integration/v4PublishRoundTrip.test.ts` composing admin store + publish projector + embed read routes against in-memory D1 + KV fakes. Locks the contract that admin writes flow correctly through publish projection into the shape the embed read routes return. Required for release-candidate confidence.
- **Dependencies**: T-112, T-114, T-118.
- **Files**: `tests/integration/v4PublishRoundTrip.test.ts` (new).
- **Acceptance Criteria**: AC-44.21.
- **Test Requirements**: Itself — 4 tests covering bill round-trip, comment round-trip, multi-cosponsorship projection, and delete + audit-feed redaction.
- **Traces to**: FR-44, FR-50, FR-51, FR-58.
- **Status**: [ ] In progress.

### T-132: Router `/admin` SPA bootstrap unit test (RC gate, FR-44 AC-44.22)
- **Description**: New `tests/unit/router.adminBootstrap.test.ts` exercising the FR-52 AC-52.2 admin-SPA-serving path through `proxy/router.ts#dispatch`. Locks the contract that `/admin` and `/admin/` rewrite to `/admin/index.html` via the ASSETS binding, with fail-closed 404 paths for misconfigured envs.
- **Dependencies**: T-116.
- **Files**: `tests/unit/router.adminBootstrap.test.ts` (new).
- **Acceptance Criteria**: AC-44.22.
- **Test Requirements**: Itself — 4 tests covering /admin, /admin/, missing ASSETS, ASSETS-throws.
- **Traces to**: FR-44, FR-52.
- **Status**: [ ] In progress.

### T-130: Quote-modal video embedding polish (Tier C)
- **Description**: V4 ships text rendering of quotes (`mediaKind: 'text'`) inline in the QuotesList. Video / audio / image rendering with proper iframe sizing and lazy-load is deferred. This task tracks that follow-on work.
- **Dependencies**: T-123.
- **Files**: `src/components/QuotesList.tsx` (extend), `src/components/QuoteMedia.tsx` (new).
- **Acceptance Criteria**: TBD (extend FR-53 with sub-ACs when scheduled).
- **Test Requirements**: TBD.
- **Traces to**: FR-53.
- **Status**: [ ] Deferred — Tier C, may slip past Sunday.

### T-133: Edge-tier cache-key injectivity hotfix (2026-05-25 prod regression)
- **Description**: Production bug: on `trackukraine.com`, a second address lookup returned the first lookup's reps. Root cause traced to the edge-tier `keyToUrl` adapter in `proxy/routes/api-upstream.ts` building its cache URL from the request pathname + `#${kind}` only, dropping `CacheKey.params`. Census-geocoder is the lone route whose identity lives in the query string, so every address lookup at a warm POP collided on one edge entry. Fix: encode `cacheKeyToDottedString(k)` as a `__ck` query parameter on the synthetic edge cache URL so structurally non-equal CacheKeys produce distinct edge addresses.
- **Dependencies**: none.
- **Files**: `proxy/routes/api-upstream.ts` (edit edge-tier `keyToUrl` lambda), `tests/unit/routes/query-and-cache.test.ts` (add dual-of-nonce-fuzz regression test).
- **Acceptance Criteria**: AC-40.11.
- **Test Requirements**: One regression test asserting two `/api/census/geocoder/geographies/onelineaddress` requests differing only in `address=` produce two upstream calls (not one). Test fails on pre-fix code; passes on post-fix code.
- **Traces to**: FR-40 AC-40.11, ADR-019.
- **Status**: [x] Done — 2026-05-25. Spec + ADR + failing-then-passing test + fix landed in one pass per AIDD. Full suite green (155 files, 2188 tests). `npm run typecheck` clean.


### T-134: v4.1.0 — `lw` CLI foundation
- **Description**: Build the legislation-watch CLI scaffolding so every future ingest job has one consistent surface. `scripts/cli.ts` (commander dispatcher), `scripts/lib/{runtime,d1-client,congress-client,audit-log,trace,logger}.ts` shared core, `scripts/{bills,kv}/*.ts` subcommand wrappers. Verbose/debug flags propagate via LW_VERBOSITY env var. `package.json#bin` registers `lw` so `npx lw …` works in CI.
- **Dependencies**: none.
- **Files**: `scripts/cli.ts` (new), `scripts/lib/*.ts` (6 files new), `scripts/bills/backfill.ts` (new), `scripts/kv/publish.ts` (new), `package.json` (bin + lw script + commander devDep).
- **Acceptance Criteria**: Per memory `feedback_seeding_is_buildops_not_runtime` — CLI lives in scripts/, Worker + SPA never drive ingest.
- **Test Requirements**: Smoke: `npm run lw -- --help`, `--version`, subcommand `--help` all render. Typecheck clean.
- **Traces to**: FR-59 AC-59.1, AC-59.2.
- **Status**: [x] Done — 2026-05-25.

### T-135: v4.1.0 — Extract `importBillCore`
- **Description**: Pull orchestration body from proxy/services/import-bill.ts into scripts/lib/bills/import-core.ts as a pure fn over D1Like + CongressClient + AuditLogger interfaces. Worker adapter becomes 90 lines. Tests rewrite acceptable per D10.
- **Files**: `scripts/lib/bills/import-core.ts` (new, ~600 lines), `proxy/services/import-bill.ts` (now adapter).
- **Acceptance Criteria**: FR-59 AC-59.1, AC-59.6 (every recordedVote preserved).
- **Test Requirements**: 19 existing importBill tests pass via the Worker adapter without change. Full suite green.
- **Traces to**: FR-59.
- **Status**: [x] Done — 2026-05-25.

### T-136: v4.1.0 — `lw bills backfill` driver
- **Description**: Pure backfillBills() + CLI wrapper. Iterates bills ASC, 4-way concurrency, force=false default honors freshness gates. Per-bill error continuation, audit_log writes on failure, exit codes 0/1/2.
- **Files**: `scripts/lib/bills/backfill.ts` (new), `scripts/bills/backfill.ts` (wrapper).
- **Acceptance Criteria**: FR-59 AC-59.1, AC-59.3, AC-59.10.
- **Test Requirements**: 5 tests in tests/unit/bills/backfill.test.ts cover process-all, per-bill errors, limit, cursor, filter.
- **Traces to**: FR-59.
- **Status**: [x] Done — 2026-05-25.

### T-137: v4.1.0 — Delete useAutoBackfill SPA hook + /api/admin/backfill-bills route
- **Description**: Remove dead browser-driven ingest paths. Hook + localStorage cursor + the Worker route + their tests all deleted in one commit. Per memory `feedback_seeding_is_buildops_not_runtime`.
- **Files**: `src/admin/App.tsx` (hook + useEffect removed), `proxy/routes/api-admin.ts` (route handler + dispatch removed), `tests/unit/useAutoBackfill.test.tsx` (deleted), `tests/unit/apiAdminRoutes.test.ts` (block removed).
- **Acceptance Criteria**: FR-59 AC-59.9.
- **Test Requirements**: full suite green after removals; no orphaned references.
- **Traces to**: FR-59.
- **Status**: [x] Done — 2026-05-25.

### T-138: v4.1.0 — Migration 0010 (direction corrections)
- **Description**: 118-HR-2445 + 118-S-2552 direction='anti-ukraine' → 'neutral' with audit_log rows. Rollback in _rollbacks/.
- **Files**: `migrations/d1/0010_v4_1_0_direction_corrections.up.sql`, `migrations/d1/_rollbacks/0010_v4_1_0_direction_corrections.sql`.
- **Acceptance Criteria**: FR-59 AC-59.7.
- **Status**: [x] Done — 2026-05-25.

### T-139: v4.1.0 — Data Freshness panel + endpoint
- **Description**: Settings ▸ Data freshness — research-facing observation of bill corpus state. New /api/admin/data-freshness endpoint aggregates: total, by-congress, by-direction, became-law, freshness buckets (24h/7d/30d/stale), top-20 stale bills, last refresh attempt. SPA view renders read-only with research-relevant language only (no operator-state terms).
- **Files**: `proxy/routes/api-admin.ts` (handleDataFreshness added), `src/admin/components/settings/DataFreshnessView.tsx` (new), `src/admin/components/settings/SettingsTab.tsx` (slot registered).
- **Acceptance Criteria**: FR-59 AC-59.8.
- **Status**: [x] Done — 2026-05-25.

### T-140: v4.1.0 — GitHub Actions backfill workflow
- **Description**: .github/workflows/backfill-bills.yml — cron 6h dev/uat + 12h stg/prod, workflow_dispatch with env/force/limit/concurrency inputs, per-env matrix with gate. Invokes `npx tsx scripts/cli.ts bills backfill --env <env> --verbose`. Exit 0/2 → green, exit 1 → red.
- **Files**: `.github/workflows/backfill-bills.yml` (new).
- **Acceptance Criteria**: FR-59 AC-59.11.
- **Status**: [x] Done — 2026-05-25.

### T-141: v4.1.0 — PeopleTab roster-driven enumeration
- **Description**: PeopleTab in admin SPA now enumerates from KV name-index (mocMap) — every sitting member of Congress gets a card whether they have handle rows or not. Zero-handle members render with "no handles tracked" italic caption. Header coverage metric "N people · M handles · X/Y Congress with handles" makes the gap visible.
- **Files**: `src/admin/components/PeopleTab.tsx`.
- **Acceptance Criteria**: Resolves the UAT audit observation "306 of 535 visible" by including the missing members.
- **Status**: [x] Done — 2026-05-25.

---

## Phase 15: V4.1.1 — Profile Widget-Preview Deep Link (FR-60)

### T-142: v4.1.1 — Embed `?bioguide` pass-through
- **Description**: `buildEmbedHtml` reads `?bioguide=<id>` from the request URL, validates it against `^[A-Z][0-9]{6}$`, and (only when valid) sets a `bioguide` attribute on the mounted `<voter-info-widget>`. Absent/invalid → no attribute (unchanged embed). Router passes the request URL/parsed bioguide through. No raw interpolation of the query value into HTML.
- **Dependencies**: None.
- **Files**: `proxy/routes/preview.ts`, `proxy/router.ts`.
- **Acceptance Criteria**: FR-60 AC-60.1, AC-60.7.
- **Test Requirements**: unit tests in `tests/unit/preview-embed.test.ts` — valid bioguide sets attribute; missing param omits it; malformed param (lowercase, wrong length, injection payload `"><script>`) omits it and emits no extra markup; no-param HTML behaviorally identical to pre-FR-60.
- **Traces to**: FR-60.
- **Status**: [x] Done — 2026-05-30.

### T-143: v4.1.1 — Widget `bioguide` attribute → `initialBioguide` prop
- **Description**: `<voter-info-widget>` adds `bioguide` to `observedAttributes` and threads it to `VoterInfoWidget` as `initialBioguide`. Attribute change after mount re-renders.
- **Dependencies**: T-142 (contract), can proceed in parallel.
- **Files**: `src/embed.tsx`.
- **Acceptance Criteria**: FR-60 AC-60.2.
- **Test Requirements**: covered via the VoterInfoWidget integration test (T-144) plus an embed.tsx attribute-wiring assertion.
- **Traces to**: FR-60.
- **Status**: [x] Done — 2026-05-30.

### T-144: v4.1.1 — `VoterInfoWidget` direct-member render path
- **Description**: When `initialBioguide` is a non-empty shape-valid id, fetch `/api/members/{id}`, build a `Representative` (name `"Last, First"`, party expansion, `partyAbbreviation`, state, district, chamber lowercased, sanitized photo/website, yearEntered) and render `RepDetail` open on load — no `/api/name-search`, no NameSearchResultsPanel. Loading affordance while in flight; abort/ignore stale fetch on `initialBioguide` change; 404/non-OK/error degrades to the normal entry screen without throwing.
- **Dependencies**: T-143.
- **Files**: `src/VoterInfoWidget.tsx`, possibly a small `src/hooks/useMemberById.ts`.
- **Acceptance Criteria**: FR-60 AC-60.3, AC-60.4, AC-60.5.
- **Test Requirements**: integration tests in `tests/integration/widget-deeplink.test.tsx` — happy path renders RepDetail for the member and issues no name-search; 404 falls back to entry screen; stale fetch ignored on bioguide change; no `initialBioguide` renders the unchanged entry screen.
- **Traces to**: FR-60.
- **Status**: [x] Done — 2026-05-30.

### T-145: v4.1.1 — Admin PersonProfileView preview wiring + copy fix
- **Description**: PersonProfileView builds iframe `src` = `${window.location.origin}/embed?bioguide=${encodeURIComponent(bioguideId)}`; heading no longer hard-codes "trackukraine.com" (reads "Widget Preview"); the "search for {name}" instruction removed in favor of an env-data caption.
- **Dependencies**: T-142, T-144.
- **Files**: `src/admin/components/PeopleTab.tsx`.
- **Acceptance Criteria**: FR-60 AC-60.6.
- **Test Requirements**: unit/render assertion that the iframe `src` carries `?bioguide=<id>` and the stale domain string is gone.
- **Traces to**: FR-60.
- **Status**: [x] Done — 2026-05-30.

### T-146: v4.1.1 — Hide entry controls in single-member deep-link mode
- **Description**: When a deep-link bioguide is loading/resolved (and the user hasn't started their own lookup/search), VoterInfoWidget hides AddressInput + NameSearchInput so the embed shows only that member's profile. 404/error falls back to the full entry screen.
- **Files**: `src/VoterInfoWidget.tsx`.
- **Acceptance Criteria**: FR-60 AC-60.8.
- **Test Requirements**: widgetDeepLink.test.tsx asserts `.viw-address-form`/`.viw-name-search-form` absent on success, present on 404 fallback.
- **Traces to**: FR-60.
- **Status**: [x] Done — 2026-05-30.

### T-147: v4.1.1 — Per-response CSP nonce for embed inline script
- **Description**: Pre-existing bug surfaced by FR-60: the /embed route's `script-src` (no 'unsafe-inline') blocked the embed's own inline mount/resize script, so the widget never mounted. Router now generates `crypto.randomUUID()` per response, stamps it on the inline `<script>` via buildEmbedHtml, and adds `'nonce-<v>'` to script-src. Verified live in Chrome.
- **Files**: `proxy/router.ts`, `proxy/routes/preview.ts`.
- **Acceptance Criteria**: FR-60 AC-60.9.
- **Test Requirements**: previewEmbedDeepLink.test.ts (nonce stamped/omitted); routerExtended.test.ts (CSP carries nonce, no script 'unsafe-inline', body script nonce matches header).
- **Traces to**: FR-60.
- **Status**: [x] Done — 2026-05-30.

### T-148: v4.1.1 — Profile two-column layout + collapsible monitoring
- **Description**: PersonProfileView restructured to a responsive CSS-grid. Desktop (≥900px): left column = Social monitoring + Quotes + Live Feed; right column = sticky Widget Preview; Recent Ingested Posts full-width below. Mobile: single column ordered preview → social → quotes → feed → posts. Social monitoring is a collapsible panel (collapsed by default) whose header keeps the FreshnessBadge issue summary visible. New `useMediaQuery` hook (admin uses inline styles, no @media).
- **Files**: `src/admin/components/PeopleTab.tsx`, `src/admin/useMediaQuery.ts` (new).
- **Acceptance Criteria**: FR-60 AC-60.10.
- **Test Requirements**: PeopleTab.test.tsx — existing social/re-poll tests expand the panel first; new test asserts collapsed-by-default + issue summary visible on header.
- **Traces to**: FR-60.
- **Status**: [x] Done — 2026-05-30. Verified live on dev (desktop 2-col + sticky + collapsed monitoring).

### T-149: v4.1.1 — Re-poll refreshes posts feed (bug)
- **Description**: PeopleTab queue `useEffect` deps add `reloadHandles` so a completed re-poll refetches the ingested-posts feed.
- **Files**: `src/admin/components/PeopleTab.tsx`.
- **Acceptance Criteria**: FR-60 AC-60.22.
- **Status**: [x] Done — 2026-05-30.

### T-150: v4.1.1 — Stored "unrelated" post status + migration 0011
- **Description**: `enqueuePost` derives `status` from `matchedKeywords` (matched→pending, none→unrelated) with an explicit override; `/queue` POST passes `pending`. Migration 0011 idempotent backfill of pre-existing keyword-less unreviewed rows.
- **Files**: `proxy/d1/ingest-store.ts`, `proxy/routes/api-admin-ingest.ts`, `migrations/d1/0011_social_queue_unrelated_status.up.sql` (+ rollback).
- **Acceptance Criteria**: FR-59 AC-59.20..59.23.
- **Test Requirements**: ingestStore.test.ts (derivation + override); apiAdminIngest.test.ts (poll-handle pending/unrelated).
- **Status**: [x] Done — 2026-05-30.

### T-151: v4.1.1 — resolveMemberVotes shared resolver
- **Description**: New `src/services/memberVotes.ts` pure resolver (House by bioguide / Senate by lastName+state; for/against = valence sign; degrades missing roster to Did Not Serve). `useVotingRecord` delegates to it.
- **Files**: `src/services/memberVotes.ts` (new), `src/hooks/useVotingRecord.ts`.
- **Acceptance Criteria**: FR-32 AC-32.30..32.33.
- **Test Requirements**: memberVotes.test.ts; votingRecord.test.ts unchanged (extraction guard).
- **Status**: [x] Done — 2026-05-30.

### T-152: v4.1.1 — Tabbed left column + Social Feed (related/unrelated)
- **Description**: Left column tabs (Quotes default | Social Feed | Bills); header/cards/Social-monitoring above tabs. Social Feed = stored posts with related-by-default + "Show unrelated" checkbox; ephemeral Live Feed Search UI deleted (re-pull via existing poll-handle). Bills tab hidden for non-Congress people.
- **Files**: `src/admin/components/PeopleTab.tsx`.
- **Acceptance Criteria**: FR-60 AC-60.14/15/16.
- **Test Requirements**: PeopleTab.test.tsx tab-switch, related/unrelated filter, Live-Feed-Search-removed; old live-feed tests deleted.
- **Status**: [x] Done — 2026-05-30.

### T-153: v4.1.1 — Resizable/collapsible/full-height preview + Bills matrix
- **Description**: `useProfileLayout` (localStorage previewPct/collapsed) + `DraggableDivider` + full-height scroll-boundary grid + collapse-to-strip. `MemberVotesMatrix` + `useMemberVotes` Bills tab matrix (live roster fetches via resolveMemberVotes).
- **Files**: `src/admin/useProfileLayout.ts` (new), `src/admin/components/DraggableDivider.tsx` (new), `src/admin/components/MemberVotesMatrix.tsx` (new), `src/admin/components/PeopleTab.tsx`.
- **Acceptance Criteria**: FR-60 AC-60.17/18/19/20/21.
- **Test Requirements**: PeopleTab.test.tsx collapse toggle, divider keyboard persistence, Bills matrix render/empty.
- **Status**: [x] Done — 2026-05-30.

---

## Phase 16: V4.1.2 — Full D1 durability (members, casts, state-members, name-index) + cross-chamber

### T-154: v4.1.2 — Cross-chamber resolveMemberVotes
- **Description**: resolveMemberVotes gathers BOTH chambers' curated votes; House matched by bioguideId, Senate by lastName+state, regardless of current chamber. Fixes chamber-switchers (e.g. Schiff S001150) showing an empty/insufficient record.
- **Files**: `src/services/memberVotes.ts`, `tests/unit/memberVotes.test.ts`.
- **Acceptance Criteria**: FR-32 AC-32.34, AC-32.35.
- **Status**: [x] Done — 2026-05-31.

### T-155: v4.1.2 — vote_casts table + lw rosters seed + route D1 self-heal
- **Description**: Migration 0012 `vote_casts` (durable per-member casts). `lw rosters seed` enumerates curated roll-calls from D1 `votes`, fetches casts upstream (House JSON / Senate XML, extracted to `scripts/lib/rosters/fetch-casts.ts`), upserts idempotently, audit on failure, exit 0/1/2. `/api/roll-call-rosters` keeps KV read + on miss assembles from D1 `vote_casts` and write-through caches (self-heal).
- **Files**: `migrations/d1/0012_vote_casts.up.sql` (+ rollback), `scripts/rosters/seed.ts`, `scripts/lib/rosters/{seed,fetch-casts}.ts`, `scripts/cli.ts`, `proxy/routes/api-roll-call-rosters.ts`.
- **Acceptance Criteria**: FR-32 AC-32.36, AC-32.37, AC-32.38, AC-32.41 (roster).
- **Test Requirements**: rosters/seed.test.ts; rollCallRosterRoute.test.ts (KV-miss→D1 assemble + write-through; both-empty→404).
- **Status**: [x] Done — 2026-05-31.

### T-156: v4.1.2 — members table + lw members seed
- **Description**: Migration 0013 `members` (durable identity + sponsored/cosponsored + socials + searchKey). `lw members seed` enumerates current members, fetches detail + sponsored/cosponsored + socials, upserts, freshness-gated, audit, exit 0/1/2.
- **Files**: `migrations/d1/0013_members.up.sql` (+ rollback), `scripts/members/seed.ts`, `scripts/lib/members/{seed,normalize}.ts`, `scripts/cli.ts`.
- **Acceptance Criteria**: FR-32 AC-32.39.
- **Test Requirements**: members/seed.test.ts (enumerate→fetch→upsert; freshness gate; per-member error→audit+continue).
- **Status**: [x] Done — 2026-05-31.

### T-157: v4.1.2 — D1→KV projections + route fallbacks
- **Description**: Pure projector `proxy/services/member-projector.ts` (member:v1:/state-members:v1:/name-index:v1:+meta/roll-call-roster:v1: from members+vote_casts), re-exported by `scripts/lib/members/project.ts`. Wired into `publish-d1-to-kv.ts` (now also projects roll-call:v1:); `lw kv publish` repointed from `publish-to-kv.ts` → `publish-d1-to-kv.ts` (D1 is source of truth, no upstream fetch). D1-fallback (self-heal on KV miss + write-through) added to api-members/api-state-members/api-name-search/api-roll-call-rosters.
- **Files**: `proxy/services/member-projector.ts` (new), `scripts/lib/members/project.ts`, `scripts/publish-d1-to-kv.ts`, `scripts/kv/publish.ts`, `proxy/routes/{api-members,api-state-members,api-name-search,api-roll-call-rosters}.ts`.
- **Acceptance Criteria**: FR-32 AC-32.40, AC-32.41.
- **Test Requirements**: members/project.test.ts; publishD1ToKv.test.ts (member/state/name-index/roster + roll-call keys); kvRoutes.test.ts + stateMembersRoute.test.ts + rollCallRosterRoute.test.ts (D1 self-heal fallback).
- **Status**: [x] Done — 2026-05-31.

### T-158: v4.1.2 — party-priors source (deferred) + dev rollout
- **Description**: party-priors stays curated-JSON-sourced (documented exception, AC-32.42). Dev rollout: migrate 0012+0013, lw members seed, lw rosters seed, lw kv publish, deploy; verify Schiff cross-chamber + KV-flush self-heal in Chrome.
- **Acceptance Criteria**: FR-32 AC-32.42 (exception), AC-32.35/41 verification.
- **Status**: [ ] Pending dev rollout (outward-facing — awaiting go-ahead).
