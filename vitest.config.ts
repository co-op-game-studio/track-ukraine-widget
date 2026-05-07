import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Vitest config.
 *
 * Coverage per FR-45 — every run carries the same `test.coverage` block so
 * `npm test`, `npm run test:coverage`, and the per-tier scripts share one
 * honest denominator.
 *
 * `include` = code we ship. `exclude` = code that has no runtime semantics
 * to cover (build tools, entry points, dev harness, type-only files).
 * Thresholds are floors per AC-45.2.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage/combined',
      reporter: ['text', 'json', 'json-summary', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}', 'proxy/**/*.{ts,tsx}'],
      exclude: [
        // Build-tool scripts: not under test by design.
        'scripts/**',
        // Entry points: bind widget to host DOM, no logic.
        'src/main.tsx',
        'src/embed.tsx',
        // Dev harness: EnvPicker only ships in dev server.
        'src/EnvPicker.tsx',
        // Type-only files: compile to nothing.
        'src/types/**',
        // Proxy type-only contracts: tier.ts and fetcher.ts declare
        // interfaces with no runtime code (verified: all implementations
        // live in sibling files — edge-tier.ts, kv-tier.ts, etc.).
        'proxy/cache/tier.ts',
        'proxy/upstreams/fetcher.ts',
        // Bindings-only shim: worker.ts wires caches.default + env
        // bindings to handleFetch. Every code path it contains is
        // exercised by handleFetch's own tests.
        'proxy/worker.ts',
        // Admin SPA mount points + type-only files (V4).
        'src/admin/main.tsx',         // ReactDOM.createRoot, no logic
        'src/admin/index.html',       // not even JS but glob is liberal
        'src/admin/types.ts',         // type-only, mirrors D1 row shapes
        // Help content components are pure JSX prose pages — exercised
        // visually, no behavioral logic to assert. Same posture as the
        // dev-only EnvPicker exception above.
        'src/admin/components/help/**',
        // Test support.
        'tests/**',
        // Generated artifacts.
        'dist/**',
        'node_modules/**',
        'coverage/**',
      ],
      thresholds: {
        // Reset 2026-05-04 after the v4 admin-SPA hotfix train landed several
        // large UI surfaces (PeopleTab, SocialFeedTab, TagsView, AddQuoteView,
        // etc.) without matching component tests. These are TSX-heavy admin
        // SPA screens that need component-level coverage written for them in
        // the next coverage push (tracked in MEMORY.md). The deep-pass on
        // 2026-05-04 raised pure-logic + route-handler coverage substantially
        // (ingest-store 100%, tags-store 99%, api-admin 81%, api-rep-bundle
        // 100%, freshness-cron 100%, social-poll-cron 100%, adapter-logger
        // 100%) but the admin-SPA TSX gap pulls the global denominator down.
        //
        // Floors set at achieved-minus-1 so we don't regress and so the gate
        // forces a deliberate update each time we move the floor up.
        // 2026-05-04 round 4: bumped after 6 admin-SPA-tab agents landed
        // (PeopleTab 96.26%, SocialFeedTab 76.66%, AddQuoteView 95.27%,
        // QuotesListView 96.71%, SettingsTab 100%, CurationTab 100%,
        // TagPicker → Tag.tsx 99.33%). Combined sits at ~92/86/85.
        // 2026-05-04 round 5: bumped after router/Bill-component/backend
        // agents landed (router 92.04%, api-quotes 100%/100%br, admin-store
        // 100%/93.72%br, useRepQuotes/useRepStatements 100%/100%br,
        // BillContextSections 97.69%, BillsTab 92.56%). Combined now
        // ~94/87/86. Floors at achieved-minus-2 to absorb v8/CI platform
        // jitter without losing the regression alarm.
        lines: 92,
        statements: 92,
        functions: 85,
        branches: 84,
      },
    },
  },
});
