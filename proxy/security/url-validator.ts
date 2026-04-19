/**
 * Upstream path / URL validation.
 *
 * Owns the real implementations as of Phase 12 T-071 (2026-04-19).
 * `proxy/lib.ts` re-exports from here for legacy import paths.
 *
 * Traces: FR-42 AC-42.1, AC-42.2. AC-27.7, AC-27.20, AC-31.1.
 */
import type { ApiRouteRule } from '../env';

/**
 * Is the upstream-path (the portion after the route prefix) structurally safe?
 *
 * Rejects `..`, `//`, `@`, any raw control character, any DEL (`\x7f`), and
 * any percent-encoded control byte (`%00`-`%1f`, `%7f`, case-insensitive).
 * See AC-27.7. The last check is critical — `URL.pathname` preserves percent-
 * encoded bytes, so an attacker-supplied `%0d%0a` survives parsing and would
 * be forwarded to upstream verbatim if we only checked decoded bytes.
 *
 * The URL constructor in handleFetch also normalizes away `..` segments
 * before they reach this check, but keeping the `..` rejection here makes
 * the guarantee local and defends any future code path that bypasses URL
 * parsing.
 */
export function isValidUpstreamPath(path: string): boolean {
  if (path.includes('..')) return false;
  if (path.includes('//')) return false;
  if (path.includes('@')) return false;
  // Raw control characters (including CR, LF, null, DEL).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path)) return false;
  // Percent-encoded control bytes: %00-%1f and %7f in any hex case.
  if (/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(path)) return false;
  return true;
}

/**
 * Build the upstream URL for an API route (AC-27.20).
 *
 * The client's query-string is filtered against the route's allowlist,
 * `api_key` is always stripped (AC-25.10 — set explicitly if the route
 * needs it), and the remaining params are serialized in sorted order so
 * the cache key is a function of meaningful inputs only. An attacker
 * cannot fragment the cache by walking `&nonce=1..N`, because `nonce`
 * is dropped before cache-key derivation.
 */
export function buildUpstreamUrl(
  route: ApiRouteRule,
  upstreamPath: string,
  clientParams: URLSearchParams,
): URL {
  const u = new URL(`${route.target}/${upstreamPath}`);
  const canonical = new URLSearchParams();
  const allowed = new Set(route.allowedQueryParams);
  const names = new Set<string>();
  for (const name of clientParams.keys()) names.add(name);
  for (const name of [...names].sort()) {
    if (name === 'api_key') continue; // AC-25.10
    if (!allowed.has(name)) continue; // AC-27.20
    for (const v of clientParams.getAll(name)) canonical.append(name, v);
  }
  u.search = canonical.toString();
  return u;
}

/**
 * Lightweight URL sanitizer for Worker code — mirrors `src/utils/sanitizeUrl`
 * but lives here so the Worker doesn't import from `src/`. Returns the
 * input verbatim if it parses as http(s); returns null otherwise.
 *
 * AC-31.1 defense-in-depth at the Worker write path: KV records persist
 * what upstream Congress.gov returns; if upstream is ever compromised or
 * misdata lands, we still want the stored field to be safe.
 */
export function sanitizeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (typeof value !== 'string') return null;
  if (value !== value.trim() || value === '') return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return value;
  } catch {
    return null;
  }
}
