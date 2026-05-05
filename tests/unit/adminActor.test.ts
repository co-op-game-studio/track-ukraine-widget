/**
 * Tests for proxy/security/admin-actor.ts.
 * Traces to FR-50 AC-50.1, AC-50.2 (revised).
 *
 * The admin actor is the email read from a *verified* CF Access JWT.
 * The test mints real RS256 tokens against a synthetic JWKS so the full
 * verify-then-extract path runs.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  extractAdminActor,
  isAdminActor,
  ACCESS_JWT_HEADER,
  ACCESS_EMAIL_HEADER,
} from '../../proxy/security/admin-actor';
import { clearJwksMemoCache, type Jwks } from '../../proxy/security/cf-access-jwt';
import type { ProxyEnv } from '../../proxy/env';

const TEAM = 'cogs';
const AUD = 'a'.repeat(64);
const ISS = `https://${TEAM}.cloudflareaccess.com`;
const KID = 'admin-test-kid';

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

async function mintJwt(privateKey: CryptoKey, opts: { email?: string } = {}): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT', kid: KID };
  const nowSec = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    iss: ISS,
    aud: AUD,
    exp: nowSec + 600,
    iat: nowSec,
  };
  if (opts.email !== undefined) payload.email = opts.email;
  const headerB64 = strToBase64Url(JSON.stringify(header));
  const payloadB64 = strToBase64Url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sigBuf = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${uint8ToBase64Url(new Uint8Array(sigBuf))}`;
}

let kp: KeyPair;
let jwks: Jwks;

function fakeFetcher(): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (u.includes('cloudflareaccess.com/cdn-cgi/access/certs')) {
      return new Response(JSON.stringify(jwks), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

function makeEnv(overrides: Partial<ProxyEnv> = {}): ProxyEnv {
  return {
    CF_ACCESS_TEAM: TEAM,
    CF_ACCESS_AUD: AUD,
    ...overrides,
  } as unknown as ProxyEnv;
}

function makeReq(token: string | null, plainEmail?: string | null): Request {
  const headers = new Headers();
  if (token !== null) headers.set(ACCESS_JWT_HEADER, token);
  if (plainEmail !== undefined && plainEmail !== null) {
    headers.set(ACCESS_EMAIL_HEADER, plainEmail);
  }
  return new Request('https://worker.example/api/admin/whoami', { headers });
}

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
  // Patch global fetch for the verifier — admin-actor doesn't take a custom
  // fetcher (production reality), so we stub the global for these tests.
  globalThis.fetch = fakeFetcher();
});

beforeEach(() => {
  clearJwksMemoCache();
});

describe('extractAdminActor (FR-50 AC-50.2)', () => {
  it('returns the email from the verified JWT claims', async () => {
    const token = await mintJwt(kp.privateKey, { email: 'Alice@Example.com' });
    const result = await extractAdminActor(makeReq(token), makeEnv());
    expect(isAdminActor(result)).toBe(true);
    if (result instanceof Response) throw new Error('unreachable');
    expect(result.email).toBe('alice@example.com');
  });

  it('IGNORES the plain Cf-Access-Authenticated-User-Email header (defense against spoofing)', async () => {
    const token = await mintJwt(kp.privateKey, { email: 'alice@example.com' });
    // Attacker sets the plain header to a different identity, but the JWT
    // claim wins because the JWT is the source of truth.
    const result = await extractAdminActor(makeReq(token, 'mallory@evil.com'), makeEnv());
    if (result instanceof Response) throw new Error('unreachable');
    expect(result.email).toBe('alice@example.com');
  });

  it('fails 401 admin_jwt_required when the JWT header is absent', async () => {
    const result = await extractAdminActor(makeReq(null, 'alice@example.com'), makeEnv());
    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) throw new Error('unreachable');
    expect(result.status).toBe(401);
    const body = (await result.json()) as { error: string };
    expect(body.error).toBe('admin_jwt_required');
  });

  it('fails 401 admin_jwt_invalid for a forged token (signed by wrong key)', async () => {
    const otherKp = await makeKeyPair();
    const forged = await mintJwt(otherKp.privateKey, { email: 'mallory@evil.com' });
    const result = await extractAdminActor(makeReq(forged), makeEnv());
    if (!(result instanceof Response)) throw new Error('unreachable');
    expect(result.status).toBe(401);
    const body = (await result.json()) as { error: string; detail: string };
    expect(body.error).toBe('admin_jwt_invalid');
    expect(body.detail).toBe('bad_signature');
  });

  it('fails 500 admin_misconfigured when CF_ACCESS_TEAM/AUD are not set', async () => {
    const token = await mintJwt(kp.privateKey, { email: 'a@x.com' });
    const result = await extractAdminActor(
      makeReq(token),
      makeEnv({ CF_ACCESS_TEAM: undefined, CF_ACCESS_AUD: undefined }),
    );
    if (!(result instanceof Response)) throw new Error('unreachable');
    expect(result.status).toBe(500);
    const body = (await result.json()) as { error: string };
    expect(body.error).toBe('admin_misconfigured');
  });

  it('fails 500 admin_actor_missing when the verified JWT has no email claim', async () => {
    const token = await mintJwt(kp.privateKey, { email: undefined });
    const result = await extractAdminActor(makeReq(token), makeEnv());
    if (!(result instanceof Response)) throw new Error('unreachable');
    expect(result.status).toBe(500);
    const body = (await result.json()) as { error: string };
    expect(body.error).toBe('admin_actor_missing');
  });

  it('forwards extraHeaders into error responses', async () => {
    const result = await extractAdminActor(makeReq(null), makeEnv(), {
      'Access-Control-Allow-Origin': 'https://embed.example',
    });
    if (!(result instanceof Response)) throw new Error('unreachable');
    expect(result.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://embed.example',
    );
  });
});
