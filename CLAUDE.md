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

## Development Workflow

This project follows **Specification-Driven Development (SDD)** with **Test-Driven Development (TDD)**:

1. **Spec first**: Every feature traces to a requirement in `docs/spec.md` and a design in `docs/design.md`
2. **Test second**: Write failing tests before implementation. Tests derive from acceptance criteria in the spec.
3. **Implement third**: Write minimum code to make tests pass.
4. **Refactor fourth**: Clean up while tests stay green.

**Never implement without a corresponding test. Never write a test without tracing it to a spec requirement.**

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
