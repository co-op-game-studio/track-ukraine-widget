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

describe('handleFetch — rate limit (AC-27.21, AC-27.22)', () => {
  /**
   * A rate-limiter binding stub. When the Worker invokes
   * `env.RATE_LIMITER.limit({ key })`, the stub returns success/failure
   * deterministically based on the per-key counter it tracks.
   */
  function makeRateLimiter(limit: number) {
    const counts = new Map<string, number>();
    return {
      async limit({ key }: { key: string }): Promise<{ success: boolean }> {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return { success: n <= limit };
      },
      reset() {
        counts.clear();
      },
    };
  }

  it('returns 429 with Retry-After when the limiter rejects and does NOT call upstream (AC-27.21, AC-27.22)', async () => {
    const rl = makeRateLimiter(0); // reject every request
    let upstreamCalls = 0;
    fakeUpstream = async () => {
      upstreamCalls++;
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = makeEnv({ RATE_LIMITER: rl as any });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/member/A000360', {
        headers: {
          Origin: 'https://trackukraine.com',
          'CF-Connecting-IP': '203.0.113.7',
        },
      }),
      env,
      makeFakeCache(),
    );
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBeTruthy();
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    const body = await r.json();
    expect(body.error).toBe('rate_limited');
    // AC-27.22 is about *upstream quota* protection: a 429 MUST NOT burn
    // a Congress.gov call. This was the gap flagged in the PR review —
    // the original test only asserted the response status.
    expect(upstreamCalls).toBe(0);
  });

  it('does not consume the rate-limit budget for a missing-Origin request (AC-27.22)', async () => {
    const rl = makeRateLimiter(1);
    let seen = 0;
    const wrap = {
      async limit(arg: { key: string }) {
        seen++;
        return rl.limit(arg);
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = makeEnv({ RATE_LIMITER: wrap as any });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/member/A000360'),
      env,
      makeFakeCache(),
    );
    // 403 from the origin guard
    expect(r.status).toBe(403);
    // Budget untouched — the limiter must not have been called.
    expect(seen).toBe(0);
  });

  it('does not consume the rate-limit budget for an unknown /api/<foo> route (AC-27.22)', async () => {
    let seen = 0;
    const rl = {
      async limit({ key: _k }: { key: string }) {
        seen++;
        return { success: true };
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = makeEnv({ RATE_LIMITER: rl as any });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/bogus/x', {
        headers: {
          Origin: 'https://trackukraine.com',
          'CF-Connecting-IP': '203.0.113.8',
        },
      }),
      env,
      makeFakeCache(),
    );
    expect(r.status).toBe(404);
    expect(seen).toBe(0);
  });

  it('does consume the rate-limit budget for a valid allowed-origin GET (AC-27.21)', async () => {
    const rl = makeRateLimiter(100);
    let seen = 0;
    const wrap = {
      async limit(arg: { key: string }) {
        seen++;
        return rl.limit(arg);
      },
    };
    fakeUpstream = async () =>
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = makeEnv({ RATE_LIMITER: wrap as any });
    await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/member/A000360', {
        headers: {
          Origin: 'https://trackukraine.com',
          'CF-Connecting-IP': '203.0.113.9',
        },
      }),
      env,
      makeFakeCache(),
    );
    expect(seen).toBe(1);
  });

  it('is fail-open when RATE_LIMITER binding is absent (tests/local without the binding)', async () => {
    // If no binding is present, the Worker must still serve requests — otherwise
    // local `vitest` runs and any future consumer that hasn't wired the binding
    // would break. The zone-level limit still applies in prod regardless.
    fakeUpstream = async () =>
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/member/A000360', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(), // RATE_LIMITER not set
      makeFakeCache(),
    );
    expect(r.status).toBe(200);
  });
});

describe('handleFetch — rate limit covers KV routes (AC-27.21 follow-up)', () => {
  function makeCountingRateLimiter(limit: number) {
    let seen = 0;
    return {
      limiter: {
        async limit({ key: _k }: { key: string }): Promise<{ success: boolean }> {
          seen++;
          return { success: seen <= limit };
        },
      },
      calls: () => seen,
    };
  }

  it('rate-limits /api/members/{id} (reject → 429, no upstream call)', async () => {
    const { limiter } = makeCountingRateLimiter(0);
    let upstreamCalls = 0;
    fakeUpstream = async () => {
      upstreamCalls++;
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = makeEnv({ RATE_LIMITER: limiter as any });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/members/A000360', {
        headers: {
          Origin: 'https://trackukraine.com',
          'CF-Connecting-IP': '203.0.113.10',
        },
      }),
      env,
      makeFakeCache(),
    );
    expect(r.status).toBe(429);
    expect(upstreamCalls).toBe(0);
  });

  it('rate-limits /api/bills/{id}', async () => {
    const { limiter } = makeCountingRateLimiter(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = makeEnv({ RATE_LIMITER: limiter as any });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/bills/119:hr:1', {
        headers: {
          Origin: 'https://trackukraine.com',
          'CF-Connecting-IP': '203.0.113.11',
        },
      }),
      env,
      makeFakeCache(),
    );
    expect(r.status).toBe(429);
  });

  it('rate-limits /api/roll-calls/{key}', async () => {
    const { limiter } = makeCountingRateLimiter(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = makeEnv({ RATE_LIMITER: limiter as any });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/roll-calls/119/h/1/42', {
        headers: {
          Origin: 'https://trackukraine.com',
          'CF-Connecting-IP': '203.0.113.12',
        },
      }),
      env,
      makeFakeCache(),
    );
    expect(r.status).toBe(429);
  });

  it('rate-limits /api/name-search', async () => {
    const { limiter } = makeCountingRateLimiter(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = makeEnv({ RATE_LIMITER: limiter as any });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/name-search?q=smith', {
        headers: {
          Origin: 'https://trackukraine.com',
          'CF-Connecting-IP': '203.0.113.13',
        },
      }),
      env,
      makeFakeCache(),
    );
    expect(r.status).toBe(429);
  });

  it('does NOT rate-limit cheap rejection on KV routes (bad origin → 403, budget untouched)', async () => {
    const { limiter, calls } = makeCountingRateLimiter(100);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = makeEnv({ RATE_LIMITER: limiter as any });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/members/A000360', {
        headers: { Origin: 'https://evil.example.com', 'CF-Connecting-IP': '203.0.113.14' },
      }),
      env,
      makeFakeCache(),
    );
    expect(r.status).toBe(403);
    expect(calls()).toBe(0);
  });
});

describe('handleFetch — prod hard-block when CF-Connecting-IP is absent (AC-27.21 defense)', () => {
  it('returns 429 no_client_ip when ENV_NAME=prod and CF-Connecting-IP missing', async () => {
    let upstreamCalls = 0;
    fakeUpstream = async () => {
      upstreamCalls++;
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const rl = {
      async limit({ key: _k }: { key: string }) {
        return { success: true };
      },
    };
    const env = makeEnv({
      ENV_NAME: 'prod',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      RATE_LIMITER: rl as any,
    });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/member/A000360', {
        headers: { Origin: 'https://trackukraine.com' }, // no CF-Connecting-IP
      }),
      env,
      makeFakeCache(),
    );
    expect(r.status).toBe(429);
    const body = await r.json();
    expect(body.reason).toBe('no_client_ip');
    expect(upstreamCalls).toBe(0);
  });

  it('falls back to path-keyed bucket on non-prod when CF-Connecting-IP missing', async () => {
    fakeUpstream = async () =>
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    const rl = {
      async limit({ key: _k }: { key: string }) {
        return { success: true };
      },
    };
    const env = makeEnv({
      ENV_NAME: 'dev',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      RATE_LIMITER: rl as any,
    });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/member/A000360', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      env,
      makeFakeCache(),
    );
    // Non-prod: limiter succeeds, upstream is called.
    expect(r.status).toBe(200);
  });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});
