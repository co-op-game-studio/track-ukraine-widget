/**
 * Tests for proxy/router.ts#dispatch admin-SPA-serving path.
 * Traces to FR-52 AC-52.2, FR-44 AC-44.22.
 */
import { describe, it, expect, vi } from 'vitest';
import { dispatch } from '../../proxy/router';
import type { ProxyEnv, CacheLike } from '../../proxy/env';

function makeEnv(opts: {
  assets?: { fetch: (req: Request) => Promise<Response> };
} = {}): ProxyEnv {
  return {
    ENV_NAME: 'dev',
    ALLOWED_ORIGINS: 'https://embed.example',
    ALLOW_LOCALHOST: 'true',
    PREVIEW_MODE: 'true',
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

describe('router /admin SPA bootstrap (FR-52 AC-52.2, FR-44 AC-44.22)', () => {
  it('GET /admin rewrites to /admin/index.html via ASSETS', async () => {
    const fetchAsset = vi.fn(async (req: Request) => {
      const u = new URL(req.url);
      expect(u.pathname).toBe('/admin/index.html');
      return new Response('<!doctype html><html><body>admin SPA shell</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    });
    const env = makeEnv({ assets: { fetch: fetchAsset } });
    const result = await dispatch(makeHtmlGet('/admin'), env, fakeCache, fakeCtx);
    expect(result.response.status).toBe(200);
    expect(result.shape).toBe('static-asset');
    expect(fetchAsset).toHaveBeenCalledOnce();
    expect(await result.response.text()).toMatch(/admin SPA shell/);
  });

  it('GET /admin/ (trailing slash) rewrites identically', async () => {
    let capturedUrl: string | null = null;
    const fetchAsset = vi.fn(async (req: Request) => {
      capturedUrl = req.url;
      return new Response('shell', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    });
    const env = makeEnv({ assets: { fetch: fetchAsset } });
    const result = await dispatch(makeHtmlGet('/admin/'), env, fakeCache, fakeCtx);
    expect(result.response.status).toBe(200);
    expect(fetchAsset).toHaveBeenCalledOnce();
    expect(capturedUrl).not.toBeNull();
    expect(new URL(capturedUrl!).pathname).toBe('/admin/index.html');
  });

  it('returns 404 admin_spa_missing when ASSETS binding is absent', async () => {
    const env = makeEnv({ assets: undefined });
    const result = await dispatch(makeHtmlGet('/admin'), env, fakeCache, fakeCtx);
    expect(result.response.status).toBe(404);
    const body = await result.response.text();
    expect(body).toMatch(/admin SPA bundle missing/i);
  });

  it('does NOT crash the Worker (returns 404, not 500) when ASSETS.fetch throws', async () => {
    const fetchAsset = vi.fn(async () => {
      throw new Error('asset binding internal error');
    });
    const env = makeEnv({ assets: { fetch: fetchAsset } });
    const result = await dispatch(makeHtmlGet('/admin'), env, fakeCache, fakeCtx);
    expect(result.response.status).toBe(404);
    const body = await result.response.text();
    expect(body).toMatch(/admin SPA bundle missing/i);
  });

  // AC-52.10 — the dev preview-HTML branch SHALL NOT intercept /admin/* paths.
  // Discovered live on dev 2026-05-02: `GET /admin/index.html Accept: text/html`
  // was being served the embed preview HTML, replacing the SPA shell and
  // breaking SPA bootstrap.
  it('AC-52.10: GET /admin/index.html falls through to ASSETS even with PREVIEW_MODE=true', async () => {
    let capturedUrl: string | null = null;
    const fetchAsset = vi.fn(async (req: Request) => {
      capturedUrl = req.url;
      return new Response('<!doctype html><html><body>real admin SPA shell</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    });
    const env = makeEnv({ assets: { fetch: fetchAsset } });
    // PREVIEW_MODE = 'true' is the dev / non-prod default. This is the
    // condition that produced the bug.
    const result = await dispatch(
      makeHtmlGet('/admin/index.html'),
      env,
      fakeCache,
      fakeCtx,
    );
    expect(result.response.status).toBe(200);
    expect(capturedUrl).not.toBeNull();
    expect(new URL(capturedUrl!).pathname).toBe('/admin/index.html');
    const body = await result.response.text();
    expect(body).toMatch(/real admin SPA shell/);
    // Specifically NOT the embed preview HTML.
    expect(body).not.toMatch(/preview/i);
  });

  it('AC-52.10: GET /admin/anything Accept:text/html falls through to ASSETS on prod (no PREVIEW_MODE)', async () => {
    let capturedUrl: string | null = null;
    const fetchAsset = vi.fn(async (req: Request) => {
      capturedUrl = req.url;
      return new Response('admin asset payload', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    });
    const env = {
      ENV_NAME: 'prod',
      ALLOWED_ORIGINS: 'https://trackukraine.com',
      ASSETS: { fetch: fetchAsset },
      KV_VOTER_INFO: {
        get: async () => null,
        put: async () => {},
        list: async () => ({ keys: [], list_complete: true }),
        delete: async () => {},
      },
    } as unknown as import('../../proxy/env').ProxyEnv;
    const result = await dispatch(
      makeHtmlGet('/admin/some-deep/path.html'),
      env,
      fakeCache,
      fakeCtx,
    );
    expect(result.response.status).toBe(200);
    expect(capturedUrl).not.toBeNull();
    expect(new URL(capturedUrl!).pathname).toBe('/admin/some-deep/path.html');
    // Specifically NOT a 301 redirect to the embed host.
    expect(result.response.headers.get('Location')).toBeNull();
  });
});
