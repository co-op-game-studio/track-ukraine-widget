/**
 * FR-45 AC-45.5 — coverage thresholds are present in vitest.config.ts.
 *
 * Self-documenting guardrail: if a future edit drops or relaxes the
 * thresholds in the config file, this test fails. Tests the declaration
 * surface via text-match rather than import because vitest's own config
 * is not itself instrumented.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CONFIG = readFileSync(
  resolve(process.cwd(), 'vitest.config.ts'),
  'utf8',
);

describe('FR-45 AC-45.5 — coverage thresholds declared in vitest.config.ts', () => {
  it('declares provider "v8"', () => {
    expect(CONFIG).toMatch(/provider:\s*['"]v8['"]/);
  });

  it('declares a thresholds block with floor values per AC-45.2 (raised 2026-04-19)', () => {
    expect(CONFIG).toMatch(/thresholds:\s*\{/);
    // Floors (post-raise): lines 95, stmts 95 (real-path coverage);
    // functions 93, branches 88 (accept v8's defensive-fallback + inline-
    // callback counting quirks).
    expect(CONFIG).toMatch(/lines:\s*95\b/);
    expect(CONFIG).toMatch(/statements:\s*95\b/);
    expect(CONFIG).toMatch(/functions:\s*93\b/);
    expect(CONFIG).toMatch(/branches:\s*88\b/);
  });

  it('includes both src/** and proxy/** in the coverage include list', () => {
    expect(CONFIG).toMatch(/['"]src\/\*\*\/\*\.\{ts,tsx\}['"]/);
    expect(CONFIG).toMatch(/['"]proxy\/\*\*\/\*\.\{ts,tsx\}['"]/);
  });

  it('excludes build-tool scripts, entry points, and type-only files per AC-45.1', () => {
    expect(CONFIG).toMatch(/['"]scripts\/\*\*['"]/);
    expect(CONFIG).toMatch(/['"]src\/main\.tsx['"]/);
    expect(CONFIG).toMatch(/['"]src\/embed\.tsx['"]/);
    expect(CONFIG).toMatch(/['"]src\/EnvPicker\.tsx['"]/);
    expect(CONFIG).toMatch(/['"]src\/types\/\*\*['"]/);
  });

  it('emits at least the json-summary and html reporters', () => {
    expect(CONFIG).toMatch(/['"]json-summary['"]/);
    expect(CONFIG).toMatch(/['"]html['"]/);
  });
});
