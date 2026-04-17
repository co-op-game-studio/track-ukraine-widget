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

---

## Phase 7: CI/CD (Specification Only — Implementation Deferred)

### T-026: CI/CD Pipeline Setup
- **Description**: Implement CI/CD as specified in docs/ci-cd.md
- **Dependencies**: All prior tasks
- **Status**: [ ] Deferred — specification written, implementation postponed
