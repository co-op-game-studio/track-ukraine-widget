# ADR-015: Proxy Module Refactor — from God Module to Composed OOP

**Status**: Accepted
**Date**: 2026-04-19
**Traces to**: FR-42

## Context

`proxy/lib.ts` has grown to 1569 lines. It holds:

- Request routing
- CORS and security-header emission
- Origin allowlist logic
- Rate-limit gate
- KV helpers for six distinct record kinds
- Dead R2-era comments from a prior architecture
- Member-profile build-through from Congress.gov
- Name-search query normalization and result ranking
- Every route handler for every `/api/*` path
- Preview-HTML generation
- URL validation, fingerprinting-header stripping, error-body normalization

`tests/unit/worker.test.ts` mirrors this at 1678 lines.

Consequences we have actually observed:
- A change to rate-limit behavior required reading unrelated CORS code to confirm no coupling.
- `memberProfileParseResilience.test.ts` had to be added after a production incident in which the member-profile parse path silently absorbed a truncated upstream response, because the parse logic was tangled with the caching logic.
- Adding the tiered cache (ADR-014) is functionally impossible to do cleanly inside the existing god module.

This is the full refactor the user signed off on on 2026-04-19:

> "proxy/lib.ts is 1569 lines today... This IS A PROBLEM. — 1600 lines means we aren't composing properly OOP friendly designs. Let's sort that. This is typescript act like it."

## Decision

Decompose `proxy/lib.ts` into a composed module tree under `proxy/` where each file has a single responsibility, file size is capped at 300 lines (AC-42.2), and every class receives its dependencies via constructor injection.

**Target layout:**

```
proxy/
  worker.ts                      — entry shim (≤100 lines)
  router.ts                      — Request → RouteHandler dispatch
  routes/                        — one file per route family
  cache/                         — CacheTier, TieredCache, tiers, pipeline
  upstreams/                     — one UpstreamFetcher per upstream
  security/                      — origin allowlist, CORS, headers, rate-limit, URL validator, query filter
  observability/                 — trace, log, analytics, error-envelope
  kv/                            — prefix constants, MemberProfile type, name-index helpers
```

Full tree in FR-42. Full contract — what each module imports, what each exports, what's forbidden to cross-call — is in FR-42 AC-42.9.

## Alternatives considered

**Leave lib.ts alone; only add new modules for new work.** Rejected. This is what produced the god module in the first place. Every new feature would land next to the existing pile, and the test file would grow proportionally. We need a one-time break.

**Functional decomposition (pure functions, no classes).** Considered. Pure functions work for leaf utilities (URL validation, key canonicalization, search ranking — these stay functions). But for anything with collaborators (tiered cache, route handlers, rate-limit gate), constructor injection is more readable in TypeScript than threading 5-8 parameters through every call. TypeScript has first-class class support and the test story is cleaner: `new RouteHandler(fakeCache, fakeLogger)` is trivially swappable.

**Break proxy/lib.ts by route only (keep cache code inline).** Rejected. That doesn't solve the caching duplication problem. The whole point of ADR-014's tiered cache is to have one cache layer — that requires the cache code to be its own module tree, not embedded per-route.

**Port to Hono or itty-router.** Rejected. Adds a dependency for marginal benefit; the router we need is ~40 lines of our own code with exactly the dispatch semantics FR-42 AC-42.4 needs. NFR-5 (no runtime deps beyond React/Vite/Vitest) stands.

**Auto-generate route handlers from an OpenAPI spec.** Rejected for this iteration. Worth revisiting once the refactor is done and the routes are stable; doing it during the refactor would couple two experiments.

## Consequences

### Positive

- Each module is testable in isolation with fakes. No more `worker.test.ts` integration-shaped unit tests.
- New features land in small files touching known code paths.
- The tiered cache (ADR-014) drops in cleanly because its seams already exist.
- TypeScript's module system catches circular imports early (`tsc --noEmit` + `madge --circular`).
- Test suite splits to match the module tree — easier to navigate, faster to run per-file during TDD.
- File-size cap is a forcing function for future composition.

### Negative / costs

- ~2 weeks of implementation time per the user's estimate.
- The atomic refactor touches every cache-related test. Every test that imports from `proxy/lib.ts` gets its import path updated; most also get behavioral rewrites to use the new fakes.
- One intermediate PR per phase makes review manageable but increases merge-conflict surface. Mitigation: do the refactor on a feature branch with rebase-only merges, and keep the branch short-lived.

### Migration approach (FR-42 AC-42.7)

1. Create the new module skeleton empty (stubs that re-export from `proxy/lib.ts`).
2. Move code module-by-module. Each move is a commit. Tests for the moved code are rewritten in the same commit to use the new fakes.
3. Every commit is green — full suite + typecheck + build.
4. Delete `proxy/lib.ts` when the last caller is migrated.
5. Split `tests/unit/worker.test.ts` by route family in parallel with route handler moves.

Order of moves (dependency-driven):
1. `security/*` and `observability/*` — leaf utilities, no collaborators.
2. `kv/*` — KV helpers (prefixes, profile type, name-index).
3. `cache/tier.ts` + `cache/tiered-cache.ts` — the interface and composition class.
4. `cache/edge-tier.ts`, `cache/kv-tier.ts` — concrete tiers for existing KV+edge paths.
5. `upstreams/*` — upstream fetchers for existing routes.
6. `cache/pipeline.ts` + `cache/r2-tier.ts` — `serveCached` + new R2 tier, both needing the above to be in place.
7. `routes/*` — each route handler migrates one at a time to use the new pipeline.
8. `router.ts` + `worker.ts` — thin final wiring.
9. Delete `proxy/lib.ts`.

### File-size enforcement

A lint rule (custom or via an ESLint plugin) enforces the 300-line cap going forward. Violating files fail CI. One-time exceptions require a comment citing an ADR.

## Related

- ADR-014 (tiered cache) is the architectural beneficiary.
- ADR-013 (observability) provides the injection pattern for logger + analytics clients.
- FR-42 is the acceptance-criteria encoding of this ADR.
