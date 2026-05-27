/**
 * Extended coverage for proxy/router.ts#dispatch — exercises branches
 * not covered by router.adminBootstrap.test.ts:
 *  - /embed and /embed/ GET HTML response (lines 384-401)
 *  - Worker Sites ASSETS fall-through 404 + thrown error catch (line 452)
 *  - KV-route OPTIONS preflight (origin allowed + denied)
 *  - KV-route 405 Method Not Allowed
 *  - KV-route origin-not-allowed on GET
 *  - KV-route missing-id 400 envelopes (e.g. /api/members)
 *  - KV-route audit/stats unknown sub-route -> 404
 *  - admin-route origin-not-allowed 403
 *
 * No source files modified. Vitest named imports only; no vi.mock.
 */
import { describe, it, expect, vi } from 'vitest';
import { dispatch } from '../../proxy/router';
import type { ProxyEnv, CacheLike } from '../../proxy/env';

function makeEnv(opts: {
  assets?: { fetch: (req: Request) => Promise<Response> };
  envName?: string;
  previewMode?: string;
  allowedOrigins?: string;
  allowLocalhost?: string;
} = {}): ProxyEnv {
  return {
    ENV_NAME: opts.envName ?? 'dev',
    ALLOWED_ORIGINS: opts.allowedOrigins ?? 'https://embed.example',
    ALLOW_LOCALHOST: opts.allowLocalhost ?? 'true',
    PREVIEW_MODE: opts.previewMode ?? 'true',
    ASSETS: opts.assets,
    KV_VOTER_INFO: {
      get: async () => null,
      put: async () => {},
      list: async () => ({ keys: [], list_complete: true }),
      delete: async () => {},
    },
  } as unknown as ProxyEnv;
}

const fakeCache: CacheLike = {
  match: async () => undefined,
  put: async () => {},
};

const fakeCtx = { waitUntil: () => {} };

function makeHtmlGet(path: string): Request {
  return new Request(`https://worker.example${path}`, {
    method: 'GET',
    headers: { Accept: 'text/html' },
  });
}

describe('router /embed HTML branch (lines 384-401)', () => {
  it('GET /embed returns embeddable HTML with CSP and cache headers', async () => {
    const env = makeEnv();
    const result = await dispatch(makeHtmlGet('/embed'), env, fakeCache, fakeCtx);
    expect(result.response.status).toBe(200);
    expect(result.shape).toBe('embeddable-html');
    expect(result.response.headers.get('Content-Type')).toContain('text/html');
    expect(result.response.headers.get('Cache-Control')).toBe('public, max-age=600');
    const csp = result.response.headers.get('Content-Security-Policy');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' https://static.cloudflareinsights.com");
    expect(csp).toContain("base-uri 'none'");
    const body = await result.response.text();
    expect(body.toLowerCase()).toContain('<!doctype html>');
  });

  it('GET /embed/ (trailing slash) is treated identically', async () => {
    const env = makeEnv();
    const result = await dispatch(makeHtmlGet('/embed/'), env, fakeCache, fakeCtx);
    expect(result.response.status).toBe(200);
    expect(result.shape).toBe('embeddable-html');
    expect(result.response.headers.get('Content-Type')).toContain('text/html');
  });

  it('GET /embed on prod (PREVIEW_MODE unset) still serves the embed HTML', async () => {
    const env = {
      ENV_NAME: 'prod',
      ALLOWED_ORIGINS: 'https://trackukraine.com',
      KV_VOTER_INFO: {
        get: async () => null,
        put: async () => {},
        list: async () => ({ keys: [], list_complete: true }),
        delete: async () => {},
      },
    } as unknown as ProxyEnv;
    const result = await dispatch(makeHtmlGet('/embed'), env, fakeCache, fakeCtx);
    expect(result.response.status).toBe(200);
    expect(result.shape).toBe('embeddable-html');
  });
});

describe('router unknown-path Worker Sites fall-through (line 444-454)', () => {
  it('returns 404 with no ASSETS binding', async () => {
    const env = makeEnv({ assets: undefined });
    // Non-HTML, non-API path: falls through past every dispatch case to ASSETS.
    const req = new Request('https://worker.example/static/missing.js', {
      method: 'GET',
      headers: { Accept: '*/*' },
    });
    const result = await dispatch(req, env, fakeCache, fakeCtx);
    expect(result.response.status).toBe(404);
    expect(result.shape).toBe('worker-emitted');
    expect(await result.response.text()).toBe('Not Found');
  });

  it('returns the asset response when ASSETS.fetch produces non-404', async () => {
    const fetchAsset = vi.fn(async () => new Response('console.log(1)', {
      status: 200,
      headers: { 'Content-Type': 'application/javascript' },
    }));
    const env = makeEnv({ assets: { fetch: fetchAsset } });
    const req = new Request('https://worker.example/voter-info-widget.iife.js', {
      method: 'GET',
      headers: { Accept: '*/*' },
    });
    const result = await dispatch(req, env, fakeCache, fakeCtx);
    expect(result.response.status).toBe(200);
    expect(result.shape).toBe('static-asset');
    expect(fetchAsset).toHaveBeenCalledOnce();
  });

  it('falls through to 404 when ASSETS.fetch returns 404', async () => {
    const fetchAsset = vi.fn(async () => new Response('not found', { status: 404 }));
    const env = makeEnv({ assets: { fetch: fetchAsset } });
    const req = new Request('https://worker.example/missing-asset.js', {
      method: 'GET',
      headers: { Accept: '*/*' },
    });
    const result = await dispatch(req, env, fakeCache, fakeCtx);
    expect(result.response.status).toBe(404);
    expect(result.shape).toBe('worker-emitted');
    expect(await result.response.text()).toBe('Not Found');
  });

  it('falls through to 404 when ASSETS.fetch throws (catch on line ~452)', async () => {
    const fetchAsset = vi.fn(async () => {
      throw new Error('asset binding kaput');
    });
    const env = makeEnv({ assets: { fetch: fetchAsset } });
    const req = new Request('https://worker.example/static/anything.js', {
      method: 'GET',
      headers: { Accept: '*/*' },
    });
    const result = await dispatch(req, env, fakeCache, fakeCtx);
    expect(result.response.status).toBe(404);
    expect(result.shape).toBe('worker-emitted');
    expect(await result.response.text()).toBe('Not Found');
  });
});

describe('router KV-route preflight + method + origin checks', () => {
  function apiReq(path: string, method: string, origin?: string): Request {
    const headers: Record<string, string> = {};
    if (origin) headers.Origin = origin;
    return new Request(`https://worker.example${path}`, { method, headers });
  }

  it('OPTIONS preflight on KV route with allowed origin returns 204 + CORS', async () => {
    const env = makeEnv();
    const result = await dispatch(
      apiReq('/api/members/B000123', 'OPTIONS', 'https://embed.example'),
      env,
      fakeCache,
      fakeCtx,
    );
    expect(result.response.status).toBe(204);
    expect(result.shape).toBe('api-proxied');
    expect(result.response.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
    expect(result.response.headers.get('Access-Control-Allow-Origin')).toBe('https://embed.example');
  });

  it('OPTIONS preflight on KV route with disallowed origin returns 403', async () => {
    const env = makeEnv({
      allowedOrigins: 'https://embed.example',
      allowLocalhost: 'false',
      previewMode: 'false',
    });
    const result = await dispatch(
      apiReq('/api/members/B000123', 'OPTIONS', 'https://evil.example'),
      env,
      fakeCache,
      fakeCtx,
    );
    expect(result.response.status).toBe(403);
    expect(result.shape).toBe('worker-emitted');
    expect(result.response.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
  });

  it('POST to a KV-read route returns 405 Method Not Allowed', async () => {
    const env = makeEnv();
    const result = await dispatch(
      apiReq('/api/members/B000123', 'POST', 'https://embed.example'),
      env,
      fakeCache,
      fakeCtx,
    );
    expect(result.response.status).toBe(405);
    expect(result.shape).toBe('worker-emitted');
    expect(result.response.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
  });

  it('GET on KV route with disallowed origin returns 403', async () => {
    const env = makeEnv({
      allowedOrigins: 'https://embed.example',
      allowLocalhost: 'false',
      previewMode: 'false',
    });
    const result = await dispatch(
      apiReq('/api/members/B000123', 'GET', 'https://evil.example'),
      env,
      fakeCache,
      fakeCtx,
    );
    expect(result.response.status).toBe(403);
    expect(result.shape).toBe('worker-emitted');
  });

  it('GET /api/members (no bioguide) returns 400 missing_bioguide_id', async () => {
    const env = makeEnv();
    const result = await dispatch(
      apiReq('/api/members', 'GET', 'https://embed.example'),
      env,
      fakeCache,
      fakeCtx,
    );
    expect(result.response.status).toBe(400);
    const body = await result.response.json() as { error: string };
    expect(body.error).toBe('missing_bioguide_id');
  });

  it('GET /api/audit/something-else returns 404 not_found', async () => {
    const env = makeEnv();
    const result = await dispatch(
      apiReq('/api/audit/private', 'GET', 'https://embed.example'),
      env,
      fakeCache,
      fakeCtx,
    );
    expect(result.response.status).toBe(404);
    const body = await result.response.json() as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('GET /api/stats/wrong returns 404 not_found', async () => {
    const env = makeEnv();
    const result = await dispatch(
      apiReq('/api/stats/something-else', 'GET', 'https://embed.example'),
      env,
      fakeCache,
      fakeCtx,
    );
    expect(result.response.status).toBe(404);
    const body = await result.response.json() as { error: string };
    expect(body.error).toBe('not_found');
  });
});

describe('router admin-route origin-allowlist branch', () => {
  it('returns 403 origin-not-allowed when admin request comes from disallowed origin', async () => {
    // Non-preview env so the origin check is enforced.
    const env = {
      ENV_NAME: 'prod',
      ALLOWED_ORIGINS: 'https://trackukraine.com',
      ALLOW_LOCALHOST: 'false',
      KV_VOTER_INFO: {
        get: async () => null,
        put: async () => {},
        list: async () => ({ keys: [], list_complete: true }),
        delete: async () => {},
      },
    } as unknown as ProxyEnv;
    const req = new Request('https://worker.example/api/admin/anything', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    });
    const result = await dispatch(req, env, fakeCache, fakeCtx);
    expect(result.response.status).toBe(403);
    expect(result.shape).toBe('worker-emitted');
    expect(result.response.headers.get('Allow')).toBe('GET, POST, PATCH, DELETE, OPTIONS');
  });
});
