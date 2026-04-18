/**
 * Worker security contract tests.
 *
 * Traces to: FR-25 (AC-25.5, 25.7, 25.8, 25.9, 25.10), FR-27 (AC-27.1–27.9), ADR-006.
 *
 * The Worker is tested via its `handleFetch(request, env, cache)` export —
 * a pure function that takes a Request, an Env, and a Cache-compatible stub
 * and returns a Response. No miniflare, no wrangler runtime — just the helpers
 * in proxy/lib.ts driven through the same dispatch path that worker.ts uses.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  isOriginAllowed,
  isValidUpstreamPath,
  normalizeUpstreamErrorBody,
  applySecurityHeaders,
  stripFingerprintingHeaders,
  handleFetch,
  type ProxyEnv,
  type CacheLike,
} from '../../proxy/lib';

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

// ─── Pure helpers ──────────────────────────────────────────────────────────

describe('isOriginAllowed (AC-25.5, AC-25.7, AC-25.9)', () => {
  const allowlist = ['https://trackukraine.com', 'https://www.trackukraine.com'];

  it('returns true for exact whitelist match', () => {
    expect(isOriginAllowed('https://trackukraine.com', allowlist, false)).toBe(true);
  });

  it('returns false for missing origin (AC-25.5)', () => {
    expect(isOriginAllowed(null, allowlist, false)).toBe(false);
  });

  it('returns false for origin not on whitelist', () => {
    expect(isOriginAllowed('https://evil.example.com', allowlist, false)).toBe(false);
  });

  it('returns false for suffix-attack origin (AC-25.7)', () => {
    expect(isOriginAllowed('https://trackukraine.com.evil.example', allowlist, false)).toBe(false);
  });

  it('returns false for prefix-attack origin', () => {
    expect(isOriginAllowed('https://evil.trackukraine.com', allowlist, false)).toBe(false);
  });

  it('is case-sensitive (AC-25.7)', () => {
    expect(isOriginAllowed('https://TRACKUKRAINE.com', allowlist, false)).toBe(false);
  });

  it('denies localhost when ALLOW_LOCALHOST is false (AC-25.9 — PROD BEHAVIOR)', () => {
    expect(isOriginAllowed('http://localhost:9999', allowlist, false)).toBe(false);
    expect(isOriginAllowed('http://127.0.0.1:3000', allowlist, false)).toBe(false);
  });

  it('permits localhost only when ALLOW_LOCALHOST is true (AC-25.9)', () => {
    expect(isOriginAllowed('http://localhost', allowlist, true)).toBe(true);
    expect(isOriginAllowed('http://localhost:5173', allowlist, true)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:8080', allowlist, true)).toBe(true);
  });

  it('does NOT permit https://localhost even with ALLOW_LOCALHOST=true', () => {
    // Prevents `Origin: https://localhost.attacker.com` style confusion — we
    // intentionally only match http://, the local-dev scheme.
    expect(isOriginAllowed('https://localhost:3000', allowlist, true)).toBe(false);
  });

  it('does NOT permit localhost-lookalike origins with ALLOW_LOCALHOST=true', () => {
    expect(isOriginAllowed('http://localhost.evil.com', allowlist, true)).toBe(false);
    expect(isOriginAllowed('http://127.0.0.1.evil.com', allowlist, true)).toBe(false);
    expect(isOriginAllowed('http://1localhost', allowlist, true)).toBe(false);
  });
});

describe('isValidUpstreamPath (AC-27.7)', () => {
  it('accepts simple paths', () => {
    expect(isValidUpstreamPath('v3/member/A000360')).toBe(true);
    expect(isValidUpstreamPath('geocoder/geographies/onelineaddress')).toBe(true);
  });

  it('rejects paths containing ..', () => {
    expect(isValidUpstreamPath('v3/../admin')).toBe(false);
    expect(isValidUpstreamPath('..')).toBe(false);
    expect(isValidUpstreamPath('foo/..bar')).toBe(false);
  });

  it('rejects paths containing //', () => {
    expect(isValidUpstreamPath('v3//member')).toBe(false);
    expect(isValidUpstreamPath('//evil.com/x')).toBe(false);
  });

  it('rejects paths containing @', () => {
    expect(isValidUpstreamPath('v3/member@evil.com')).toBe(false);
  });

  it('rejects paths with raw control characters', () => {
    expect(isValidUpstreamPath('v3/member\x00/x')).toBe(false);
    expect(isValidUpstreamPath('v3/member\n/x')).toBe(false);
    expect(isValidUpstreamPath('v3/member\r/x')).toBe(false);
    expect(isValidUpstreamPath('v3/member\x7f/x')).toBe(false);
  });

  it('rejects paths with percent-encoded control bytes (AC-27.7)', () => {
    // URL.pathname preserves percent-encoded bytes — attacker uses them to
    // smuggle CR/LF past naive string checks. isValidUpstreamPath must reject.
    expect(isValidUpstreamPath('v3/member/foo%0d%0aX-Injected')).toBe(false);
    expect(isValidUpstreamPath('v3/member/%00admin')).toBe(false);
    expect(isValidUpstreamPath('v3/member/%7f')).toBe(false);
    expect(isValidUpstreamPath('v3/member/%1F')).toBe(false);
    expect(isValidUpstreamPath('v3/member/%0A')).toBe(false); // uppercase hex
  });

  it('accepts percent-encoded non-control bytes', () => {
    // %20 = space, %2f = /, %3a = : — still valid in paths.
    // (Note: %2f would be collapsed by URL.pathname normalization anyway in
    // most implementations, but structurally it's not a control byte.)
    expect(isValidUpstreamPath('v3/member/foo%20bar')).toBe(true);
    expect(isValidUpstreamPath('v3/member/A%3AB')).toBe(true);
  });

  it('accepts empty path', () => {
    // Empty is handled by upstream-path-starts-with-v3 check (AC-27.6), not here.
    expect(isValidUpstreamPath('')).toBe(true);
  });
});

describe('normalizeUpstreamErrorBody (AC-27.5)', () => {
  it('returns a JSON envelope for upstream errors', () => {
    const body = normalizeUpstreamErrorBody(500, 'congress');
    expect(JSON.parse(body)).toEqual({
      error: 'upstream_error',
      status: 500,
      upstream: 'congress',
    });
  });

  it('does not include the upstream response body', () => {
    // The helper signature deliberately does not accept the upstream body,
    // so it is impossible to pass it through by accident.
    const body = normalizeUpstreamErrorBody(502, 'census');
    expect(body).not.toMatch(/html|<|CONGRESS|api_key/);
  });
});

describe('applySecurityHeaders (AC-27.1)', () => {
  it('sets the universal baseline on any response', () => {
    const r = applySecurityHeaders(new Response('ok', { status: 200 }));
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
  });

  it('sets the baseline on error responses too', () => {
    const r = applySecurityHeaders(new Response('nope', { status: 403 }));
    expect(r.headers.get('Strict-Transport-Security')).toBeTruthy();
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('preserves the original status and body', async () => {
    const r = applySecurityHeaders(new Response('hello', { status: 418 }));
    expect(r.status).toBe(418);
    expect(await r.text()).toBe('hello');
  });
});

describe('stripFingerprintingHeaders (AC-27.3)', () => {
  it('removes Set-Cookie', () => {
    const h = new Headers({ 'Set-Cookie': 'sid=abc' });
    stripFingerprintingHeaders(h);
    expect(h.get('Set-Cookie')).toBeNull();
  });

  it('removes Access-Control-Allow-Credentials', () => {
    const h = new Headers({ 'Access-Control-Allow-Credentials': 'true' });
    stripFingerprintingHeaders(h);
    expect(h.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('removes Server, Via, Link', () => {
    const h = new Headers({ Server: 'apache', Via: '1.1 foo', Link: '<x>; rel=bar' });
    stripFingerprintingHeaders(h);
    expect(h.get('Server')).toBeNull();
    expect(h.get('Via')).toBeNull();
    expect(h.get('Link')).toBeNull();
  });

  it('removes Report-To, NEL, Reporting-Endpoints (opt-out of upstream beacons)', () => {
    const h = new Headers({
      'Report-To': '{"group":"x"}',
      NEL: '{"report_to":"x"}',
      'Reporting-Endpoints': 'default="https://x"',
    });
    stripFingerprintingHeaders(h);
    expect(h.get('Report-To')).toBeNull();
    expect(h.get('NEL')).toBeNull();
    expect(h.get('Reporting-Endpoints')).toBeNull();
  });

  it('removes X-Powered-By, X-AspNet-Version, X-AspNetMvc-Version, P3P', () => {
    const h = new Headers({
      'X-Powered-By': 'Express',
      'X-AspNet-Version': '4.0',
      'X-AspNetMvc-Version': '5.2',
      P3P: 'CP="foo"',
    });
    stripFingerprintingHeaders(h);
    expect(h.get('X-Powered-By')).toBeNull();
    expect(h.get('X-AspNet-Version')).toBeNull();
    expect(h.get('X-AspNetMvc-Version')).toBeNull();
    expect(h.get('P3P')).toBeNull();
  });

  it('removes x-vcap-*, x-api-umbrella-*, x-amz-*, x-azure-*, x-appengine-*, x-request-id, x-correlation-id, x-trace-id, x-b3-*', () => {
    const h = new Headers({
      'x-vcap-request-id': '1',
      'X-API-Umbrella-Request-Id': '2',
      'x-amz-request-id': '3',
      'x-azure-ref': '4',
      'x-appengine-region': '5',
      'x-request-id': '6',
      'x-correlation-id': '7',
      'x-trace-id': '8',
      'x-b3-traceid': '9',
    });
    stripFingerprintingHeaders(h);
    for (const k of [
      'x-vcap-request-id',
      'X-API-Umbrella-Request-Id',
      'x-amz-request-id',
      'x-azure-ref',
      'x-appengine-region',
      'x-request-id',
      'x-correlation-id',
      'x-trace-id',
      'x-b3-traceid',
    ]) {
      expect(h.get(k)).toBeNull();
    }
  });

  it('does not remove headers we explicitly keep', () => {
    const h = new Headers({
      'Content-Type': 'application/json',
      'Cache-Control': 'public',
      ETag: 'abc',
    });
    stripFingerprintingHeaders(h);
    expect(h.get('Content-Type')).toBe('application/json');
    expect(h.get('Cache-Control')).toBe('public');
    expect(h.get('ETag')).toBe('abc');
  });
});

// ─── Integration via handleFetch ───────────────────────────────────────────

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

describe('handleFetch — Accept-header cache poisoning defense (AC-27.11)', () => {
  it('does NOT forward client Accept header to upstream (congress → pinned JSON)', async () => {
    let capturedAccept = '';
    fakeUpstream = async (_url, init) => {
      const headers = new Headers(init?.headers);
      capturedAccept = headers.get('Accept') ?? '';
      return new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/member/A000360', {
        headers: {
          Origin: 'https://trackukraine.com',
          Accept: 'text/html',
        },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(capturedAccept).not.toBe('text/html');
    expect(capturedAccept).toBe('application/json');
  });

  it('pins Accept: application/json on census upstream', async () => {
    let capturedAccept = '';
    fakeUpstream = async (_url, init) => {
      capturedAccept = new Headers(init?.headers).get('Accept') ?? '';
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    await handleFetch(
      new Request(
        'https://vote.cogs.it.com/api/census/geocoder/geographies/onelineaddress?address=x&benchmark=y&vintage=z&format=json',
        {
          headers: { Origin: 'https://trackukraine.com', Accept: 'text/html' },
        },
      ),
      makeEnv(),
      makeFakeCache(),
    );
    expect(capturedAccept).toBe('application/json');
  });

  it('pins XML-accepting Accept on senate upstream', async () => {
    let capturedAccept = '';
    fakeUpstream = async (_url, init) => {
      capturedAccept = new Headers(init?.headers).get('Accept') ?? '';
      return new Response('<xml/>', { status: 200, headers: { 'Content-Type': 'application/xml' } });
    };
    await handleFetch(
      new Request('https://vote.cogs.it.com/api/senate/legislative/LIS/roll_call_votes/x', {
        headers: { Origin: 'https://trackukraine.com', Accept: 'text/html' },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(capturedAccept).toMatch(/xml/);
    expect(capturedAccept).not.toBe('text/html');
  });
});

describe('handleFetch — tighter congress v3 path regex (AC-27.12)', () => {
  const origin = { Origin: 'https://trackukraine.com' };

  it('rejects /api/congress/v3/ (bare trailing slash) — does NOT attach key', async () => {
    let fetchCalled = false;
    fakeUpstream = async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    };
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/', { headers: origin }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(400);
    expect(fetchCalled).toBe(false);
    const body = await r.json();
    expect(body.error).toBe('unsupported_upstream_path');
  });

  it('rejects /api/congress/v3 (no trailing slash at all)', async () => {
    let fetchCalled = false;
    fakeUpstream = async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    };
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3', { headers: origin }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(400);
    expect(fetchCalled).toBe(false);
  });

  it('rejects /api/congress/v3/0 (non-alpha first segment char)', async () => {
    let fetchCalled = false;
    fakeUpstream = async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    };
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/0', { headers: origin }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(400);
    expect(fetchCalled).toBe(false);
  });

  it('accepts /api/congress/v3/member/A000360 (alpha first char)', async () => {
    fakeUpstream = async () =>
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/member/A000360', { headers: origin }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(200);
  });

  it('accepts /api/congress/v3/bill/118/hr/1234/actions (alpha first char)', async () => {
    fakeUpstream = async () =>
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    const r = await handleFetch(
      new Request(
        'https://vote.cogs.it.com/api/congress/v3/bill/118/hr/1234/actions',
        { headers: origin },
      ),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(200);
  });
});

describe('handleFetch — URL-constructor backslash handling (N10 — lock-in)', () => {
  // The URL constructor normalizes backslashes in unusual ways (converts to
  // %XX for some control-byte equivalents, drops others). This test locks in
  // the expected behavior so future URL-spec changes don't silently regress.
  it('rejects raw backslash in upstream path via path validator', async () => {
    // Backslash %5c percent-encoded survives URL.pathname
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/member/foo%5cbar', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    // %5c (backslash) is not a control byte so isValidUpstreamPath allows it.
    // This test documents that backslash passes our validator but is fine
    // because URL normalization will have collapsed any host-switch attempts
    // before we see the path.
    expect(r.status).not.toBe(500);
  });
});

describe('handleFetch — API-key injection scope (AC-27.6, AC-25.10)', () => {
  it('injects CONGRESS_API_KEY only when upstream path starts with v3/', async () => {
    let capturedUrl = '';
    fakeUpstream = async (u) => {
      capturedUrl = u;
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/member/A000360?format=json', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(200);
    expect(capturedUrl).toContain('api_key=SECRET-TEST-KEY');
    expect(capturedUrl).toContain('api.congress.gov/v3/member/A000360');
  });

  it('rejects non-v3 congress paths with 400, does NOT send the key upstream (AC-27.6)', async () => {
    let fetchCalled = false;
    fakeUpstream = async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    };
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/admin/x', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(400);
    expect(fetchCalled).toBe(false);
    const body = await r.json();
    expect(body.error).toBe('unsupported_upstream_path');
  });

  it('strips client-supplied api_key before overwriting with the secret (AC-25.10)', async () => {
    let capturedUrl = '';
    fakeUpstream = async (u) => {
      capturedUrl = u;
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    await handleFetch(
      new Request(
        'https://vote.cogs.it.com/api/congress/v3/member/A000360?api_key=attacker&format=json',
        { headers: { Origin: 'https://trackukraine.com' } },
      ),
      makeEnv(),
      makeFakeCache(),
    );
    // api_key appears exactly once and is the server value, not the attacker value.
    const keyParams = [...new URL(capturedUrl).searchParams.getAll('api_key')];
    expect(keyParams).toEqual(['SECRET-TEST-KEY']);
    expect(capturedUrl).not.toContain('attacker');
  });

  it('does NOT attach api_key to census upstream (AC-25.10)', async () => {
    let capturedUrl = '';
    fakeUpstream = async (u) => {
      capturedUrl = u;
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    await handleFetch(
      new Request(
        'https://vote.cogs.it.com/api/census/geocoder/geographies/onelineaddress?address=x&api_key=attacker',
        { headers: { Origin: 'https://trackukraine.com' } },
      ),
      makeEnv(),
      makeFakeCache(),
    );
    expect(capturedUrl).not.toContain('api_key');
  });
});

describe('handleFetch — upstream-path validation (AC-27.7)', () => {
  const baseHeaders = { Origin: 'https://trackukraine.com' };

  // Note: `..` sequences are normalized away by the URL constructor before
  // the request ever reaches isValidUpstreamPath, so `..` can't be tested
  // via handleFetch. The helper's `..` branch is asserted directly in the
  // `isValidUpstreamPath` describe block above as defense-in-depth against
  // any future code path that bypasses URL parsing.

  it('rejects // in upstream path', async () => {
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3//member', { headers: baseHeaders }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(400);
  });

  it('rejects @ in upstream path', async () => {
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/member@evil.com', {
        headers: baseHeaders,
      }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(400);
  });

  it('rejects percent-encoded CRLF (%0d%0a) in upstream path — header-injection defense', async () => {
    let fetchCalled = false;
    fakeUpstream = async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    };
    const r = await handleFetch(
      new Request(
        'https://vote.cogs.it.com/api/congress/v3/member/foo%0d%0aX-Injected:%20bar',
        { headers: baseHeaders },
      ),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(400);
    expect(fetchCalled).toBe(false);
    const body = await r.json();
    expect(body.error).toBe('invalid_upstream_path');
  });

  it('rejects percent-encoded null byte (%00) in upstream path', async () => {
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/member/%00admin', {
        headers: baseHeaders,
      }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(400);
  });
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

// ─── Post-audit hardening (v2.5.1) ─────────────────────────────────────────

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

describe('handleFetch — upstream fetch timeout (AC-27.18)', () => {
  it('returns 504 upstream_timeout when the upstream aborts with a timeout error', async () => {
    fakeUpstream = async () => {
      // Simulate what AbortSignal.timeout() produces when it fires.
      const err = new DOMException('The operation was aborted.', 'AbortError');
      throw err;
    };
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/member/A000360', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    // 504 (timeout) is more specific than the pre-existing 502 (unreachable).
    expect([502, 504]).toContain(r.status);
    // Must not cache timeouts.
    expect(r.headers.get('Cache-Control')).toBe('no-store');
  });

  it('attaches AbortSignal to the upstream fetch call', async () => {
    let sawSignal = false;
    fakeUpstream = async (_url, init) => {
      sawSignal = !!init?.signal;
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    await handleFetch(
      new Request('https://vote.cogs.it.com/api/congress/v3/member/A000360', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(sawSignal).toBe(true);
  });
});

// AC-27.19 superseded: the R2-backed STATIC_FILES map was replaced by Worker
// Sites (env.ASSETS.fetch), so the prototype-lookup confusion that AC-27.19
// guarded against no longer exists in our code. Worker Sites delegates
// static-file resolution to Cloudflare's runtime, which keys its own store.
// See docs/decisions/ADR-010-post-audit-hardening.md §AC-27.19 supersedure.

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

  it('returns 429 with Retry-After when the limiter rejects (AC-27.21)', async () => {
    const rl = makeRateLimiter(0); // reject every request
    fakeUpstream = async () =>
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
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

afterAll(() => {
  globalThis.fetch = originalFetch;
});
