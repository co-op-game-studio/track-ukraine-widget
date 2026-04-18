#!/usr/bin/env node
/**
 * Compute the Subresource Integrity (SRI) hash of the built widget bundle.
 *
 * Reads `dist/voter-info-widget.iife.js`, hashes it with SHA-384, and writes
 * the base64-encoded form to `dist/voter-info-widget.iife.js.sri` prefixed
 * with `sha384-` per the SRI spec.
 *
 * The output file is uploaded to R2 alongside the bundle by the deploy
 * workflow (AC-26.9, AC-26.11) so integrators can fetch the current hash at
 * `https://vote.cogs.it.com/voter-info-widget.iife.js.sri`.
 *
 * Traces to: spec.md FR-26 AC-26.9.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bundlePath = resolve(__dirname, '..', 'dist', 'voter-info-widget.iife.js');
const sriPath = bundlePath + '.sri';

if (!existsSync(bundlePath)) {
  console.error(
    `[build-sri] Bundle not found at ${bundlePath}. Run \`npm run build:lib\` first.`,
  );
  process.exit(1);
}

const bytes = readFileSync(bundlePath);
const digest = createHash('sha384').update(bytes).digest('base64');
const sri = `sha384-${digest}`;

writeFileSync(sriPath, sri + '\n', 'utf8');
console.log(`[build-sri] ${sri}`);
console.log(`[build-sri] wrote ${sriPath}`);
