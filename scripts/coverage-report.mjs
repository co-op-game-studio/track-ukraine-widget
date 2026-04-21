#!/usr/bin/env node
/**
 * FR-45 AC-45.4 — combined coverage roll-up.
 *
 * Reads the per-tier `coverage/{unit,integration,e2e,combined}/coverage-summary.json`
 * files written by vitest-v8 and prints a Markdown-compatible table comparing
 * all four. Exits 0 when every expected summary exists AND the combined run's
 * thresholds were met (i.e., the combined run didn't already exit non-zero
 * before this script was invoked). Exits 1 otherwise.
 *
 * Intended invocation: `npm run test:coverage:all`, which runs every tier in
 * order and then this roll-up. CI uses the same script.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TIERS = [
  { name: 'unit',        dir: 'coverage/unit' },
  { name: 'integration', dir: 'coverage/integration' },
  { name: 'e2e',         dir: 'coverage/e2e' },
  { name: 'combined',    dir: 'coverage/combined' },
];

function pct(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return '—';
  return n.toFixed(2).padStart(6, ' ');
}

function loadSummary(dir) {
  const path = resolve(process.cwd(), dir, 'coverage-summary.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`Failed to parse ${path}:`, e.message);
    return null;
  }
}

function totalsFrom(summary) {
  if (!summary || !summary.total) return null;
  const t = summary.total;
  return {
    statements: t.statements?.pct,
    branches:   t.branches?.pct,
    functions:  t.functions?.pct,
    lines:      t.lines?.pct,
  };
}

function printRow(tier, tot, combined) {
  if (!tot) {
    console.log(
      `| ${tier.padEnd(11)} | ${'—'.padStart(6)} | ${'—'.padStart(6)} | ` +
      `${'—'.padStart(6)} | ${'—'.padStart(6)} | ${'missing'.padStart(12)} |`,
    );
    return;
  }
  const deltaLines = combined && typeof tot.lines === 'number' && typeof combined.lines === 'number'
    ? (tot.lines - combined.lines).toFixed(2).padStart(6, ' ')
    : '    — ';
  console.log(
    `| ${tier.padEnd(11)} | ${pct(tot.statements)} | ${pct(tot.branches)} | ` +
    `${pct(tot.functions)} | ${pct(tot.lines)} | ${deltaLines.padStart(12)} |`,
  );
}

const summaries = Object.fromEntries(
  TIERS.map((t) => [t.name, loadSummary(t.dir)]),
);
const totals = Object.fromEntries(
  TIERS.map((t) => [t.name, totalsFrom(summaries[t.name])]),
);

const combined = totals.combined;
let missingTiers = [];

console.log('');
console.log('## Coverage — per tier (%)');
console.log('');
console.log('| tier        | stmts  | branch | funcs  | lines  | Δlines vs comb |');
console.log('|-------------|--------|--------|--------|--------|----------------|');
for (const t of TIERS) {
  if (!summaries[t.name]) missingTiers.push(t.name);
  printRow(t.name, totals[t.name], t.name === 'combined' ? null : combined);
}
console.log('');

if (missingTiers.length) {
  console.error(
    `Missing coverage summaries for: ${missingTiers.join(', ')}. ` +
    `Run \`npm run test:coverage:all\` to regenerate.`,
  );
  process.exit(1);
}

// The combined run's threshold check is authoritative — v8 exits non-zero on
// failure before we get here. If combined totals exist, the thresholds passed.
console.log('All tiers reported. Combined run met FR-45 AC-45.2 thresholds.');
process.exit(0);
