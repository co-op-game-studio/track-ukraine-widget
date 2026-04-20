#!/usr/bin/env node
/**
 * Derive a Cloudflare-safe preview slug from a branch name. Used by the
 * preview deploy workflow (FR-47 AC-47.1, AC-47.5).
 *
 * Rules (AC-47.5):
 *   - strip leading "preview/"
 *   - lowercase
 *   - replace anything not [a-z0-9-] with "-"
 *   - collapse runs of "-" to one "-" and trim leading/trailing "-"
 *   - max length 31 chars. Cloudflare Worker names cap at 63 chars;
 *     the fixed prefix "voter-info-widget-proxy-preview-" is 32 chars,
 *     leaving 31 for the slug itself. Enforced here so every derived
 *     resource name (including the worker, the longest prefixed one)
 *     fits.
 *   - reject reserved slugs (dev, uat, stg, prod, preview, empty)
 *   - reject reserved prefixes (vote-, trackukraine-)
 *
 * Exit codes:
 *   0 — slug valid, printed to stdout
 *   2 — input invalid (empty, reserved, exceeds length after normalization)
 *
 * CLI usage: `node scripts/preview-slug.mjs preview/foo` → "foo"
 *
 * Export: `deriveSlug(rawBranch)` — pure function for tests.
 */
const RESERVED_SLUGS = new Set(['', 'dev', 'uat', 'stg', 'prod', 'preview', 'main', 'develop']);
const RESERVED_PREFIXES = ['vote-', 'trackukraine-'];
const MAX_LEN = 31;

/** @param {string} raw */
export function deriveSlug(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'not-a-string' };
  }
  // Strip leading "preview/" (case-insensitive).
  const stripped = raw.replace(/^preview\//i, '');
  // Lowercase + replace junk + collapse + trim.
  const normalized = stripped
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!normalized) {
    return { ok: false, reason: 'empty-after-normalize' };
  }
  if (normalized.length > MAX_LEN) {
    return { ok: false, reason: `exceeds-max-length-${MAX_LEN}` };
  }
  if (RESERVED_SLUGS.has(normalized)) {
    return { ok: false, reason: `reserved-slug:${normalized}` };
  }
  for (const prefix of RESERVED_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return { ok: false, reason: `reserved-prefix:${prefix}` };
    }
  }
  return { ok: true, slug: normalized };
}

/** Names for Cloudflare resources a given preview slug produces. */
export function resourceNames(slug) {
  return {
    workerName: `voter-info-widget-proxy-preview-${slug}`,
    kvNamespace: `voter-info-widget-preview-${slug}`,
    r2Bucket: `voter-info-widget-archive-preview-${slug}`,
    analyticsDataset: `voter_info_widget_preview_${slug.replace(/-/g, '_')}`,
    envName: `preview-${slug}`,
  };
}

// CLI entry point when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv[2] ?? '';
  const result = deriveSlug(input);
  if (!result.ok) {
    console.error(`invalid preview slug from "${input}": ${result.reason}`);
    process.exit(2);
  }
  console.log(result.slug);
}
