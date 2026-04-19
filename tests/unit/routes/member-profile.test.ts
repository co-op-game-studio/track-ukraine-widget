import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  handleFetch,
  type ProxyEnv,
  type CacheLike,
} from '../../../proxy/lib';

// ─── Test harness ──────────────────────────────────────────────────────────

/** A Cache-compatible in-memory stub. Matches the shape used by handleFetch. */
function makeFakeCache(): CacheLike & { store: Map<string, Response> } {
  const store = new Map<string, Response>();
  return {
    store,
    async match(req: Request | string): Promise<Response | undefined> {
      const key = typeof req === 'string' ? req : req.url;
      const hit = store.get(key);
      return hit ? hit.clone() : undefined;
    },
    async put(req: Request | string, resp: Response): Promise<void> {
      const key = typeof req === 'string' ? req : req.url;
      store.set(key, resp);
    },
  };
}

/** A fake KV namespace with just the surface handleFetch touches. */
function makeFakeKV(store: Record<string, string> = {}): ProxyEnv['KV_VOTER_INFO'] {
  return {
    async get(key: string, _type?: 'text' | 'json'): Promise<string | null> {
      return store[key] ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      store[key] = value;
    },
    async list({ prefix }: { prefix: string }) {
      return {
        keys: Object.keys(store).filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
    async delete(key: string): Promise<void> {
      delete store[key];
    },
  };
}

/** Build a baseline prod env. Tests override fields as needed. */
function makeEnv(overrides: Partial<ProxyEnv> = {}): ProxyEnv {
  return {
    CONGRESS_API_KEY: 'SECRET-TEST-KEY',
    ALLOWED_ORIGINS: 'https://trackukraine.com,https://www.trackukraine.com',
    ALLOW_LOCALHOST: undefined,
    KV_VOTER_INFO: makeFakeKV(),
    ...overrides,
  };
}

/** A fake global fetch controlled per-test. */
let fakeUpstream: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fakeUpstream = null;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (fakeUpstream) return fakeUpstream(url.toString(), init);
    return new Response('no upstream handler installed', { status: 599 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
});

describe('handleFetch — buildProfileFromUpstream optional-leg timeout (AC-27.18 follow-up)', () => {
  // Fake upstream helper: returns different responses per URL substring.
  function routeFetch(map: Record<string, () => Promise<Response>>) {
    return async (u: string) => {
      for (const frag of Object.keys(map)) {
        if (u.includes(frag)) return map[frag]!();
      }
      return new Response('unrouted', { status: 599 });
    };
  }

  it('returns the profile (200) even when sponsored-legislation times out', async () => {
    fakeUpstream = routeFetch({
      // Detail — fast, OK.
      '/v3/member/A000360?': async () =>
        new Response(
          JSON.stringify({
            member: {
              bioguideId: 'A000360',
              firstName: 'First',
              lastName: 'Last',
              state: 'IL',
              partyHistory: [{ partyName: 'Democratic' }],
              terms: [],
              depiction: { imageUrl: 'https://bioguide-cloudfront.house.gov/photo.jpg' },
              officialWebsiteUrl: 'https://senate.gov/last',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      // Sponsored — simulate timeout (what AbortSignal.timeout throws).
      '/sponsored-legislation': async () => {
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
      // Cosponsored — OK-but-empty.
      '/cosponsored-legislation': async () =>
        new Response(JSON.stringify({ cosponsoredLegislation: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    const env = makeEnv();
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/members/A000360', {
        headers: { Origin: 'https://trackukraine.com', 'CF-Connecting-IP': '203.0.113.20' },
      }),
      env,
      makeFakeCache(),
    );
    expect(r.status).toBe(200);
    const body = await r.json() as { photoUrl?: string; website?: string; sponsored?: unknown[] };
    expect(body.photoUrl).toBe('https://bioguide-cloudfront.house.gov/photo.jpg');
    expect(body.website).toBe('https://senate.gov/last');
    expect(body.sponsored).toEqual([]); // timeout → empty, not failure
  });

  it('sanitizes photoUrl and website at Worker write-time (AC-31.1 defense-in-depth)', async () => {
    fakeUpstream = routeFetch({
      '/v3/member/A000360?': async () =>
        new Response(
          JSON.stringify({
            member: {
              bioguideId: 'A000360',
              firstName: 'A',
              lastName: 'B',
              state: 'IL',
              partyHistory: [{ partyName: 'Democratic' }],
              terms: [],
              // ATTACKER-controlled URLs — must be stripped to null.
              depiction: { imageUrl: 'javascript:alert(1)' },
              officialWebsiteUrl: 'data:text/html,<script>alert(1)</script>',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      '/sponsored-legislation': async () =>
        new Response(JSON.stringify({ sponsoredLegislation: [] }), { status: 200 }),
      '/cosponsored-legislation': async () =>
        new Response(JSON.stringify({ cosponsoredLegislation: [] }), { status: 200 }),
    });
    const env = makeEnv();
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/members/A000360', {
        headers: { Origin: 'https://trackukraine.com', 'CF-Connecting-IP': '203.0.113.21' },
      }),
      env,
      makeFakeCache(),
    );
    expect(r.status).toBe(200);
    const body = await r.json() as { photoUrl: string | null; website: string | null };
    expect(body.photoUrl).toBeNull();
    expect(body.website).toBeNull();
  });

  it('returns 504 upstream_timeout when the REQUIRED detail fetch times out (AC-27.18)', async () => {
    fakeUpstream = routeFetch({
      '/v3/member/A000360?': async () => {
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
      '/sponsored-legislation': async () =>
        new Response(JSON.stringify({ sponsoredLegislation: [] }), { status: 200 }),
      '/cosponsored-legislation': async () =>
        new Response(JSON.stringify({ cosponsoredLegislation: [] }), { status: 200 }),
    });
    const env = makeEnv();
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/members/A000360', {
        headers: { Origin: 'https://trackukraine.com', 'CF-Connecting-IP': '203.0.113.22' },
      }),
      env,
      makeFakeCache(),
    );
    expect(r.status).toBe(504);
    const body = await r.json() as { error: string };
    expect(body.error).toBe('upstream_timeout');
    expect(r.headers.get('Cache-Control')).toBe('no-store');
  });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});
