/**
 * T-042 — Widget Upstream-Invariant Test.
 *
 * Per design.md §4.14 ("App-Data vs. Edge-Cache Boundary"): the widget
 * SHALL NOT call the upstream-proxy pass-through routes (`/api/congress/*`
 * other than census, `/api/senate/*`) in steady state. All widget-facing
 * data lives in KV-backed routes: `/api/members/{id}`, `/api/name-search`,
 * `/api/roll-call-rosters/...`, `/api/state-members/{state}`.
 *
 * The one allowed upstream-shaped path is `/api/census/geocoder/*` — the
 * address-to-district lookup, whose input space is unbounded and thus not
 * pre-populatable.
 *
 * This test FAILS until T-040 and T-041 land (widget cutover to KV rosters
 * and state-members). Each failure is an AIDD violation: widget source is
 * ahead of, or has drifted from, the spec contract.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const WIDGET_DIRS = [
  resolve(ROOT, 'src', 'services'),
  resolve(ROOT, 'src', 'hooks'),
  resolve(ROOT, 'src', 'components'),
];

/** Recursively enumerate *.ts / *.tsx files under `dir`. */
function enumerateTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...enumerateTsFiles(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Forbidden path regex — matches the upstream-pass-through paths the widget
 * must NOT call. We allow `/api/census/geocoder` explicitly and reject the
 * other upstreams.
 */
const FORBIDDEN_PATH_PATTERNS: { pattern: RegExp; reason: string }[] = [
  {
    // `/api/congress` in source is always followed by `/v3/...` at runtime;
    // the literal may be `/api/congress${path}` or `/api/congress/v3/...`.
    // Either form is a widget-facing upstream call and is forbidden.
    pattern: /\/api\/congress\b/,
    reason: 'Widget must not call /api/congress/* directly — use KV-backed /api/members/{id}, /api/roll-call-rosters/*, or /api/state-members/{state}.',
  },
  {
    pattern: /\/api\/senate\b/,
    reason: 'Widget must not call /api/senate/* directly — Senate rosters are served via /api/roll-call-rosters/senate/*.',
  },
];

/**
 * Files explicitly exempt from the invariant. These are files that legitimately
 * need to reference the forbidden paths (e.g., tests, scaffolding, or the
 * soon-to-be-deleted-by-T-041 congressApi.ts). Each exemption carries a
 * short note and (eventually) the task that will remove it.
 */
const EXEMPT_FILES: { path: string; reason: string }[] = [
  // `services/bundledRosters.ts` is a no-op facade (ADR-011) — it does not
  // fetch anything. Exempt just in case the file grows comment-only refs.
  // The real exemption driver is the full widget-cutover Phase 9.
];

function isExempt(file: string): boolean {
  const rel = file.replace(ROOT + '\\', '').replace(ROOT + '/', '').replace(/\\/g, '/');
  return EXEMPT_FILES.some((e) => e.path === rel);
}

describe('T-042 — widget source SHALL NOT call upstream pass-through routes', () => {
  const allFiles = WIDGET_DIRS.flatMap(enumerateTsFiles);

  for (const { pattern, reason } of FORBIDDEN_PATH_PATTERNS) {
    it(`no widget file references ${pattern.source} — ${reason}`, () => {
      const violations: { file: string; line: number; text: string }[] = [];
      for (const file of allFiles) {
        if (isExempt(file)) continue;
        const content = readFileSync(file, 'utf8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const text = lines[i] ?? '';
          // Skip comment lines (// ... or  * ...) — documentation / JSDoc
          // may legitimately mention the forbidden paths.
          const trimmed = text.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
          if (pattern.test(text)) {
            violations.push({ file: file.replace(ROOT + '\\', '').replace(ROOT + '/', ''), line: i + 1, text: trimmed.slice(0, 120) });
          }
        }
      }
      if (violations.length > 0) {
        const report = violations
          .map((v) => `  ${v.file}:${v.line}\n    ${v.text}`)
          .join('\n');
        throw new Error(
          `Widget upstream-invariant violation (${violations.length}):\n${report}\n\n${reason}`,
        );
      }
    });
  }

  it('the only allowed upstream-shaped path in widget source is /api/census/geocoder', () => {
    // Sanity check the other direction: widget files MAY reference
    // /api/census/geocoder (that's the address lookup). This test just
    // confirms the exemption is narrow and legible; it doesn't fail if the
    // path is absent.
    const censusCallers: string[] = [];
    for (const file of allFiles) {
      const content = readFileSync(file, 'utf8');
      if (/\/api\/census\/geocoder/.test(content)) {
        censusCallers.push(file.replace(ROOT + '\\', '').replace(ROOT + '/', ''));
      }
    }
    // At least one widget file SHALL call the census geocoder. If zero call
    // it, the address-lookup feature is gone.
    expect(censusCallers.length).toBeGreaterThanOrEqual(1);
  });
});
