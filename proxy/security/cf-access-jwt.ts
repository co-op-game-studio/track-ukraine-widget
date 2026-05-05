/**
 * Cloudflare Access JWT verifier (FR-50 AC-50.2).
 *
 * Cloudflare Access mints an RS256-signed JWT for every authenticated
 * request and includes it as `Cf-Access-Jwt-Assertion`. The token's
 * `iss` is `https://<team>.cloudflareaccess.com`; the `aud` is the
 * Application AUD tag (a 64-hex-char identifier set per Access app);
 * the `email` claim carries the authenticated user.
 *
 * This module verifies:
 *   1. JWS RS256 signature against the team's JWKS
 *   2. `aud` matches CF_ACCESS_AUD
 *   3. `iss` matches `https://<CF_ACCESS_TEAM>.cloudflareaccess.com`
 *   4. `exp` in the future (with a small clock-skew tolerance)
 *   5. `iat` not in the future
 *
 * The JWKS is cached in KV under `cache:v1:cf-access-jwks` for 1 hour
 * (the JWT verifier is the only writer to this specific cache key, an
 * exemption to AC-32.5's curator-only rule scoped narrowly).
 *
 * Traces to FR-50 AC-50.1, AC-50.2, ADR-017.
 */
import type { KVLike } from '../env';

export const ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion';
const JWKS_CACHE_KEY = 'cache:v1:cf-access-jwks';
const JWKS_CACHE_TTL_SECONDS = 3600;
const CLOCK_SKEW_SECONDS = 60;

/** Minimal JWKS shape used by Cloudflare Access. */
export interface JsonWebKey {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n: string;
  e: string;
}
export interface Jwks {
  keys: JsonWebKey[];
}

export interface CfAccessClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nbf?: number;
  email?: string;
  /** Service tokens use `common_name` instead of `email`. */
  common_name?: string;
  identity_nonce?: string;
  sub?: string;
}

export type VerifyResult =
  | { ok: true; claims: CfAccessClaims }
  | { ok: false; reason: string };

export interface VerifyConfig {
  team: string;
  aud: string;
  /** Optional KV for JWKS caching. Verification works without it; just slower
   *  (one extra fetch per request when keys aren't memoized in module scope). */
  kv?: KVLike;
  /** Override `Date.now()`-derived clock for tests. */
  now?: () => number;
  /** Override `fetch` for tests. */
  fetcher?: typeof fetch;
}

/* -------------------------------------------------------------------------- */
/*                              Base64URL helpers                             */
/* -------------------------------------------------------------------------- */

function base64UrlToUint8Array(s: string): Uint8Array {
  // Convert base64url → base64 → bytes.
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad === 2) b64 += '==';
  else if (pad === 3) b64 += '=';
  else if (pad !== 0) throw new Error('invalid_base64url_padding');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJsonSegment<T>(segment: string): T {
  const bytes = base64UrlToUint8Array(segment);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as T;
}

/* -------------------------------------------------------------------------- */
/*                                  JWKS fetch                                */
/* -------------------------------------------------------------------------- */

let jwksMemoCache: { jwks: Jwks; fetchedAt: number; team: string } | null = null;

export function clearJwksMemoCache(): void {
  jwksMemoCache = null;
}

async function loadJwks(cfg: VerifyConfig): Promise<Jwks> {
  const now = (cfg.now ?? Date.now)();
  // Module-scope memo (per Worker isolate, lives until isolate is recycled).
  if (
    jwksMemoCache &&
    jwksMemoCache.team === cfg.team &&
    now - jwksMemoCache.fetchedAt < JWKS_CACHE_TTL_SECONDS * 1000
  ) {
    return jwksMemoCache.jwks;
  }
  // KV-cached.
  if (cfg.kv) {
    const cached = (await cfg.kv.get(JWKS_CACHE_KEY, 'json')) as
      | { jwks: Jwks; team: string; fetchedAt: number }
      | null;
    if (
      cached &&
      cached.team === cfg.team &&
      now - cached.fetchedAt < JWKS_CACHE_TTL_SECONDS * 1000
    ) {
      jwksMemoCache = { jwks: cached.jwks, fetchedAt: cached.fetchedAt, team: cfg.team };
      return cached.jwks;
    }
  }
  // Cold fetch.
  const url = `https://${cfg.team}.cloudflareaccess.com/cdn-cgi/access/certs`;
  const fetcher = cfg.fetcher ?? fetch;
  const resp = await fetcher(url);
  if (!resp.ok) throw new Error(`jwks_fetch_failed: ${resp.status}`);
  const jwks = (await resp.json()) as Jwks;
  if (!jwks || !Array.isArray(jwks.keys)) throw new Error('jwks_shape_invalid');
  jwksMemoCache = { jwks, fetchedAt: now, team: cfg.team };
  if (cfg.kv) {
    // Best-effort cache write — failure should not block verification.
    try {
      await cfg.kv.put(
        JWKS_CACHE_KEY,
        JSON.stringify({ jwks, team: cfg.team, fetchedAt: now }),
        { expirationTtl: JWKS_CACHE_TTL_SECONDS },
      );
    } catch {
      /* ignore */
    }
  }
  return jwks;
}

/* -------------------------------------------------------------------------- */
/*                              Signature verify                              */
/* -------------------------------------------------------------------------- */

async function importRsaKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: jwk.kty,
      n: jwk.n,
      e: jwk.e,
      alg: 'RS256',
      ext: true,
    },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

async function verifySignature(
  signingInput: string,
  signature: Uint8Array,
  jwk: JsonWebKey,
): Promise<boolean> {
  const key = await importRsaKey(jwk);
  const data = new TextEncoder().encode(signingInput);
  // crypto.subtle.verify accepts BufferSource — Uint8Array works directly.
  // Cast through ArrayBufferView to satisfy strict ArrayBuffer/ArrayBufferLike
  // overload checks in @cloudflare/workers-types.
  return crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    signature as unknown as ArrayBuffer,
    data as unknown as ArrayBuffer,
  );
}

/* -------------------------------------------------------------------------- */
/*                                Claim checks                                */
/* -------------------------------------------------------------------------- */

function audMatches(audClaim: string | string[], expected: string): boolean {
  if (typeof audClaim === 'string') return audClaim === expected;
  if (Array.isArray(audClaim)) return audClaim.includes(expected);
  return false;
}

/* -------------------------------------------------------------------------- */
/*                                  Public API                                */
/* -------------------------------------------------------------------------- */

/**
 * Verify a Cloudflare Access JWT.
 *
 * Returns `{ ok: true, claims }` if every check passes. Otherwise returns
 * `{ ok: false, reason }` with a short stable reason code suitable for
 * structured logs (`bad_token_shape`, `unknown_kid`, `bad_signature`,
 * `bad_aud`, `bad_iss`, `expired`, `not_yet_valid`, `jwks_unavailable`).
 */
export async function verifyCfAccessJwt(
  token: string,
  cfg: VerifyConfig,
): Promise<VerifyResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'bad_token_shape' };
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: { kid?: string; alg?: string };
  let claims: CfAccessClaims;
  try {
    header = decodeJsonSegment(headerB64);
    claims = decodeJsonSegment(payloadB64);
  } catch {
    return { ok: false, reason: 'bad_token_shape' };
  }
  if (header.alg !== 'RS256') return { ok: false, reason: 'bad_alg' };
  if (!header.kid) return { ok: false, reason: 'missing_kid' };

  let jwks: Jwks;
  try {
    jwks = await loadJwks(cfg);
  } catch {
    return { ok: false, reason: 'jwks_unavailable' };
  }
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: 'unknown_kid' };

  let signature: Uint8Array;
  try {
    signature = base64UrlToUint8Array(sigB64);
  } catch {
    return { ok: false, reason: 'bad_token_shape' };
  }
  const signingInput = `${headerB64}.${payloadB64}`;
  let sigOk = false;
  try {
    sigOk = await verifySignature(signingInput, signature, jwk);
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  if (!sigOk) return { ok: false, reason: 'bad_signature' };

  // Claim checks.
  if (!audMatches(claims.aud, cfg.aud)) return { ok: false, reason: 'bad_aud' };
  const expectedIss = `https://${cfg.team}.cloudflareaccess.com`;
  if (claims.iss !== expectedIss) return { ok: false, reason: 'bad_iss' };

  const nowMs = (cfg.now ?? Date.now)();
  const nowSec = Math.floor(nowMs / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < nowSec) {
    return { ok: false, reason: 'expired' };
  }
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_SECONDS > nowSec) {
    return { ok: false, reason: 'not_yet_valid' };
  }
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SECONDS > nowSec) {
    return { ok: false, reason: 'not_yet_valid' };
  }

  return { ok: true, claims };
}
