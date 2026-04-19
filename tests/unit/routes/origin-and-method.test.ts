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

describe('handleFetch — origin enforcement (AC-25.5, 25.7, 25.8, 25.9)', () => {
  const url =
    'https://vote.cogs.it.com/api/census/geocoder/geographies/onelineaddress?address=x&benchmark=y&vintage=z&format=json';

  it('returns 403 when origin header is missing (AC-25.5)', async () => {
    const env = makeEnv();
    const cache = makeFakeCache();
    const r = await handleFetch(new Request(url), env, cache);
    expect(r.status).toBe(403);
  });

  it('returns 403 for a non-whitelisted origin', async () => {
    const env = makeEnv();
    const cache = makeFakeCache();
    const r = await handleFetch(
      new Request(url, { headers: { Origin: 'https://evil.example.com' } }),
      env,
      cache,
    );
    expect(r.status).toBe(403);
  });

  it('returns 403 for a suffix-bypass origin (AC-25.7)', async () => {
    const env = makeEnv();
    const cache = makeFakeCache();
    const r = await handleFetch(
      new Request(url, { headers: { Origin: 'https://trackukraine.com.evil.example' } }),
      env,
      cache,
    );
    expect(r.status).toBe(403);
  });

  it('returns 403 for localhost origin in PROD (AC-25.9) — regression guard', async () => {
    const env = makeEnv({ ALLOW_LOCALHOST: undefined });
    const cache = makeFakeCache();
    const r = await handleFetch(
      new Request(url, { headers: { Origin: 'http://localhost:9999' } }),
      env,
      cache,
    );
    expect(r.status).toBe(403);
  });

  it('returns 403 for localhost origin when ALLOW_LOCALHOST is any value other than "true"', async () => {
    const cache = makeFakeCache();
    for (const v of ['false', '1', 'yes', 'TRUE', '']) {
      const r = await handleFetch(
        new Request(url, { headers: { Origin: 'http://localhost:9999' } }),
        makeEnv({ ALLOW_LOCALHOST: v }),
        cache,
      );
      expect(r.status, `for ALLOW_LOCALHOST=${JSON.stringify(v)}`).toBe(403);
    }
  });

  it('permits localhost origin only when ALLOW_LOCALHOST="true" (AC-25.9, dev env)', async () => {
    fakeUpstream = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    const env = makeEnv({ ALLOW_LOCALHOST: 'true' });
    const cache = makeFakeCache();
    const r = await handleFetch(
      new Request(url, { headers: { Origin: 'http://localhost:9999' } }),
      env,
      cache,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:9999');
  });

  it('reflects the matched whitelist entry back in Access-Control-Allow-Origin (AC-25.8)', async () => {
    fakeUpstream = async () =>
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    const env = makeEnv();
    const cache = makeFakeCache();
    const r = await handleFetch(
      new Request(url, { headers: { Origin: 'https://trackukraine.com' } }),
      env,
      cache,
    );
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('https://trackukraine.com');
    expect(r.headers.get('Vary')?.toLowerCase()).toContain('origin');
  });
});

describe('handleFetch — method handling (AC-27.9)', () => {
  const url = 'https://vote.cogs.it.com/api/census/geocoder/geographies/onelineaddress?address=x&benchmark=y&vintage=z&format=json';

  it('returns 405 with Allow: GET, HEAD, OPTIONS for POST on /api/*', async () => {
    const r = await handleFetch(
      new Request(url, {
        method: 'POST',
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(405);
    expect(r.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
  });

  it('returns 405 with Allow header for PUT', async () => {
    const r = await handleFetch(
      new Request(url, {
        method: 'PUT',
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(405);
    expect(r.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
  });

  it('returns 405 with Allow header for DELETE', async () => {
    const r = await handleFetch(
      new Request(url, {
        method: 'DELETE',
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(405);
    expect(r.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
  });

  it('HEAD /api/* returns 200 with headers but no body (AC-27.9)', async () => {
    fakeUpstream = async () =>
      new Response('{"result": "x"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    const r = await handleFetch(
      new Request(url, {
        method: 'HEAD',
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(200);
    // Body should be empty for HEAD
    const body = await r.text();
    expect(body).toBe('');
    // But status-carrying headers should be present
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('https://trackukraine.com');
    expect(r.headers.get('Strict-Transport-Security')).toBeTruthy();
  });

  it('returns 204 with CORS headers for OPTIONS preflight with allowed origin', async () => {
    const r = await handleFetch(
      new Request(url, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://trackukraine.com',
          'Access-Control-Request-Method': 'GET',
        },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(204);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('https://trackukraine.com');
  });

  it('returns 403 with Allow header for OPTIONS preflight with disallowed origin (AC-27.9)', async () => {
    const r = await handleFetch(
      new Request(url, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example.com',
          'Access-Control-Request-Method': 'GET',
        },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(403);
    expect(r.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
  });
});

describe('handleFetch — unknown /api/<route> handling (AC-27.13)', () => {
  it('GET /api/bogus/x returns 404 no_such_api_route, not 204 preflight-success', async () => {
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/bogus/x', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body.error).toBe('no_such_api_route');
  });

  it('OPTIONS /api/bogus/x preflight returns 404 not 204 (AC-27.13) — does NOT advertise unknown path as CORS-enabled', async () => {
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/bogus/x', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://trackukraine.com',
          'Access-Control-Request-Method': 'GET',
        },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(404);
    // Specifically NOT a 204 preflight-success
    expect(r.status).not.toBe(204);
  });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});
