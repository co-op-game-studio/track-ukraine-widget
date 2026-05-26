/**
 * Trace ID generation for CLI runs.
 *
 * Same canonical format as the Worker (`tr_<16hex>`) so the same ID can flow
 * through audit_log rows, CI logs, and any future Worker correlation.
 *
 * Uses Web Crypto (globalThis.crypto) so this module is safe to import from
 * either the Node CLI or the Cloudflare Worker — Node 19+ exposes
 * `globalThis.crypto` natively, and Workers has had it from day one. Avoids
 * the `node:crypto` import that broke the dev Worker deploy at v4.1.0-rc2
 * (the Worker runtime can't load Node builtins).
 */

// Web Crypto is available in both Node 19+ (via `globalThis.crypto`) and
// in Cloudflare Workers. Type the access narrowly so we don't need
// @cloudflare/workers-types here (CLI lib has no Worker deps) or DOM lib.
interface CryptoLike {
  getRandomValues(array: Uint8Array): Uint8Array;
}

export function generateTraceId(): string {
  const c = (globalThis as unknown as { crypto: CryptoLike }).crypto;
  const bytes = new Uint8Array(8);
  c.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `tr_${hex}`;
}
