# ADR-001: Framework and Tooling Choice

**Date**: 2026-04-16
**Status**: Accepted
**Deciders**: Project team

## Context

We need to choose a UI framework, build tool, and test framework for an embeddable voter information widget that must be:
- Distributable as a single JS file
- Embeddable on any website
- Portable — the client may change frameworks later
- Maintainable by developers with varying experience levels

## Decision

- **UI Framework**: React 19 with TypeScript
- **Build Tool**: Vite 6
- **Test Framework**: Vitest with React Testing Library

## Rationale

**React**: Most widely known frontend framework. The widget's stateful, component-based UI (tabs, pagination, loading states) maps naturally to React's model. If the client wants to port to another framework later, React's component boundaries provide clear conversion points.

**TypeScript**: Strict mode. The widget integrates with multiple external APIs with complex response shapes — type safety prevents a large class of integration bugs at compile time.

**Vite**: Native TypeScript/JSX support, fast HMR, built-in dev server proxy (critical for CORS during development), and library build mode (required for IIFE output). Alternative (Webpack) is heavier and slower for this use case.

**Vitest**: Zero-config with Vite. Jest-compatible API (easy onboarding). Same transform pipeline as the build — no separate Babel/ts-jest config needed.

## Alternatives Considered

| Alternative | Why Not |
|------------|---------|
| Preact | Smaller bundle but less ecosystem support; React's size is acceptable given shadow DOM isolation |
| Svelte | Smaller output but less familiar to most developers; harder to find contributors |
| Webpack | Slower dev server, more config overhead, no native proxy |
| Jest | Requires separate transform config for TypeScript + JSX; Vitest integrates natively with Vite |

## Consequences

- Developers need React + TypeScript knowledge
- Bundle size will be ~40-80KB (React) plus application code; must stay under 150KB gzipped total
- Vite's library mode dictates the embed build configuration
