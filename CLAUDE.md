# Voter Information Widget

## Overview

Embeddable, stateless web component that lets U.S. voters look up their federal representatives (senators + house rep) and view their voting records, sponsored legislation, and party alignment scores.

## Git commit rules

**Never add `Co-Authored-By: Claude` (or any Claude/AI co-author trailer) to commit messages.** No exceptions. Commits should look like they were written by the human author — no AI attribution, no `🤖 Generated with Claude Code` footers, nothing of the sort. This applies to every commit, every PR description, every amend.

## Specification Documents

All development must trace back to these specs:

- **Requirements**: `docs/spec.md` — Functional and non-functional requirements, user stories, acceptance criteria, data dictionary
- **Design**: `docs/design.md` — Architecture, component structure, data flow, algorithms (IEEE 1016-based)
- **API Contracts**: `docs/api-contracts.md` — Exact external API endpoints, request/response shapes, proxy routing
- **Tasks**: `docs/tasks.md` — Implementation task breakdown with dependencies and traceability
- **Decisions**: `docs/decisions/ADR-*.md` — Architecture decision records with rationale
- **CI/CD**: `docs/ci-cd.md` — Pipeline specification (implementation deferred)

## Development Workflow — AIDD (AI-Driven Development)

This project is built with **AIDD**: AI-Driven Development. The human sets intent and reviews output; Claude executes the full SDD+TDD loop end-to-end — updating specs, writing failing tests, implementing code, and reconciling drift. AIDD is not "AI autocomplete" bolted onto a human-driven workflow — it is the workflow. The loop below is the contract.

AIDD fuses two practices into one pipeline:

- **Specification-Driven Development (SDD)** — every behavior is defined in `docs/` before it exists in code. The spec is the source of truth; code is the spec's runtime projection.
- **Test-Driven Development (TDD)** — every behavior has a failing test before it has an implementation. Tests are the spec's executable projection.

### The four-phase loop (every feature, every fix, every refactor)

Claude runs this loop for every unit of work. No phase may be skipped, merged, or reordered.

1. **Spec first** — *before any code or tests exist.*
   - Every feature traces to a numbered requirement in `docs/spec.md` (functional `FR-*` or non-functional `NFR-*`) and, where architecture is affected, a design section in `docs/design.md`.
   - Every new user-facing behavior gets **acceptance criteria** (`AC-N.M`) in the spec. These are the atomic units that tests will later assert against.
   - Architecturally significant choices get an **ADR** (`docs/decisions/ADR-NNN-<slug>.md`) capturing context, decision, and consequences. ADRs are append-only — supersede, don't rewrite.
   - API surfaces touching external services go in `docs/api-contracts.md` with exact request/response shapes.
   - Large efforts get a **task breakdown** in `docs/tasks.md` with dependencies, linked spec/design anchors, test requirements, and a status checkbox.
   - **Exit criterion for Phase 1:** the spec could be handed to a different implementer and they would build the same thing.

2. **Test second** — *tests exist and fail before any implementation.*
   - Each acceptance criterion (`AC-N.M`) maps to at least one test. Tests cite the `AC` in a comment or `describe` block so traceability is visible in the test output.
   - Tests live in `tests/unit/`, `tests/integration/`, or `tests/e2e/` according to the scope of the behavior being asserted.
   - Tests are written against the *spec*, not against the implementation you're about to write. If the spec is ambiguous, fix the spec first (see Spec-as-Truth) — do not let the test silently decide what the behavior is.
   - Run the test suite and confirm the new tests **fail for the right reason** (missing implementation, not a typo). A test that passes before implementation is a broken test.
   - **Exit criterion for Phase 2:** the new tests are red, and every red test cites a spec `AC` or `FR`/`NFR`.

3. **Implement third** — *minimum code to turn red tests green.*
   - Write only what's needed to satisfy the failing tests. Do not add features, hooks, or abstractions beyond what the spec requires.
   - Obey the layering conventions (services are pure, hooks orchestrate, components are presentational — see "Code Conventions" below).
   - Do not modify tests during implementation to make them pass. If a test looks wrong, stop and fix the spec, then the test — never the assertion under the implementation.
   - Run the suite frequently. Partial greenness is fine mid-phase; full greenness is the exit condition.
   - **Exit criterion for Phase 3:** every test is green, `npm run typecheck` is clean, `npm run lint` is clean.

4. **Refactor fourth** — *clean up while the suite stays green.*
   - Only now: extract helpers, rename for clarity, collapse duplication, tighten types.
   - Run the full suite after each non-trivial refactor step. A red test during refactor means the refactor changed behavior — revert and reconsider.
   - If refactor reveals the spec or design should have been written differently, update `docs/` and `docs/decisions/ADR-*.md` as part of the refactor — don't leave the divergence for "later."
   - **Exit criterion for Phase 4:** suite green, spec and code agree, task checkbox flipped in `docs/tasks.md`.

### Non-negotiable rules

- **Never implement without a corresponding failing test.**
- **Never write a test without tracing it to a spec requirement.**
- **Never edit the spec to match broken code** — edit the code to match the spec. The only exception is the Spec-as-Truth case below (reality contradicts the spec), and that exception triggers a deliberate spec update first.
- **Never skip the "red" step of TDD.** A test authored after its implementation has no evidence it actually tests the behavior.
- **Never batch phases.** Do not write spec + tests + implementation in one pass and claim to have "followed AIDD." The value of the loop is the gate between each phase.

### What Claude does in each phase (role split)

Because this is AI-*driven* development, Claude executes all four phases by default — but **the developer owns the spec.** The spec is a human-authored artifact that encodes product intent and domain judgment. Claude drafts, edits, and expands it only in service of what the developer has specified; Claude does not invent requirements, invent acceptance criteria from thin air, or "round up" vague intent into concrete behavior without confirmation.

The human's role is to:

- **Author the spec's intent.** State what the system must do and why ("voters should see their reps' Ukraine votes", "embeds must work on Fourthwall's sandboxed theme slot", "no new runtime deps"). This is the input Claude cannot fabricate.
- **Arbitrate ambiguity.** When Claude flags an inconsistency or gap (see below), the developer decides which reading is correct.
- **Review spec updates before tests are written** — the highest-leverage review point, because every downstream artifact derives from the spec.
- **Review the failing tests before implementation** — catch "wrong test shape" early, when it costs nothing to fix.
- **Approve the final diff** (code + spec + tests together) at PR time.

Claude, in turn:

- **Treats the spec as developer-specified.** Claude's job is to make the developer's spec coherent, testable, and traceable — not to author intent. If a requirement is missing, Claude asks; it does not fill in.
- **Proposes spec changes as diffs** to `docs/spec.md` / `docs/design.md` / `docs/api-contracts.md`, not as prose in chat.
- **Enumerates acceptance criteria explicitly** — no implicit behaviors, no "obviously it should also…" additions without developer sign-off.
- Writes tests first, runs them, shows the red output, then implements.
- Updates `docs/tasks.md` status as each task closes.
- Opens ADRs proactively when a decision has more than one reasonable answer.

### Challenging the spec (Claude's obligation)

The spec is developer-authored, but **Claude is obligated to push back when the spec is inconsistent, incoherent, untestable, or contradicts another spec section.** Silently "interpreting" a broken spec is the single most expensive failure mode in AIDD — it produces code that looks correct, tests that pass, and behavior that's wrong in a way no one can trace.

When Claude finds a problem in the spec, the response must be structured:

1. **Point out the specific defect** — quote the exact clause(s), cite the section (`spec.md §3.2 AC-3.4`), and name the category of defect (see below).
2. **Explain why it's a defect** — what ambiguity, contradiction, or untestability it introduces, and what would go wrong if it were implemented as written.
3. **Show a concrete corrected pattern** — a proposed rewrite of the clause in the spec's house style, with at least one example of the fixed behavior.
4. **Stop the loop until the developer decides.** Do not proceed to tests or code on a defective spec.

Categories of defect to watch for, with examples of the proper pattern:

- **Ambiguous quantifiers.**
  - *Bad:* "The widget should load quickly."
  - *Why broken:* "Quickly" is not testable. Two reviewers will disagree on pass/fail.
  - *Good:* "NFR-4: Time-to-interactive ≤ 2.0s on a 4G connection (Lighthouse throttled profile), measured on `index.html` with cold cache."

- **Contradiction between sections.**
  - *Bad:* §2 says "all votes are shown"; §3.3 AC-3.3 says "only curated Ukraine votes are shown."
  - *Why broken:* One of these is wrong. A test written against §2 will contradict a test written against §3.3.
  - *Good:* Pick one. Update the other to reference it. If both are intentionally scoped to different surfaces, say so explicitly: "§2 describes the data model; §3.3 describes the UI filter applied before rendering."

- **Non-falsifiable assertions.**
  - *Bad:* "The system handles errors gracefully."
  - *Why broken:* There is no observable behavior being specified. No test can fail.
  - *Good:* "AC-7.2: On a 5xx response from `/api/congress/*`, the widget shows an `ErrorBanner` with `role='alert'` containing the text 'Unable to load representatives. Try again.' and hides the `ResultsPanel`."

- **Implementation leaking into requirements.**
  - *Bad:* "The widget uses `useState` to store the selected district."
  - *Why broken:* This is a design/implementation choice, not a requirement. It over-constrains design and makes refactors appear to violate the spec.
  - *Good:* Requirement in `spec.md`: "FR-2: The system retains the selected district across re-renders within a single session." Design choice (`useState` vs context vs store) belongs in `design.md §X.Y`.

- **Missing boundary conditions.**
  - *Bad:* "The user enters an address and sees their reps."
  - *Why broken:* What about at-large districts? Territories? Invalid addresses? PO boxes? Each missing boundary is a latent bug and an untested code path.
  - *Good:* Enumerate boundary cases as explicit ACs (`AC-1.4: at-large states return the single at-large rep; AC-1.5: invalid addresses produce an actionable error`). If a boundary is intentionally out of scope, say so: "Territories (PR, VI, GU, AS, MP) are out of scope for v2; FR-X covers them."

- **Hidden coupling between requirements.**
  - *Bad:* FR-10 changes the cache key format; FR-11 adds a new endpoint. Both land in one task with no note that FR-11 depends on FR-10.
  - *Why broken:* Task ordering becomes guesswork; partial deploys break.
  - *Good:* Declare the dependency in `docs/tasks.md` and in the spec prose ("FR-11 requires FR-10 cache-key v2 to be in place").

- **Untestable because side-effects aren't observable.**
  - *Bad:* "The worker logs a warning when the API key is near expiry."
  - *Why broken:* "Logs" is not observable from a test harness by default.
  - *Good:* Define the observable surface — e.g., an `X-Key-Expiry-Warning` response header, or a structured log line with a fixed shape asserted via a log capture, or a counter metric — so a test can actually assert the behavior.

### Bias toward testable design

At every design decision, prefer the option that is easier to test. Testability is not a tax on design — it is a proxy for coupling, side-effect discipline, and clear interfaces. Code that is hard to test is, almost without exception, code that is hard to reason about.

Concrete patterns this project favors, and the anti-patterns they replace:

- **Pure functions over stateful classes.** Services in `src/services/` are `async (input) => output` functions with no React, no module-scope mutable state, no hidden singletons. Every input that affects output is a parameter. *Anti-pattern:* a service that reads from a module-scope cache it also writes to — tests have order dependencies and flake.

- **Dependency injection at the boundary.** When a function needs `fetch`, the clock, or a random source, accept it as a parameter (or via a small factory) rather than reaching for the global. Production wires the real thing; tests wire a fake. *Anti-pattern:* `Date.now()` called inline inside business logic — tests must mock globals or freeze time, and failures are hard to reproduce.

- **Parse, don't validate, at the edge.** External API responses are parsed into `types/domain.ts` shapes at the service boundary. Downstream code consumes the domain type and cannot encounter a half-validated API shape. *Anti-pattern:* passing raw `any` from `fetch` through hooks and components — every consumer re-checks the same fields, and tests must construct realistic API payloads instead of simple domain objects.

- **Hooks orchestrate, components render.** `src/hooks/` owns loading/error/data state and composes services. `src/components/` receives the resolved props and renders. This lets components be tested with static props (no `act`, no async waits) and lets hooks be tested without a DOM. *Anti-pattern:* a component that calls `fetch` in `useEffect` — to test it you need a DOM, a fake network, and async plumbing, just to assert "it shows the name."

- **Observable side-effects over hidden ones.** If the worker needs to signal something (cache hit, origin rejection, key expiry), expose it as a response header, a structured log line with a stable shape, or a counter — not an implicit log string. Tests assert the observable. *Anti-pattern:* "we can see it worked because the log says so" with no stable format — every log string change breaks tests or, worse, silently stops being asserted.

- **Deterministic inputs in tests.** Fixtures in `tests/**/__fixtures__/` are committed JSON captured from real API responses. Tests run against fixtures, not live APIs. *Anti-pattern:* tests that hit the network "just for this one case" — they turn CI red on unrelated upstream hiccups.

- **Narrow, named types at module boundaries.** Functions export their argument and return types (or accept/return domain types from `types/domain.ts`). *Anti-pattern:* functions that take `options: Record<string, unknown>` — the test has to guess which keys matter, and the compiler can't catch misuse.

- **Fail loudly, fail early.** When a precondition is violated (missing API key, unknown FIPS code, malformed fixture), throw with a specific message naming the input. Tests assert on the thrown error. *Anti-pattern:* returning `null` or `undefined` on unexpected input — the error surfaces three layers up as a `Cannot read property 'x' of null` with no context.

When a proposed design resists these patterns, that is a signal to **revisit the spec or the design** — not to write hard-to-test code. Either the requirement is shaped in a way that forces bad coupling (fix the requirement), or the design is wrong (fix the design), or an ADR is needed to capture why the testable pattern doesn't apply here (rare).

### Traceability chain

Every line of production code must be reachable from a spec requirement via this chain:

```
FR-N / NFR-N        (docs/spec.md — what the system must do)
    │
    ├── AC-N.M     (docs/spec.md — observable acceptance criteria)
    │       │
    │       └── test in tests/{unit,integration,e2e}/*.test.ts
    │               │
    │               └── implementation in src/**
    │
    └── design §X.Y (docs/design.md — how we chose to build it)
            │
            └── (optional) ADR-NNN (docs/decisions/ — why we chose it)
```

If you cannot walk this chain for a piece of code, the chain is broken — stop and repair it before adding more.

## Spec-as-Truth Principle (CRITICAL)

**When reality diverges from OUR SDD specs, fix the spec — don't code around it.**

Our `docs/` artifacts (`spec.md`, `design.md`, `api-contracts.md`) are living, authoritative documents. If you discover the API actually behaves differently than our spec says, update the spec first, then update the tests, then update the code. This makes every discrepancy a one-time fix with a durable record instead of recurring confusion.

**External specs** (like `docs/congress-api-openapi.json`) are vendored inputs — treat them as read-only reference material. When external specs are incomplete or wrong compared to real API responses, capture the truth in OUR `docs/api-contracts.md` with a "Divergence from OpenAPI spec" note that cites what was observed. The refresh script `scripts/extract-openapi.mjs` re-pulls external specs; divergence notes survive because they live in OUR docs.

## Task Execution

Follow `docs/tasks.md` in dependency order. For each task:
1. Check task dependencies are complete
2. Read the linked spec requirements and design sections
3. Write/verify failing tests exist (per task's "Test Requirements" field)
4. Implement the code
5. Run tests — all must pass
6. Mark task complete in `docs/tasks.md`

## Tech Stack

- **React 19** + **TypeScript** (strict mode) — UI framework
- **Vite 6** — Build tool, dev server with proxy
- **Vitest** + **React Testing Library** — Test framework
- **Shadow DOM** + **Web Component** — Embed isolation (`<voter-info-widget>`)

## Project Structure

```
src/
  types/         — TypeScript types (domain.ts, api.ts)
  services/      — Pure async functions for API calls (no React)
  hooks/         — React hooks composing services into stateful workflows
  components/    — Presentational React components (props in, JSX out)
  utils/         — Utility functions (FIPS map, formatters)
  styles/        — CSS (loaded into Shadow DOM)
tests/
  unit/          — Unit tests for services, utils, components
  integration/   — Hook-level tests with mocked services
  e2e/           — Full widget integration tests
```

## Code Conventions

- **Services are pure functions** — no React imports, no state, just async I/O
- **Hooks orchestrate** — compose services, manage loading/error/data state
- **Components are presentational** — receive data + callbacks via props
- **Types mirror their source** — `types/api.ts` matches external API shapes, `types/domain.ts` is our internal model
- **No mocking of browser APIs in unit tests** — use `msw` or manual fetch mocks for API tests
- **Normalize vote terminology** — Senate uses Yea/Nay, House uses Aye/Nay. Services normalize to Aye/Nay before returning domain types.

## API Key Handling

- **Development**: Keys in `.env` file (gitignored), injected by Vite proxy
- **Production**: Keys in CORS proxy environment variables, never in client bundle
- **Tests**: All API calls are mocked — no real keys needed
- **NEVER commit API keys** to source control

## External APIs

| API | Purpose | Auth | CORS |
|-----|---------|------|------|
| Census Bureau Geocoder | Address → state FIPS + district number | None | No — proxy required |
| Congress.gov (v3) | Members, votes, bills | API key | No — proxy required |
| Senate.gov (XML) | Senate vote data | None | No — proxy required |

All requests go through `/api/census/*`, `/api/congress/*`, `/api/senate/*` proxy paths.

## Running the Project

```bash
npm install          # Install dependencies
npm run dev          # Start dev server (port 5173)
npm test             # Run tests once
npm run test:watch   # Run tests in watch mode
npm run build        # Build embeddable widget
npm run typecheck    # Type check without emitting
npm run lint         # Lint source and tests
```

## Key Algorithms

- **Census Geocoding + FIPS Map**: See `design.md §4.1` — extracts state FIPS + district from Census geocoder, maps FIPS to state code
- **Party Alignment**: See `design.md §4.5` — percentage of party-line votes where member sided with own party
- **Senate Member Matching**: See `design.md §4.3` — matches by last_name + state (no bioguide in XML)
