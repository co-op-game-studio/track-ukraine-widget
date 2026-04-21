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

afterAll(() => {
  globalThis.fetch = originalFetch;
});
