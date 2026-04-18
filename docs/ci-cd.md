# CI/CD Specification
# Voter Information Widget

**Version**: 1.0.0
**Date**: 2026-04-16
**Status**: Specified (implementation deferred)

---

## 1. Overview

This document specifies the CI/CD pipeline for the Voter Information Widget. The pipeline covers linting, type checking, testing, building, and deployment. **Implementation is deferred** — this spec defines what to build when CI/CD is prioritized.

---

## 2. Pipeline Stages

### 2.1 Lint

**Trigger**: Every push, every PR
**Tool**: ESLint with TypeScript plugin
**Config**: `eslint.config.js` (flat config)
**Rules**: Extend `eslint:recommended`, `@typescript-eslint/recommended`, `react-hooks/recommended`
**Command**: `npm run lint`

### 2.2 Type Check

**Trigger**: Every push, every PR
**Tool**: TypeScript compiler (`tsc --noEmit`)
**Config**: `tsconfig.json` (strict mode)
**Command**: `npm run typecheck`

### 2.3 Test

**Trigger**: Every push, every PR
**Tool**: Vitest
**Coverage**: Minimum 80% line coverage for `src/services/` and `src/utils/`
**Command**: `npm test -- --coverage`

### 2.4 Build

**Trigger**: Every push to `main`, every PR
**Tool**: Vite
**Outputs**:
- `dist/voter-info-widget.iife.js` — embeddable widget bundle
- `dist/index.html` + assets — standalone page
**Verification**: Bundle size check — fail if gzipped IIFE exceeds 150KB
**Command**: `npm run build`

### 2.5 Deploy (Future)

**Trigger**: Push to `main` (after all checks pass)
**Targets**:
- Widget bundle → CDN (e.g., Cloudflare R2, S3 + CloudFront)
- CORS proxy → Cloudflare Workers (`wrangler deploy`)
- Standalone page → Static hosting (Cloudflare Pages, Vercel, Netlify)

---

## 3. GitHub Actions Workflow (Specification)

```yaml
# .github/workflows/ci.yml — TO BE IMPLEMENTED
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint-and-typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npm test -- --coverage
      # Upload coverage report as artifact

  build:
    runs-on: ubuntu-latest
    needs: [lint-and-typecheck, test]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npm run build
      # Check bundle size
      - name: Check bundle size
        run: |
          SIZE=$(gzip -c dist/voter-info-widget.iife.js | wc -c)
          echo "Bundle size: $SIZE bytes (gzipped)"
          # Threshold from spec.md NFR-4: 200KB gzipped
          if [ $SIZE -gt 204800 ]; then
            echo "ERROR: Bundle exceeds 200KB gzipped limit (see spec.md NFR-4)"
            exit 1
          fi
      # Upload dist/ as artifact
```

---

## 4. Environment Variables

| Variable | Used In | Description |
|----------|---------|-------------|
| `VITE_CONGRESS_API_KEY` | Dev build | Congress.gov API key (dev only — prod uses proxy) |
| `CONGRESS_API_KEY` | CF Worker | Congress.gov API key for proxy injection |

Census geocoder requires no authentication.

**CI secrets**: API keys are NOT needed in CI — tests use mocked API responses. Keys should NOT be stored in CI environment variables unless integration tests are added later.

---

## 5. Branch Strategy

- `main`: Trunk — source of truth. Protected branch: requires PR, 1 review,
  passing `lint-typecheck-test` check, no force-push, no deletion. Not a
  deploy target; pushing to `main` runs `pr.yml` only.
- Deploy ladder: `develop → uat → stg → prod`. Each branch maps 1:1 to an
  environment. Push to any rung triggers `.github/workflows/deploy.yml` for
  that env. Promotion direction is top-to-bottom — `ladder-guard.yml`
  enforces that PRs into `develop/uat/stg/prod` come from the preceding
  rung (or `hotfix/*`).
- Feature branches: `feature/{description}` — develop and test before PR
  into `main`.
- Hotfix branches: `hotfix/{description}` — can PR directly into any rung
  (including `prod`) to bypass the ladder; still require review via branch
  protection.
- Release tags: `v{major}.{minor}.{patch}` — cut from `prod` after a clean
  deploy.

---

## 6. npm Scripts (Required)

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint src/ tests/",
    "typecheck": "tsc --noEmit"
  }
}
```

---

## 7. Implementation Checklist

When CI/CD implementation is prioritized:

- [ ] Add ESLint config (`eslint.config.js`)
- [ ] Add `.github/workflows/ci.yml`
- [ ] Configure branch protection rules on `main`
- [ ] Set up CDN deployment for widget bundle
- [ ] Set up Cloudflare Worker deployment with `wrangler.toml`
- [ ] Add bundle size monitoring (track over time)
- [ ] Add coverage thresholds to Vitest config
- [ ] Add scheduled job (weekly) that runs `node scripts/extract-openapi.mjs` and opens a PR if the spec changed

## 8. Vendored Spec Refresh

The Congress.gov OpenAPI spec at `docs/congress-api-openapi.json` is vendored from their live Swagger UI page. When the spec changes:

1. Run `node scripts/extract-openapi.mjs`
2. `git diff docs/congress-api-openapi.json`
3. If endpoints we use changed, update `docs/api-contracts.md` §2 and `src/types/api.ts`
4. Add/update tests
5. Commit both the spec refresh and the downstream changes together

A scheduled CI job should do this automatically and open a PR when the spec changes.
