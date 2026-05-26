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

describe('handleFetch — query-param allowlist + canonical cache key (AC-27.20)', () => {
  it('drops unknown query params before forwarding to upstream (congress)', async () => {
    let capturedUrl = '';
    fakeUpstream = async (u) => {
      capturedUrl = u;
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    await handleFetch(
      new Request(
        'https://vote.cogs.it.com/api/congress/v3/member?limit=10&nonce=attacker&format=json&bogus=1',
        { headers: { Origin: 'https://trackukraine.com' } },
      ),
      makeEnv(),
      makeFakeCache(),
    );
    const u = new URL(capturedUrl);
    // Allowed params kept:
    expect(u.searchParams.get('limit')).toBe('10');
    expect(u.searchParams.get('format')).toBe('json');
    // Unknown params dropped:
    expect(u.searchParams.get('nonce')).toBeNull();
    expect(u.searchParams.get('bogus')).toBeNull();
  });

  it('drops unknown query params before forwarding to census', async () => {
    let capturedUrl = '';
    fakeUpstream = async (u) => {
      capturedUrl = u;
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    await handleFetch(
      new Request(
        'https://vote.cogs.it.com/api/census/geocoder/geographies/onelineaddress?address=x&benchmark=y&vintage=z&format=json&leak=abc',
        { headers: { Origin: 'https://trackukraine.com' } },
      ),
      makeEnv(),
      makeFakeCache(),
    );
    const u = new URL(capturedUrl);
    expect(u.searchParams.get('address')).toBe('x');
    expect(u.searchParams.get('benchmark')).toBe('y');
    expect(u.searchParams.get('leak')).toBeNull();
  });

  it('drops all query params on senate (none allowed)', async () => {
    let capturedUrl = '';
    fakeUpstream = async (u) => {
      capturedUrl = u;
      return new Response('<xml/>', { status: 200, headers: { 'Content-Type': 'application/xml' } });
    };
    await handleFetch(
      new Request(
        'https://vote.cogs.it.com/api/senate/legislative/LIS/roll_call_votes/x?nonce=1&junk=2',
        { headers: { Origin: 'https://trackukraine.com' } },
      ),
      makeEnv(),
      makeFakeCache(),
    );
    const u = new URL(capturedUrl);
    expect(u.searchParams.toString()).toBe('');
  });

  it('cache key ignores unknown params — nonce fuzz does NOT fragment the cache', async () => {
    let upstreamCalls = 0;
    fakeUpstream = async () => {
      upstreamCalls++;
      return new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const cache = makeFakeCache();
    const env = makeEnv();
    // Three requests that differ only in "nonce" — should all hit the same cache key.
    for (const nonce of ['1', '2', '3']) {
      await handleFetch(
        new Request(
          `https://vote.cogs.it.com/api/congress/v3/member?limit=10&nonce=${nonce}&format=json`,
          { headers: { Origin: 'https://trackukraine.com' } },
        ),
        env,
        cache,
      );
    }
    // First call is a miss; next two are cache hits.
    expect(upstreamCalls).toBe(1);
  });

  // AC-40.11: dual of the nonce-fuzz test above. Two census-geocoder requests
  // that differ in an ALLOWED param (`address`) MUST NOT share an edge cache
  // entry. Regression test for the 2026-05-25 prod incident on
  // trackukraine.com where the edge-tier keyToUrl adapter dropped
  // CacheKey.params, collapsing every address lookup onto one bucket per POP.
  // See ADR-019.
  it('cache key DOES fragment on allowed params — two distinct addresses each miss the edge tier', async () => {
    const upstreamCalls: string[] = [];
    fakeUpstream = async (u) => {
      const parsed = new URL(u);
      upstreamCalls.push(parsed.searchParams.get('address') ?? '');
      // Echo the submitted address back in the response so a hit would be
      // detectable here too (defense-in-depth assertion below).
      return new Response(
        JSON.stringify({ result: { input: { address: { address: parsed.searchParams.get('address') } } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const cache = makeFakeCache();
    const env = makeEnv();
    const addrA = '100 N Clark St, Chicago, IL 60602';
    const addrB = '1600 Pennsylvania Ave NW, Washington, DC 20500';
    const respA = await handleFetch(
      new Request(
        `https://vote.cogs.it.com/api/census/geocoder/geographies/onelineaddress?address=${encodeURIComponent(addrA)}&benchmark=Public_AR_Current&vintage=Current_Current&layers=54&format=json`,
        { headers: { Origin: 'https://trackukraine.com' } },
      ),
      env,
      cache,
    );
    const respB = await handleFetch(
      new Request(
        `https://vote.cogs.it.com/api/census/geocoder/geographies/onelineaddress?address=${encodeURIComponent(addrB)}&benchmark=Public_AR_Current&vintage=Current_Current&layers=54&format=json`,
        { headers: { Origin: 'https://trackukraine.com' } },
      ),
      env,
      cache,
    );
    // Two upstream fetches — one per distinct address.
    expect(upstreamCalls).toEqual([addrA, addrB]);
    // And the responses received by each caller must echo the address each
    // ACTUALLY requested — the smoking-gun symptom of the prod bug was the
    // second request receiving the first response.
    const bodyA = (await respA.json()) as { result: { input: { address: { address: string } } } };
    const bodyB = (await respB.json()) as { result: { input: { address: { address: string } } } };
    expect(bodyA.result.input.address.address).toBe(addrA);
    expect(bodyB.result.input.address.address).toBe(addrB);
  });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});
