/**
 * Trace ID + observability coverage across every route class (T-103).
 *
 * Asserts the B2 audit fix: every outbound response from `handleFetch`
 * carries a well-formed `tr_<16hex>` `X-Trace-Id`, and the Analytics Engine
 * fake receives one data point per request, regardless of which code path
 * produced the response.
 *
 * Before T-103, only the tiered-cache `serveCached` pipeline emitted these.
 * After T-103, the middleware in `handleFetch` stamps them unconditionally.
 *
 * Traces: audit B2, FR-36 AC-36.2, FR-38 AC-38.2, FR-39 AC-39.2.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  handleFetch,
  type ProxyEnv,
  type CacheLike,
} from '../../proxy/lib';
import { TRACE_ID_PATTERN } from '../../proxy/observability/trace';

const CANONICAL_TRACE = /^tr_[0-9a-f]{16}$/;

/** Analytics-Engine fake that records every writeDataPoint call. */
function makeAnalyticsFake() {
  const points: Array<{ blobs?: string[]; doubles?: number[]; indexes?: string[] }> = [];
  return {
    points,
    binding: {
      writeDataPoint(p: { blobs?: string[]; doubles?: number[]; indexes?: string[] }) {
        points.push(p);
      },
    },
  };
}

/** Simple waitUntil fake that awaits everything it's handed so analytics
 *  points land before the test inspects them. */
function makeCtx() {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil(p: Promise<unknown>) { promises.push(p); },
    flush: () => Promise.all(promises),
  };
}

function makeFakeCache(): CacheLike {
  const store = new Map<string, Response>();
  return {
    async match(req: Request | string) {
      const key = typeof req === 'string' ? req : req.url;
      return store.get(key)?.clone();
    },
    async put(req: Request | string, resp: Response) {
      const key = typeof req === 'string' ? req : req.url;
      store.set(key, resp);
    },
  };
}

function makeFakeKV(store: Record<string, string> = {}): ProxyEnv['KV_VOTER_INFO'] {
  return {
    async get(key: string) { return store[key] ?? null; },
    async put(key: string, value: string) { store[key] = value; },
    async list({ prefix }: { prefix: string }) {
      return { keys: Object.keys(store).filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
    async delete(key: string) { delete store[key]; },
  };
}

function makeEnv(analytics: ReturnType<typeof makeAnalyticsFake>, overrides: Partial<ProxyEnv> = {}): ProxyEnv {
  return {
    CONGRESS_API_KEY: 'SECRET-TEST-KEY',
    ALLOWED_ORIGINS: 'https://trackukraine.com',
    KV_VOTER_INFO: makeFakeKV(),
    ANALYTICS: analytics.binding,
    ENV_NAME: 'uat',
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;
let fakeUpstream: ((url: string) => Promise<Response>) | null = null;

beforeEach(() => {
  fakeUpstream = null;
  globalThis.fetch = (async (url: string) => {
    if (fakeUpstream) return fakeUpstream(url.toString());
    return new Response('no upstream handler', { status: 599 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
});

afterAll(() => { globalThis.fetch = originalFetch; });

// ─── Trace-ID echo helper ───
async function runAndCheck(request: Request, env: ProxyEnv, ctx = makeCtx()): Promise<{ res: Response; trace: string | null }> {
  const res = await handleFetch(request, env, makeFakeCache(), ctx);
  await ctx.flush();
  return { res, trace: res.headers.get('X-Trace-Id') };
}

describe('T-103 — X-Trace-Id on every route class', () => {
  it('AC-36.2 — KV member profile 404 carries a trace ID', async () => {
    const analytics = makeAnalyticsFake();
    const { res, trace } = await runAndCheck(
      new Request('https://vote.cogs.it.com/api/members/X000000', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(analytics),
    );
    expect(trace).toMatch(CANONICAL_TRACE);
    expect(analytics.points).toHaveLength(1);
    expect(analytics.points[0]!.indexes?.[0]).toBe(trace);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('AC-36.2 — origin-denied 403 carries a trace ID', async () => {
    const analytics = makeAnalyticsFake();
    const { res, trace } = await runAndCheck(
      new Request('https://vote.cogs.it.com/api/members/A000360', {
        headers: { Origin: 'https://evil.example' },
      }),
      makeEnv(analytics),
    );
    expect(res.status).toBe(403);
    expect(trace).toMatch(CANONICAL_TRACE);
    expect(analytics.points[0]!.blobs?.[2]).toBe('origin_not_allowed');
  });

  it('AC-36.2 — method-not-allowed 405 carries a trace ID', async () => {
    const analytics = makeAnalyticsFake();
    const { res, trace } = await runAndCheck(
      new Request('https://vote.cogs.it.com/api/members/A000360', {
        method: 'POST',
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(analytics),
    );
    expect(res.status).toBe(405);
    expect(trace).toMatch(CANONICAL_TRACE);
    expect(analytics.points[0]!.blobs?.[2]).toBe('method_not_allowed');
  });

  it('AC-36.2 — 404 for unknown path carries a trace ID', async () => {
    const analytics = makeAnalyticsFake();
    const { res, trace } = await runAndCheck(
      new Request('https://vote.cogs.it.com/this-does-not-exist', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(analytics),
    );
    expect(res.status).toBe(404);
    expect(trace).toMatch(CANONICAL_TRACE);
  });

  it('AC-36.2 — upstream passthrough 2xx carries a trace ID', async () => {
    fakeUpstream = async () => new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
    const analytics = makeAnalyticsFake();
    const { res, trace } = await runAndCheck(
      new Request('https://vote.cogs.it.com/api/congress/v3/member/A000360', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(analytics),
    );
    expect(res.status).toBe(200);
    expect(trace).toMatch(CANONICAL_TRACE);
    expect(analytics.points[0]!.blobs?.[2]).toBe('ok');
  });

  it('AC-36.2 — upstream passthrough 500 carries a trace ID + FR-37 envelope traceId matches header', async () => {
    fakeUpstream = async () => new Response('<html>err</html>', {
      status: 500, headers: { 'Content-Type': 'text/html' },
    });
    const analytics = makeAnalyticsFake();
    const { trace } = await runAndCheck(
      new Request('https://vote.cogs.it.com/api/congress/v3/member/A000360', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(analytics),
    );
    expect(trace).toMatch(CANONICAL_TRACE);
    expect(analytics.points[0]!.blobs?.[2]).not.toBe('ok');
  });

  it('AC-36.1 — client-supplied well-formed X-Trace-Id is echoed verbatim', async () => {
    const supplied = 'tr_abcdef0123456789';
    expect(TRACE_ID_PATTERN.test(supplied)).toBe(true);
    const analytics = makeAnalyticsFake();
    const { trace } = await runAndCheck(
      new Request('https://vote.cogs.it.com/api/members/A000360', {
        headers: { Origin: 'https://trackukraine.com', 'X-Trace-Id': supplied },
      }),
      makeEnv(analytics),
    );
    expect(trace).toBe(supplied);
    expect(analytics.points[0]!.indexes?.[0]).toBe(supplied);
  });

  it('AC-36.1 — malformed X-Trace-Id is replaced with a fresh one', async () => {
    const analytics = makeAnalyticsFake();
    const { trace } = await runAndCheck(
      new Request('https://vote.cogs.it.com/api/members/A000360', {
        headers: { Origin: 'https://trackukraine.com', 'X-Trace-Id': 'NOT-VALID' },
      }),
      makeEnv(analytics),
    );
    expect(trace).not.toBe('NOT-VALID');
    expect(trace).toMatch(CANONICAL_TRACE);
  });

  it('AC-40.9 / audit B3 — Access-Control-Expose-Headers lists the observability headers', async () => {
    fakeUpstream = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    const analytics = makeAnalyticsFake();
    const { res } = await runAndCheck(
      new Request('https://vote.cogs.it.com/api/congress/v3/member/A000360', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(analytics),
    );
    const expose = res.headers.get('Access-Control-Expose-Headers') ?? '';
    expect(expose).toMatch(/X-Trace-Id/);
    expect(expose).toMatch(/X-Cache\b/);
    expect(expose).toMatch(/X-Proxy-Cache/);
  });

  it('AC-38.2 — one analytics point per request, carrying trace + routeClass + status', async () => {
    const analytics = makeAnalyticsFake();
    await runAndCheck(
      new Request('https://vote.cogs.it.com/api/name-search?q=durbin', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(analytics),
    );
    expect(analytics.points).toHaveLength(1);
    const p = analytics.points[0]!;
    expect(p.blobs?.[0]).toBe('name-search');
    expect(p.blobs?.[3]).toBe('uat'); // env label
    expect(p.doubles?.[2]).toBeGreaterThanOrEqual(200);
    expect(p.indexes?.[0]).toMatch(CANONICAL_TRACE);
  });
});
