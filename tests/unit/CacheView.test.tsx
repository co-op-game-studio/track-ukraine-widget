/**
 * Tests for src/admin/components/settings/CacheView.tsx.
 *
 * Admin ▸ Cache — KV cache inspection + purge.
 *   - GET /api/admin/cache              (overview)
 *   - GET /api/admin/cache/<slug>       (per-prefix detail)
 *   - POST /api/admin/cache/<slug>      (purge-all with reason in body)
 *   - DELETE /api/admin/cache/<slug>/<key>?reason=...  (single-key purge)
 *
 * Verifies:
 *   - Loading state, then overview render with TTL, count, "+ truncated".
 *   - Top-level fetch error renders inline error text.
 *   - Refresh button increments reload counter and re-fetches.
 *   - Expanding a row triggers a per-prefix detail fetch.
 *   - Detail fetch error renders inline error text.
 *   - "Purge all" prompts for reason, posts with reason, alerts result.
 *   - Cancelling the prompt aborts the purge.
 *   - "Purge" single-key sends DELETE with encoded reason in querystring.
 *   - Failed purge alerts the error message.
 *
 * Trace: FR-58 (cache control surface), AC-58.5 / AC-51.7.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { CacheView } from '../../src/admin/components/settings/CacheView';

const realFetch = globalThis.fetch;
const realPrompt = globalThis.prompt;
const realAlert = globalThis.alert;

interface Call {
  url: string;
  method: string;
  body: string | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const DEFAULT_OVERVIEW = {
  prefixes: [
    {
      slug: 'members',
      prefix: 'members:',
      description: 'Member profile JSON keyed by bioguide id.',
      ttlSec: 86400 * 7,
      approxCount: 535,
      truncated: false,
    },
    {
      slug: 'bills',
      prefix: 'bills:',
      description: 'Curated bill JSON keyed by bill id.',
      ttlSec: 0,
      approxCount: 5000,
      truncated: true,
    },
  ],
};

function installFetch(opts: {
  routes?: Record<string, (call: Call) => Response | Promise<Response>>;
  fallback?: (call: Call) => Response | Promise<Response>;
  capture?: Call[];
}) {
  const routes = opts.routes ?? {};
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = init?.method ?? 'GET';
    const body = (init?.body as string | undefined) ?? null;
    const call: Call = { url, method, body };
    opts.capture?.push(call);
    // Find the first matching key (substring match on URL + exact method).
    for (const key of Object.keys(routes)) {
      const [m, pattern] = key.split(' ');
      if (m === method && pattern && url.includes(pattern)) {
        return routes[key]!(call);
      }
    }
    if (opts.fallback) return opts.fallback(call);
    return new Response('not handled: ' + method + ' ' + url, { status: 404 });
  };
}

beforeEach(() => {
  // Default prompt/alert stubs — overridden per-test as needed.
  globalThis.prompt = () => null;
  globalThis.alert = () => {};
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.prompt = realPrompt;
  globalThis.alert = realAlert;
});

describe('CacheView', () => {
  it('shows loading and then renders the overview list with counts and TTL', async () => {
    installFetch({
      routes: {
        'GET /api/admin/cache': () => jsonResponse(DEFAULT_OVERVIEW),
      },
    });
    render(<CacheView />);
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('members')).toBeInTheDocument());
    expect(screen.getByText('bills')).toBeInTheDocument();
    expect(screen.getByText('members:')).toBeInTheDocument();
    expect(screen.getByText(/535 keys/)).toBeInTheDocument();
    // Bills prefix is truncated → renders "5000+ keys".
    expect(screen.getByText(/5000\+ keys/)).toBeInTheDocument();
    // TTL only renders when > 0 — members has 7d, bills has none.
    expect(screen.getByText(/TTL 7d/)).toBeInTheDocument();
    // Description always shows.
    expect(screen.getByText(/Member profile JSON/)).toBeInTheDocument();
  });

  it('renders top-level error from FetchError shape', async () => {
    installFetch({
      routes: {
        'GET /api/admin/cache': () =>
          jsonResponse({ error: 'forbidden', detail: 'no admin role' }, 403),
      },
    });
    render(<CacheView />);
    await waitFor(() => expect(screen.getByText(/no admin role/)).toBeInTheDocument());
  });

  it('refresh button re-fetches the overview', async () => {
    const calls: Call[] = [];
    installFetch({
      routes: {
        'GET /api/admin/cache': () => jsonResponse(DEFAULT_OVERVIEW),
      },
      capture: calls,
    });
    render(<CacheView />);
    await waitFor(() => expect(screen.getByText('members')).toBeInTheDocument());
    const before = calls.filter((c) => c.url.endsWith('/api/admin/cache')).length;
    fireEvent.click(screen.getByRole('button', { name: /Refresh/i }));
    await waitFor(() =>
      expect(calls.filter((c) => c.url.endsWith('/api/admin/cache')).length).toBe(before + 1),
    );
  });

  it('expanding a prefix row triggers a detail fetch and renders keys', async () => {
    installFetch({
      routes: {
        'GET /api/admin/cache/members': () =>
          jsonResponse({
            slug: 'members',
            prefix: 'members:',
            description: 'Member profile JSON keyed by bioguide id.',
            ttlSec: 86400 * 7,
            keys: ['members:D000563', 'members:S000148'],
            truncated: false,
          }),
        'GET /api/admin/cache': () => jsonResponse(DEFAULT_OVERVIEW),
      },
    });
    render(<CacheView />);
    await waitFor(() => expect(screen.getByText('members')).toBeInTheDocument());
    fireEvent.click(screen.getByText('members'));
    await waitFor(() => expect(screen.getByText('members:D000563')).toBeInTheDocument());
    expect(screen.getByText('members:S000148')).toBeInTheDocument();
    expect(screen.getByText(/Showing 2 keys/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Purge all \(2\)/i })).toBeEnabled();
  });

  it('clicking the same prefix again collapses it', async () => {
    installFetch({
      routes: {
        'GET /api/admin/cache/members': () =>
          jsonResponse({
            slug: 'members',
            prefix: 'members:',
            description: 'd',
            ttlSec: 0,
            keys: ['members:k1'],
            truncated: false,
          }),
        'GET /api/admin/cache': () => jsonResponse(DEFAULT_OVERVIEW),
      },
    });
    render(<CacheView />);
    await waitFor(() => expect(screen.getByText('members')).toBeInTheDocument());
    fireEvent.click(screen.getByText('members'));
    await waitFor(() => expect(screen.getByText('members:k1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('members'));
    await waitFor(() => expect(screen.queryByText('members:k1')).toBeNull());
  });

  it('detail fetch error renders inline danger text', async () => {
    installFetch({
      routes: {
        'GET /api/admin/cache/members': () =>
          jsonResponse({ error: 'broken', detail: 'kv stalled' }, 500),
        'GET /api/admin/cache': () => jsonResponse(DEFAULT_OVERVIEW),
      },
    });
    render(<CacheView />);
    await waitFor(() => expect(screen.getByText('members')).toBeInTheDocument());
    fireEvent.click(screen.getByText('members'));
    await waitFor(() => expect(screen.getByText(/kv stalled/)).toBeInTheDocument());
  });

  it('empty detail keys list disables Purge all and shows "No keys."', async () => {
    installFetch({
      routes: {
        'GET /api/admin/cache/members': () =>
          jsonResponse({
            slug: 'members',
            prefix: 'members:',
            description: 'd',
            ttlSec: 0,
            keys: [],
            truncated: false,
          }),
        'GET /api/admin/cache': () => jsonResponse(DEFAULT_OVERVIEW),
      },
    });
    render(<CacheView />);
    await waitFor(() => expect(screen.getByText('members')).toBeInTheDocument());
    fireEvent.click(screen.getByText('members'));
    await waitFor(() => expect(screen.getByText(/No keys\./)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Purge all \(0\)/i })).toBeDisabled();
  });

  it('truncated detail shows "(truncated; more exist)"', async () => {
    installFetch({
      routes: {
        'GET /api/admin/cache/members': () =>
          jsonResponse({
            slug: 'members',
            prefix: 'members:',
            description: 'd',
            ttlSec: 0,
            keys: ['members:a'],
            truncated: true,
          }),
        'GET /api/admin/cache': () => jsonResponse(DEFAULT_OVERVIEW),
      },
    });
    render(<CacheView />);
    await waitFor(() => expect(screen.getByText('members')).toBeInTheDocument());
    fireEvent.click(screen.getByText('members'));
    await waitFor(() => expect(screen.getByText(/Showing 1 key \(truncated; more exist\)\./)).toBeInTheDocument());
  });

  it('Purge all prompts, posts {_reason}, alerts result, and reloads overview', async () => {
    const calls: Call[] = [];
    let postSent = false;
    installFetch({
      routes: {
        'GET /api/admin/cache/members': () =>
          jsonResponse({
            slug: 'members',
            prefix: 'members:',
            description: 'd',
            ttlSec: 0,
            keys: ['members:a', 'members:b'],
            truncated: false,
          }),
        'POST /api/admin/cache/members': () => {
          postSent = true;
          return jsonResponse({ purged: 2 });
        },
        'GET /api/admin/cache': () => jsonResponse(DEFAULT_OVERVIEW),
      },
      capture: calls,
    });
    globalThis.prompt = () => 'cleanup after deploy';
    let alertMsg: string | null = null;
    globalThis.alert = (m?: unknown) => {
      alertMsg = String(m);
    };
    render(<CacheView />);
    await waitFor(() => expect(screen.getByText('members')).toBeInTheDocument());
    fireEvent.click(screen.getByText('members'));
    await waitFor(() => expect(screen.getByText('members:a')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Purge all \(2\)/i }));
    });
    await waitFor(() => expect(postSent).toBe(true));
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/admin/cache/members'));
    expect(post).toBeDefined();
    expect(JSON.parse(post!.body!)._reason).toBe('cleanup after deploy');
    await waitFor(() => expect(alertMsg).toBe('Purged 2 keys.'));
    // Reload tick should trigger an overview refetch.
    await waitFor(() =>
      expect(calls.filter((c) => c.url.endsWith('/api/admin/cache')).length).toBeGreaterThan(1),
    );
  });

  it('Purge all aborts when prompt returns null (no POST issued)', async () => {
    const calls: Call[] = [];
    installFetch({
      routes: {
        'GET /api/admin/cache/members': () =>
          jsonResponse({
            slug: 'members',
            prefix: 'members:',
            description: 'd',
            ttlSec: 0,
            keys: ['members:a'],
            truncated: false,
          }),
        'GET /api/admin/cache': () => jsonResponse(DEFAULT_OVERVIEW),
      },
      capture: calls,
    });
    globalThis.prompt = () => null;
    render(<CacheView />);
    await waitFor(() => expect(screen.getByText('members')).toBeInTheDocument());
    fireEvent.click(screen.getByText('members'));
    await waitFor(() => expect(screen.getByText('members:a')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Purge all \(1\)/i }));
    // Yield a microtask; nothing should have been POSTed.
    await Promise.resolve();
    expect(calls.find((c) => c.method === 'POST')).toBeUndefined();
  });

  it('Purge all aborts when prompt returns whitespace', async () => {
    const calls: Call[] = [];
    installFetch({
      routes: {
        'GET /api/admin/cache/members': () =>
          jsonResponse({
            slug: 'members',
            prefix: 'members:',
            description: 'd',
            ttlSec: 0,
            keys: ['members:a'],
            truncated: false,
          }),
        'GET /api/admin/cache': () => jsonResponse(DEFAULT_OVERVIEW),
      },
      capture: calls,
    });
    globalThis.prompt = () => '   ';
    render(<CacheView />);
    await waitFor(() => expect(screen.getByText('members')).toBeInTheDocument());
    fireEvent.click(screen.getByText('members'));
    await waitFor(() => expect(screen.getByText('members:a')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Purge all \(1\)/i }));
    await Promise.resolve();
    expect(calls.find((c) => c.method === 'POST')).toBeUndefined();
  });

  it('Purge all surfaces backend error via alert', async () => {
    installFetch({
      routes: {
        'GET /api/admin/cache/members': () =>
          jsonResponse({
            slug: 'members',
            prefix: 'members:',
            description: 'd',
            ttlSec: 0,
            keys: ['members:a'],
            truncated: false,
          }),
        'POST /api/admin/cache/members': () =>
          jsonResponse({ error: 'kaboom', detail: 'kv refused' }, 500),
        'GET /api/admin/cache': () => jsonResponse(DEFAULT_OVERVIEW),
      },
    });
    globalThis.prompt = () => 'try';
    let alertMsg: string | null = null;
    globalThis.alert = (m?: unknown) => {
      alertMsg = String(m);
    };
    render(<CacheView />);
    await waitFor(() => expect(screen.getByText('members')).toBeInTheDocument());
    fireEvent.click(screen.getByText('members'));
    await waitFor(() => expect(screen.getByText('members:a')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Purge all \(1\)/i }));
    });
    await waitFor(() => expect(alertMsg).toMatch(/Purge failed: kv refused/));
  });

  it('Per-key Purge sends DELETE with reason in querystring (encoded)', async () => {
    const calls: Call[] = [];
    installFetch({
      routes: {
        'GET /api/admin/cache/members': () =>
          jsonResponse({
            slug: 'members',
            prefix: 'members:',
            description: 'd',
            ttlSec: 0,
            keys: ['members:D000563'],
            truncated: false,
          }),
        'DELETE /api/admin/cache/members/D000563': () => new Response(null, { status: 204 }),
        'GET /api/admin/cache': () => jsonResponse(DEFAULT_OVERVIEW),
      },
      capture: calls,
    });
    globalThis.prompt = () => 'stale photo url';
    render(<CacheView />);
    await waitFor(() => expect(screen.getByText('members')).toBeInTheDocument());
    fireEvent.click(screen.getByText('members'));
    await waitFor(() => expect(screen.getByText('members:D000563')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Purge$/i }));
    });
    await waitFor(() => {
      const del = calls.find((c) => c.method === 'DELETE');
      expect(del).toBeDefined();
      expect(del!.url).toContain('/api/admin/cache/members/D000563');
      expect(del!.url).toContain('reason=stale%20photo%20url');
    });
  });

  it('Per-key Purge aborts when prompt returns empty', async () => {
    const calls: Call[] = [];
    installFetch({
      routes: {
        'GET /api/admin/cache/members': () =>
          jsonResponse({
            slug: 'members',
            prefix: 'members:',
            description: 'd',
            ttlSec: 0,
            keys: ['members:k'],
            truncated: false,
          }),
        'GET /api/admin/cache': () => jsonResponse(DEFAULT_OVERVIEW),
      },
      capture: calls,
    });
    globalThis.prompt = () => '';
    render(<CacheView />);
    await waitFor(() => expect(screen.getByText('members')).toBeInTheDocument());
    fireEvent.click(screen.getByText('members'));
    await waitFor(() => expect(screen.getByText('members:k')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Purge$/i }));
    await Promise.resolve();
    expect(calls.find((c) => c.method === 'DELETE')).toBeUndefined();
  });

  it('Per-key Purge surfaces backend error via alert', async () => {
    installFetch({
      routes: {
        'GET /api/admin/cache/members': () =>
          jsonResponse({
            slug: 'members',
            prefix: 'members:',
            description: 'd',
            ttlSec: 0,
            keys: ['members:k'],
            truncated: false,
          }),
        'DELETE /api/admin/cache/members/k': () =>
          jsonResponse({ error: 'no', detail: 'denied' }, 500),
        'GET /api/admin/cache': () => jsonResponse(DEFAULT_OVERVIEW),
      },
    });
    globalThis.prompt = () => 'why';
    let alertMsg: string | null = null;
    globalThis.alert = (m?: unknown) => {
      alertMsg = String(m);
    };
    render(<CacheView />);
    await waitFor(() => expect(screen.getByText('members')).toBeInTheDocument());
    fireEvent.click(screen.getByText('members'));
    await waitFor(() => expect(screen.getByText('members:k')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Purge$/i }));
    });
    await waitFor(() => expect(alertMsg).toMatch(/Purge failed: denied/));
  });

  it('top-level fetch with non-FetchError-shape rejection still renders text', async () => {
    // get() throws a FetchError object even on plain 5xx — but for coverage of the
    // typeof-object-null branch, the catch handler stringifies a non-conforming
    // object as well. Easiest: throw a plain string by making fetch itself reject.
    globalThis.fetch = async () => {
      throw 'network gone';
    };
    render(<CacheView />);
    await waitFor(() => expect(screen.getByText(/network gone/)).toBeInTheDocument());
  });
});
