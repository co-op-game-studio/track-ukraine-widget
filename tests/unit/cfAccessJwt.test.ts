/**
 * Tests for proxy/security/cf-access-jwt.ts.
 * Traces to FR-50 AC-50.2.
 *
 * We mint a real RS256 key pair via WebCrypto, build a synthetic JWKS from
 * the public key, and produce real signed JWTs so the verifier exercises
 * its actual code path (not a mock signature).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  verifyCfAccessJwt,
  clearJwksMemoCache,
  type Jwks,
  type VerifyConfig,
} from '../../proxy/security/cf-access-jwt';

const TEAM = 'cogs';
const AUD = 'a'.repeat(64);
const ISS = `https://${TEAM}.cloudflareaccess.com`;
const KID = 'test-kid-1';

function uint8ToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function strToBase64Url(s: string): string {
  return uint8ToBase64Url(new TextEncoder().encode(s));
}

interface KeyPair {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}

async function makeKeyPair(): Promise<KeyPair> {
  const kp = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  return { privateKey: kp.privateKey, publicJwk };
}

interface MintArgs {
  kid?: string;
  alg?: string;
  iss?: string;
  aud?: string | string[];
  email?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
}

async function mintJwt(privateKey: CryptoKey, args: MintArgs = {}): Promise<string> {
  const header = { alg: args.alg ?? 'RS256', typ: 'JWT', kid: args.kid ?? KID };
  const nowSec = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    iss: args.iss ?? ISS,
    aud: args.aud ?? AUD,
    exp: args.exp ?? nowSec + 600,
    iat: args.iat ?? nowSec,
  };
  if (args.email !== undefined) payload.email = args.email;
  if (args.nbf !== undefined) payload.nbf = args.nbf;
  const headerB64 = strToBase64Url(JSON.stringify(header));
  const payloadB64 = strToBase64Url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sigBuf = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  const sigB64 = uint8ToBase64Url(new Uint8Array(sigBuf));
  return `${signingInput}.${sigB64}`;
}

let kp: KeyPair;
let jwks: Jwks;
let fetcher: typeof fetch;
let baseCfg: VerifyConfig;

beforeAll(async () => {
  kp = await makeKeyPair();
  jwks = {
    keys: [
      {
        kid: KID,
        kty: 'RSA',
        alg: 'RS256',
        use: 'sig',
        n: kp.publicJwk.n!,
        e: kp.publicJwk.e!,
      },
    ],
  };
  fetcher = (async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (u.includes(`${TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`)) {
      return new Response(JSON.stringify(jwks), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  baseCfg = { team: TEAM, aud: AUD, fetcher };
});

beforeEach(() => {
  clearJwksMemoCache();
});

describe('verifyCfAccessJwt (FR-50 AC-50.2)', () => {
  it('accepts a valid token signed by the team JWKS', async () => {
    const token = await mintJwt(kp.privateKey, { email: 'alice@example.com' });
    const result = await verifyCfAccessJwt(token, baseCfg);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.claims.email).toBe('alice@example.com');
    expect(result.claims.aud).toBe(AUD);
    expect(result.claims.iss).toBe(ISS);
  });

  it('rejects malformed tokens', async () => {
    const result = await verifyCfAccessJwt('not.a.jwt', baseCfg);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // bad_token_shape (3 parts but garbage payload) or bad_signature path.
    expect(['bad_token_shape', 'bad_signature', 'missing_kid', 'bad_alg']).toContain(
      result.reason,
    );
  });

  it('rejects a token whose signature was forged (different key)', async () => {
    const otherKp = await makeKeyPair();
    const forgedToken = await mintJwt(otherKp.privateKey, {
      email: 'mallory@evil.com',
      kid: KID,
    });
    const result = await verifyCfAccessJwt(forgedToken, baseCfg);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('bad_signature');
  });

  it('rejects a token with the wrong aud claim', async () => {
    const token = await mintJwt(kp.privateKey, { aud: 'b'.repeat(64) });
    const result = await verifyCfAccessJwt(token, baseCfg);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('bad_aud');
  });

  it('rejects a token with the wrong iss claim', async () => {
    const token = await mintJwt(kp.privateKey, {
      iss: 'https://attacker.cloudflareaccess.com',
    });
    const result = await verifyCfAccessJwt(token, baseCfg);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('bad_iss');
  });

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = await mintJwt(kp.privateKey, { exp: past, iat: past - 60 });
    const result = await verifyCfAccessJwt(token, baseCfg);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('expired');
  });

  it('rejects a token whose iat is far in the future (clock skew)', async () => {
    const future = Math.floor(Date.now() / 1000) + 7200;
    const token = await mintJwt(kp.privateKey, { iat: future, exp: future + 600 });
    const result = await verifyCfAccessJwt(token, baseCfg);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('not_yet_valid');
  });

  it('rejects a token signed with a kid not in the JWKS', async () => {
    const token = await mintJwt(kp.privateKey, { kid: 'unknown-kid' });
    const result = await verifyCfAccessJwt(token, baseCfg);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('unknown_kid');
  });

  it('rejects non-RS256 alg', async () => {
    const token = await mintJwt(kp.privateKey, { alg: 'HS256' });
    const result = await verifyCfAccessJwt(token, baseCfg);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(['bad_alg', 'bad_signature']).toContain(result.reason);
  });

  it('returns jwks_unavailable when JWKS endpoint fails', async () => {
    const token = await mintJwt(kp.privateKey, { email: 'a@x.com' });
    const failingFetcher = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    const result = await verifyCfAccessJwt(token, {
      team: TEAM,
      aud: AUD,
      fetcher: failingFetcher,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('jwks_unavailable');
  });

  it('accepts aud as an array containing the configured value', async () => {
    const token = await mintJwt(kp.privateKey, {
      aud: [AUD, 'other-app'],
      email: 'a@x.com',
    });
    const result = await verifyCfAccessJwt(token, baseCfg);
    expect(result.ok).toBe(true);
  });
});
