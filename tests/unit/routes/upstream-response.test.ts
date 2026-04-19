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

describe('handleFetch — upstream error normalization (AC-27.5)', () => {
  it('normalizes a 500 upstream response to JSON envelope', async () => {
    fakeUpstream = async () =>
      new Response('<html><body>Internal Server Error</body></html>', {
        status: 500,
        headers: { 'Content-Type': 'text/html' },
      });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/member/X', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(500);
    expect(r.headers.get('Content-Type')).toMatch(/^application\/json/);
    const body = await r.json();
    expect(body).toEqual({ error: 'upstream_error', status: 500, upstream: 'congress' });
  });

  it('never leaks CONGRESS_API_KEY in an upstream error body', async () => {
    fakeUpstream = async () =>
      new Response('something SECRET-TEST-KEY something', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/x', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    const body = await r.text();
    expect(body).not.toContain('SECRET-TEST-KEY');
  });
});

describe('handleFetch — security header baseline (AC-27.1, 27.1a, 27.1b, 27.1c)', () => {
  const apiUrl =
    'https://vote.cogs.it.com/api/census/geocoder/geographies/onelineaddress?address=x&benchmark=y&vintage=z&format=json';

  function expectUniversalBaseline(r: Response) {
    expect(r.headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains; preload',
    );
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(r.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(r.headers.get('X-Frame-Options')).toBe('DENY');
    expect(r.headers.get('X-DNS-Prefetch-Control')).toBe('off');
    expect(r.headers.get('X-Permitted-Cross-Domain-Policies')).toBe('none');
    expect(r.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(r.headers.get('Origin-Agent-Cluster')).toBe('?1');
  }

  it('sets universal baseline on 200 /api/* response', async () => {
    fakeUpstream = async () =>
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    const r = await handleFetch(
      new Request(apiUrl, { headers: { Origin: 'https://trackukraine.com' } }),
      makeEnv(),
      makeFakeCache(),
    );
    expectUniversalBaseline(r);
    // API responses get CORP cross-origin so browsers can read them.
    expect(r.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
    // But NOT CSP/Permissions-Policy (non-document content).
    expect(r.headers.get('Content-Security-Policy')).toBeNull();
    expect(r.headers.get('Permissions-Policy')).toBeNull();
  });

  it('sets universal baseline + CSP + Permissions-Policy on 403 Worker-emitted response (AC-27.1a)', async () => {
    const r = await handleFetch(
      new Request(apiUrl, { headers: { Origin: 'https://evil.example.com' } }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(403);
    expectUniversalBaseline(r);
    expect(r.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(r.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(r.headers.get('Permissions-Policy')).toContain('geolocation=()');
    expect(r.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(r.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sets universal baseline on KV-backed /api/members response', async () => {
    const env = makeEnv({
      KV_VOTER_INFO: makeFakeKV({
        'member:v1:D000563': JSON.stringify({ bioguideId: 'D000563', last: 'Durbin' }),
      }),
    });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/members/D000563', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      env,
      makeFakeCache(),
    );
    expect(r.status).toBe(200);
    expectUniversalBaseline(r);
    expect(r.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
  });

  it('sets universal baseline + CSP on 404 Worker-emitted response', async () => {
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/no-such-path'),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(404);
    expectUniversalBaseline(r);
    expect(r.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(r.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sets universal baseline on 400 invalid_upstream_path', async () => {
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3//member', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(400);
    expectUniversalBaseline(r);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('handleFetch — upstream fingerprinting headers stripped (AC-27.4)', () => {
  it('removes upstream Server, Link, x-api-umbrella-*, x-vcap-*', async () => {
    fakeUpstream = async () =>
      new Response('{}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          Server: 'apache-upstream',
          Link: '<https://api.congress.gov/v3/member/X>; rel="canonical"',
          'x-api-umbrella-request-id': 'umbrella-abc',
          'x-vcap-request-id': 'vcap-def',
          Via: '1.1 api-umbrella',
        },
      });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/member/X', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.headers.get('Server')).toBeNull();
    expect(r.headers.get('Link')).toBeNull();
    expect(r.headers.get('x-api-umbrella-request-id')).toBeNull();
    expect(r.headers.get('x-vcap-request-id')).toBeNull();
    expect(r.headers.get('Via')).toBeNull();
  });
});

describe('handleFetch — browser redirect (existing behavior preserved)', () => {
  it('redirects HTML navigation on unknown path to trackukraine.com', async () => {
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/anything', {
        headers: { Accept: 'text/html' },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(301);
    expect(r.headers.get('Location')).toBe('https://trackukraine.com/');
  });

  it('returns 404 for non-HTML unknown path', async () => {
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/anything'),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(404);
  });
});

describe('handleFetch — expanded fingerprinting header strip (AC-27.16)', () => {
  const origin = { Origin: 'https://trackukraine.com' };

  it('strips upstream x-ratelimit-* headers', async () => {
    fakeUpstream = async () =>
      new Response('{}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'x-ratelimit-limit': '20000',
          'x-ratelimit-remaining': '19807',
          'X-RateLimit-Reset': '1700000000',
        },
      });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/member/A000360', { headers: origin }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.headers.get('x-ratelimit-limit')).toBeNull();
    expect(r.headers.get('x-ratelimit-remaining')).toBeNull();
    expect(r.headers.get('X-RateLimit-Reset')).toBeNull();
  });

  it('strips upstream Clear-Site-Data', async () => {
    fakeUpstream = async () =>
      new Response('{}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Clear-Site-Data': '"cookies", "storage"',
        },
      });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/member/A000360', { headers: origin }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.headers.get('Clear-Site-Data')).toBeNull();
  });

  it('strips upstream Refresh', async () => {
    fakeUpstream = async () =>
      new Response('{}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          Refresh: '5; url=https://evil.com',
        },
      });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/member/A000360', { headers: origin }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.headers.get('Refresh')).toBeNull();
  });

  it('strips upstream Content-Location', async () => {
    fakeUpstream = async () =>
      new Response('{}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Location': '/v3/member/canonical',
        },
      });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/member/A000360', { headers: origin }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.headers.get('Content-Location')).toBeNull();
  });
});

describe('handleFetch — upstream Access-Control-* headers stripped (AC-27.17)', () => {
  it('strips upstream Access-Control-Expose-Headers and layers our own', async () => {
    fakeUpstream = async () =>
      new Response('{}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Expose-Headers': 'X-Upstream-Choice',
          'Access-Control-Allow-Origin': '*',
        },
      });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/member/A000360', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    // Upstream's Access-Control-Expose-Headers is gone.
    expect(r.headers.get('Access-Control-Expose-Headers')).toBeNull();
    // Our Access-Control-Allow-Origin (origin reflection, not wildcard) remains.
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('https://trackukraine.com');
  });
});

describe('handleFetch — upstream fetch timeout (AC-27.18 + FR-37 AC-37.6)', () => {
  it('returns FR-37 envelope (upstream_5xx, retryable, with traceId) when upstream aborts', async () => {
    fakeUpstream = async () => {
      const err = new DOMException('The operation was aborted.', 'AbortError');
      throw err;
    };
    const r = await handleFetch(
      // Use a route that does NOT go through the tiered cache intercept
      // today — a non-member Congress path like /bill/{c}/{type}/{num}.
      // The legacy handleApi path is what AC-27.18 was written against;
      // the tiered-cache path returns an FR-37 envelope with 502 status.
      new Request('https://vote.cogs.it.com/api/congress/v3/bill/117/hr/7691/actions', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    // Tiered cache wraps upstream errors in FR-37 envelope:
    //   code=upstream_5xx, retryable=true, status 502.
    expect(r.status).toBe(502);
    const body = (await r.json()) as { error: { code: string; retryable: boolean; traceId: string } };
    expect(body.error.code).toBe('upstream_5xx');
    expect(body.error.retryable).toBe(true);
    expect(body.error.traceId).toMatch(/^tr_/);
  });

  it('forwards X-Trace-Id to upstream fetch call (FR-36 AC-36.3)', async () => {
    let sawTrace = '';
    fakeUpstream = async (_url, init) => {
      const headers = new Headers(init?.headers);
      sawTrace = headers.get('X-Trace-Id') ?? '';
      return new Response(JSON.stringify({ actions: { actions: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/bill/117/hr/7691/actions', {
        headers: { Origin: 'https://trackukraine.com', 'X-Trace-Id': 'tr_0123456789abcdef' },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    // The fetcher forwards trace IDs to upstream per AC-36.3.
    expect(sawTrace).toBe('tr_0123456789abcdef');
  });
});

// AC-27.19 superseded: the R2-backed STATIC_FILES map was replaced by Worker
// Sites (env.ASSETS.fetch), so the prototype-lookup confusion that AC-27.19
// guarded against no longer exists in our code. Worker Sites delegates
// static-file resolution to Cloudflare's runtime, which keys its own store.
// See docs/decisions/ADR-010-post-audit-hardening.md §AC-27.19 supersedure.

afterAll(() => {
  globalThis.fetch = originalFetch;
});
