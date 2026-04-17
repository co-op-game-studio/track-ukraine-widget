#!/usr/bin/env node
/**
 * Extract the Congress.gov OpenAPI spec from its Swagger UI page.
 * The spec is embedded as `var spec = {...};` in the root page HTML.
 *
 * Usage: node scripts/extract-openapi.mjs
 * Output: docs/congress-api-openapi.json
 */
import { writeFileSync } from 'node:fs';

const res = await fetch('https://api.congress.gov');
if (!res.ok) {
  console.error(`Failed to fetch page: HTTP ${res.status}`);
  process.exit(1);
}
const html = await res.text();

const marker = 'var spec = ';
const idx = html.indexOf(marker);
if (idx < 0) {
  console.error('Marker "var spec = " not found in page.');
  process.exit(1);
}

// Brace-balanced extraction
const start = idx + marker.length;
let depth = 0;
let end = -1;
let inString = false;
let escape = false;

for (let i = start; i < html.length; i++) {
  const ch = html[i];
  if (escape) {
    escape = false;
    continue;
  }
  if (ch === '\\') {
    escape = true;
    continue;
  }
  if (ch === '"') {
    inString = !inString;
    continue;
  }
  if (inString) continue;
  if (ch === '{') depth++;
  else if (ch === '}') {
    depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }
}

if (end < 0) {
  console.error('Could not find balanced end of spec object.');
  process.exit(1);
}

const jsonStr = html.slice(start, end + 1);
const spec = JSON.parse(jsonStr);

const outPath = 'docs/congress-api-openapi.json';
writeFileSync(outPath, JSON.stringify(spec, null, 2));

console.log(`Saved ${outPath}`);
console.log(`OpenAPI version: ${spec.openapi}`);
console.log(`API version: ${spec.info?.version}`);
console.log(`Paths: ${Object.keys(spec.paths || {}).length}`);
console.log(`Schemas: ${Object.keys(spec.components?.schemas || {}).length}`);
