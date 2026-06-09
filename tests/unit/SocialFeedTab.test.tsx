/**
 * Tests for src/admin/components/SocialFeedTab.tsx — the Social Feed admin
 * surface (Add-by-URL, Research, Feed Queue, Keywords sub-views).
 *
 * Trace:
 *   - FR-59 — social-ingest pipeline (handles, queue, polling, keywords)
 *   - CLAUDE.md "Trace IDs are user-visible on errors" — the Keywords
 *     "Add" path renders the trace ID returned by the backend.
 *
 * Conventions:
 *   - No vi.mock for the SUT. fetch is stubbed via globalThis.fetch swap
 *     and routed by URL/method, mirroring tests/unit/TagsView.test.tsx.
 *   - The MocPicker is rendered for real but we never type into it; the
 *     ResearchView is exercised only at the "no person selected" surface
 *     plus the platform-toggle / fetchFeed code paths via `selectedMoc`
 *     state we cannot reach without the MocPicker async name-search dropdown.
 *     We assert what's reachable from a clean DOM render.
 *   - useAvailablePlatforms has a module-level cache; we invalidate it
 *     between tests so each render starts from a known empty state.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { SocialFeedTab, DirectAddView, QueueView, ResearchView, KeywordsView } from '../../src/admin/components/SocialFeedTab';
import { invalidatePlatformsCache, type PlatformLiveness } from '../../src/admin/hooks/useAvailablePlatforms';

const realFetch = globalThis.fetch;

interface FetchCall { url: string; method: string; body: unknown }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makePlatform(slug: string, available = true, bulkEligible = true): PlatformLiveness {
  return { slug, available, bulkEligible, checkedAt: '2026-05-04T00:00:00Z' };
}

interface RouteHandlers {
  /** Return a Response (or null/undefined to fall through to default). */
  match: (url: string, method: string, body: unknown) => Response | Promise<Response> | null | undefined;
}

function installFetch(handler: RouteHandlers): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = null;
    if (init?.body && typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ url, method, body });
    const matched = await handler.match(url, method, body);
    if (matched) return matched;
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { calls };
}

beforeEach(() => {
  invalidatePlatformsCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  invalidatePlatformsCache();
});

/* ========================================================================== */
/* SocialFeedTab — sub-nav                                                    */
/* ========================================================================== */

describe('SocialFeedTab — sub-nav', () => {
  it('renders all four sub-tab buttons', () => {
    installFetch({ match: () => null });
    render(<SocialFeedTab />);
    expect(screen.getByRole('button', { name: /Add by URL/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Research/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Feed Queue/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Keywords/ })).toBeInTheDocument();
  });

  it('defaults to the Add-by-URL view (DirectAddView is rendered)', () => {
    installFetch({ match: () => null });
    render(<SocialFeedTab />);
    expect(screen.getByPlaceholderText(/Paste a social media URL/i)).toBeInTheDocument();
  });

  it('switches to the Keywords view when its tab is clicked', async () => {
    installFetch({
      match: (url) => {
        if (url.includes('/api/admin/ingest/keywords')) {
          return jsonResponse({ items: [] });
        }
        return null;
      },
    });
    render(<SocialFeedTab />);
    fireEvent.click(screen.getByRole('button', { name: /Keywords/ }));
    expect(screen.getByPlaceholderText(/Watch name/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Loading keywords/i)).not.toBeInTheDocument(), { timeout: 3000 });
  });

  it('switches to the Feed Queue view when its tab is clicked', async () => {
    installFetch({
      match: (url) => {
        if (url.includes('/api/admin/ingest/platforms')) return jsonResponse({ platforms: [] });
        if (url.includes('/api/admin/config')) return jsonResponse({ pollConcurrency: 2 });
        if (url.includes('/api/admin/ingest/queue')) return jsonResponse({ items: [], total: 0 });
        return null;
      },
    });
    render(<SocialFeedTab />);
    fireEvent.click(screen.getByRole('button', { name: /Feed Queue/ }));
    await waitFor(() => expect(screen.queryByText(/Loading queue/i)).not.toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText(/Sync Social Feeds/i)).toBeInTheDocument();
    expect(screen.getByText(/0 items total/i)).toBeInTheDocument();
  });

  it('switches to the Research view when its tab is clicked', () => {
    installFetch({
      match: (url) => {
        if (url.includes('/api/admin/ingest/platforms')) return jsonResponse({ platforms: [] });
        return null;
      },
    });
    render(<SocialFeedTab />);
    fireEvent.click(screen.getByRole('button', { name: /Research/ }));
    expect(screen.getByPlaceholderText(/Select person to research/i)).toBeInTheDocument();
  });
});

/* ========================================================================== */
/* DirectAddView — fetch-by-URL flow                                          */
/* ========================================================================== */

describe('DirectAddView — fetch-post', () => {
  it('renders the URL input and Fetch button', () => {
    installFetch({ match: () => null });
    render(<DirectAddView />);
    expect(screen.getByPlaceholderText(/Paste a social media URL/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Fetch$/ })).toBeInTheDocument();
  });

  it('does nothing when the input is blank', () => {
    const stub = installFetch({ match: () => null });
    render(<DirectAddView />);
    fireEvent.click(screen.getByRole('button', { name: /^Fetch$/ }));
    // No fetch calls yet (only clicks against an empty input).
    expect(stub.calls.length).toBe(0);
  });

  it('rejects an invalid URL with a friendly error', async () => {
    const stub = installFetch({ match: () => null });
    render(<DirectAddView />);
    const input = screen.getByPlaceholderText(/Paste a social media URL/i);
    fireEvent.change(input, { target: { value: 'not a url' } });
    fireEvent.click(screen.getByRole('button', { name: /^Fetch$/ }));
    expect(await screen.findByText(/Enter a valid URL/i)).toBeInTheDocument();
    expect(stub.calls.length).toBe(0);
  });

  it('POSTs to /api/admin/ingest/fetch-post and renders the preview card', async () => {
    const stub = installFetch({
      match: (url, method) => {
        if (url.endsWith('/api/admin/ingest/fetch-post') && method === 'POST') {
          return jsonResponse({
            post: {
              platform: 'bluesky',
              platformPostId: 'pid-1',
              authorHandle: 'rep.example.com',
              authorPlatformId: 'did:1',
              postedAt: '2026-04-30T10:00:00Z',
              url: 'https://bsky.app/profile/rep.example.com/post/abc',
              bodyText: 'Standing with Ukraine. Vote yes on supplemental.',
              mediaRefs: [],
            },
            moc: { bioguideId: 'A000001', handle: 'rep.example.com', displayName: 'Rep. Alpha' },
          });
        }
        return null;
      },
    });
    render(<DirectAddView />);
    const input = screen.getByPlaceholderText(/Paste a social media URL/i);
    fireEvent.change(input, { target: { value: 'https://bsky.app/profile/rep.example.com/post/abc' } });
    fireEvent.click(screen.getByRole('button', { name: /^Fetch$/ }));
    await waitFor(() => expect(screen.getByText(/Standing with Ukraine/i)).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText(/Bluesky/i)).toBeInTheDocument();
    expect(screen.getByText(/@rep\.example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/Rep\. Alpha/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add to queue/i })).toBeInTheDocument();
    // Exactly one POST to fetch-post.
    expect(stub.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/admin/ingest/fetch-post')).length).toBe(1);
  });

  it('submits on Enter key in the URL input', async () => {
    const stub = installFetch({
      match: (url) => {
        if (url.endsWith('/api/admin/ingest/fetch-post')) {
          return jsonResponse({
            post: {
              platform: 'bluesky', platformPostId: 'p', authorHandle: 'h', authorPlatformId: 'd',
              postedAt: '2026-04-30T10:00:00Z', url: 'https://bsky.app/x', bodyText: 'b', mediaRefs: [],
            },
            moc: null,
          });
        }
        return null;
      },
    });
    render(<DirectAddView />);
    const input = screen.getByPlaceholderText(/Paste a social media URL/i);
    fireEvent.change(input, { target: { value: 'https://bsky.app/profile/x/post/y' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(stub.calls.some((c) => c.url.endsWith('/api/admin/ingest/fetch-post'))).toBe(true), { timeout: 3000 });
  });

  it('translates "no adapter" backend errors to a Quotes-tab hint', async () => {
    installFetch({
      match: (url) => {
        if (url.endsWith('/api/admin/ingest/fetch-post')) {
          return jsonResponse({ error: 'unsupported_platform', detail: 'no adapter for tiktok' }, 400);
        }
        return null;
      },
    });
    render(<DirectAddView />);
    fireEvent.change(screen.getByPlaceholderText(/Paste a social media URL/i), { target: { value: 'https://tiktok.com/@x/123' } });
    fireEvent.click(screen.getByRole('button', { name: /^Fetch$/ }));
    expect(await screen.findByText(/not supported for auto-fetch/i)).toBeInTheDocument();
  });

  it('shows the raw backend detail for other failures', async () => {
    installFetch({
      match: (url) => {
        if (url.endsWith('/api/admin/ingest/fetch-post')) {
          return jsonResponse({ error: 'fetch_failed', detail: 'upstream 404' }, 502);
        }
        return null;
      },
    });
    render(<DirectAddView />);
    fireEvent.change(screen.getByPlaceholderText(/Paste a social media URL/i), { target: { value: 'https://bsky.app/profile/x/post/y' } });
    fireEvent.click(screen.getByRole('button', { name: /^Fetch$/ }));
    expect(await screen.findByText(/upstream 404/)).toBeInTheDocument();
  });

  it('enqueues the previewed post and shows a success card', async () => {
    const stub = installFetch({
      match: (url) => {
        if (url.endsWith('/api/admin/ingest/fetch-post')) {
          return jsonResponse({
            post: {
              platform: 'bluesky', platformPostId: 'pid-1', authorHandle: 'rep.example.com',
              authorPlatformId: 'did:1', postedAt: '2026-04-30T10:00:00Z',
              url: 'https://bsky.app/profile/rep.example.com/post/abc',
              bodyText: 'Hi', mediaRefs: [],
            },
            moc: null,
          });
        }
        if (url.endsWith('/api/admin/ingest/queue') && /POST/.test('POST')) {
          return jsonResponse({ row: { id: 'q-1' }, deduped: false }, 201);
        }
        return null;
      },
    });
    render(<DirectAddView />);
    fireEvent.change(screen.getByPlaceholderText(/Paste a social media URL/i), { target: { value: 'https://bsky.app/profile/rep.example.com/post/abc' } });
    fireEvent.click(screen.getByRole('button', { name: /^Fetch$/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Add to queue/i })).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /Add to queue/i }));
    await waitFor(() => expect(screen.getByText(/Added to queue/i)).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByRole('button', { name: /Add another/i })).toBeInTheDocument();
    // Verify the enqueue POST was issued with shape we expect.
    const enqueue = stub.calls.find((c) => c.url.endsWith('/api/admin/ingest/queue') && c.method === 'POST');
    expect(enqueue).toBeDefined();
    const body = enqueue!.body as Record<string, unknown>;
    expect(body.platform).toBe('bluesky');
    expect(body.status).toBe('pending');
    expect(body.platform_post_id).toBe('pid-1');
  });

  it('Clear button resets the preview card', async () => {
    installFetch({
      match: (url) => {
        if (url.endsWith('/api/admin/ingest/fetch-post')) {
          return jsonResponse({
            post: {
              platform: 'bluesky', platformPostId: 'p', authorHandle: 'h', authorPlatformId: 'd',
              postedAt: '2026-04-30T10:00:00Z', url: 'https://bsky.app/x', bodyText: 'preview body', mediaRefs: [],
            },
            moc: null,
          });
        }
        return null;
      },
    });
    render(<DirectAddView />);
    fireEvent.change(screen.getByPlaceholderText(/Paste a social media URL/i), { target: { value: 'https://bsky.app/profile/x/post/y' } });
    fireEvent.click(screen.getByRole('button', { name: /^Fetch$/ }));
    await waitFor(() => expect(screen.getByText(/preview body/)).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /^Clear$/ }));
    await waitFor(() => expect(screen.queryByText(/preview body/)).not.toBeInTheDocument(), { timeout: 3000 });
  });

  it('Add another after enqueue restores the input UI', async () => {
    installFetch({
      match: (url) => {
        if (url.endsWith('/api/admin/ingest/fetch-post')) {
          return jsonResponse({
            post: {
              platform: 'bluesky', platformPostId: 'p', authorHandle: 'h', authorPlatformId: 'd',
              postedAt: '2026-04-30T10:00:00Z', url: 'https://bsky.app/x', bodyText: 'b', mediaRefs: [],
            }, moc: null,
          });
        }
        if (url.endsWith('/api/admin/ingest/queue')) {
          return jsonResponse({ row: { id: 'q' }, deduped: false }, 201);
        }
        return null;
      },
    });
    render(<DirectAddView />);
    fireEvent.change(screen.getByPlaceholderText(/Paste a social media URL/i), { target: { value: 'https://bsky.app/profile/x/post/y' } });
    fireEvent.click(screen.getByRole('button', { name: /^Fetch$/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Add to queue/i })).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /Add to queue/i }));
    await waitFor(() => expect(screen.getByText(/Added to queue/i)).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /Add another/i }));
    await waitFor(() => expect(screen.queryByText(/Added to queue/i)).not.toBeInTheDocument(), { timeout: 3000 });
  });

  it('renders the enqueue error inline if the queue POST fails', async () => {
    installFetch({
      match: (url) => {
        if (url.endsWith('/api/admin/ingest/fetch-post')) {
          return jsonResponse({
            post: {
              platform: 'bluesky', platformPostId: 'p', authorHandle: 'h', authorPlatformId: 'd',
              postedAt: '2026-04-30T10:00:00Z', url: 'https://bsky.app/x', bodyText: 'b', mediaRefs: [],
            }, moc: null,
          });
        }
        if (url.endsWith('/api/admin/ingest/queue')) {
          return jsonResponse({ error: 'invalid_post', detail: 'platform_post_id required' }, 400);
        }
        return null;
      },
    });
    render(<DirectAddView />);
    fireEvent.change(screen.getByPlaceholderText(/Paste a social media URL/i), { target: { value: 'https://bsky.app/profile/x/post/y' } });
    fireEvent.click(screen.getByRole('button', { name: /^Fetch$/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Add to queue/i })).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /Add to queue/i }));
    expect(await screen.findByText(/platform_post_id required/i)).toBeInTheDocument();
  });
});

/* ========================================================================== */
/* QueueView — list + filters                                                 */
/* ========================================================================== */

interface QueueRow {
  id: string;
  bioguide_id: string | null;
  platform: string;
  platform_post_id: string;
  author_handle: string;
  posted_at: string;
  url: string;
  body_text: string;
  media_refs_json: string;
  ingested_at: string;
  status: string;
  matched_keywords: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

function makeQueueRow(overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    id: overrides.id ?? 'q-1',
    bioguide_id: overrides.bioguide_id ?? null,
    platform: overrides.platform ?? 'bluesky',
    platform_post_id: overrides.platform_post_id ?? 'pid-1',
    author_handle: overrides.author_handle ?? 'rep.example.com',
    posted_at: overrides.posted_at ?? '2026-04-30T10:00:00Z',
    url: overrides.url ?? 'https://bsky.app/x',
    body_text: overrides.body_text ?? 'queue body',
    media_refs_json: overrides.media_refs_json ?? '[]',
    ingested_at: overrides.ingested_at ?? '2026-05-01T00:00:00Z',
    status: overrides.status ?? 'pending',
    matched_keywords: overrides.matched_keywords ?? null,
    reviewed_by: overrides.reviewed_by ?? null,
    reviewed_at: overrides.reviewed_at ?? null,
  };
}

describe('QueueView — list + filters', () => {
  it('shows a loading state then renders the queue list', async () => {
    const items = [makeQueueRow({ id: 'q-1', body_text: 'first item' })];
    installFetch({
      match: (url) => {
        if (url.includes('/api/admin/ingest/platforms')) return jsonResponse({ platforms: [] });
        if (url.includes('/api/admin/config')) return jsonResponse({ pollConcurrency: 2 });
        if (url.includes('/api/admin/ingest/queue')) return jsonResponse({ items, total: 1 });
        return null;
      },
    });
    render(<QueueView />);
    await waitFor(() => expect(screen.queryByText(/Loading queue/i)).not.toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText(/first item/)).toBeInTheDocument();
    expect(screen.getByText(/1 items total/)).toBeInTheDocument();
  });

  it('renders the bioguide link when an item has bioguide_id', async () => {
    installFetch({
      match: (url) => {
        if (url.includes('/api/admin/ingest/platforms')) return jsonResponse({ platforms: [] });
        if (url.includes('/api/admin/config')) return jsonResponse({ pollConcurrency: 2 });
        if (url.includes('/api/admin/ingest/queue')) {
          return jsonResponse({ items: [makeQueueRow({ id: 'q-2', bioguide_id: 'A000001', body_text: 'rep post' })], total: 1 });
        }
        return null;
      },
    });
    render(<QueueView />);
    await waitFor(() => expect(screen.getByText(/rep post/)).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText(/A000001/)).toBeInTheDocument();
  });

  it('renders matched keyword chips', async () => {
    installFetch({
      match: (url) => {
        if (url.includes('/api/admin/ingest/platforms')) return jsonResponse({ platforms: [] });
        if (url.includes('/api/admin/config')) return jsonResponse({ pollConcurrency: 2 });
        if (url.includes('/api/admin/ingest/queue')) {
          return jsonResponse({
            items: [makeQueueRow({ id: 'q-3', body_text: 'kw post', matched_keywords: JSON.stringify(['ukraine', 'aid']) })],
            total: 1,
          });
        }
        return null;
      },
    });
    render(<QueueView />);
    await waitFor(() => expect(screen.getByText(/kw post/)).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText('ukraine')).toBeInTheDocument();
    expect(screen.getByText('aid')).toBeInTheDocument();
  });

  it('refetches with status filter when the dropdown changes', async () => {
    const stub = installFetch({
      match: (url) => {
        if (url.includes('/api/admin/ingest/platforms')) return jsonResponse({ platforms: [] });
        if (url.includes('/api/admin/config')) return jsonResponse({ pollConcurrency: 2 });
        if (url.includes('/api/admin/ingest/queue')) return jsonResponse({ items: [], total: 0 });
        return null;
      },
    });
    render(<QueueView />);
    await waitFor(() => expect(screen.queryByText(/Loading queue/i)).not.toBeInTheDocument(), { timeout: 3000 });
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'curated' } });
    await waitFor(() =>
      expect(stub.calls.some((c) => c.url.includes('status=curated'))).toBe(true),
      { timeout: 3000 },
    );
  });

  it('refetches with keywordMatch=true when "Keyword matches only" is checked', async () => {
    const stub = installFetch({
      match: (url) => {
        if (url.includes('/api/admin/ingest/platforms')) return jsonResponse({ platforms: [] });
        if (url.includes('/api/admin/config')) return jsonResponse({ pollConcurrency: 2 });
        if (url.includes('/api/admin/ingest/queue')) return jsonResponse({ items: [], total: 0 });
        return null;
      },
    });
    render(<QueueView />);
    await waitFor(() => expect(screen.queryByText(/Loading queue/i)).not.toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByLabelText(/Keyword matches only/i));
    await waitFor(() =>
      expect(stub.calls.some((c) => c.url.includes('keywordMatch=true'))).toBe(true),
      { timeout: 3000 },
    );
  });

  it('PATCHes /api/admin/ingest/queue/:id when Curate is clicked (no curate handler)', async () => {
    let queueItems = [makeQueueRow({ id: 'q-7', body_text: 'curate me' })];
    const stub = installFetch({
      match: (url, method) => {
        if (url.includes('/api/admin/ingest/platforms')) return jsonResponse({ platforms: [] });
        if (url.includes('/api/admin/config')) return jsonResponse({ pollConcurrency: 2 });
        const patchMatch = /\/api\/admin\/ingest\/queue\/([^/?]+)$/.exec(url);
        if (patchMatch && method === 'PATCH') {
          queueItems = queueItems.filter((i) => i.id !== patchMatch[1]);
          return jsonResponse({ ok: true });
        }
        if (url.includes('/api/admin/ingest/queue')) {
          return jsonResponse({ items: queueItems, total: queueItems.length });
        }
        return null;
      },
    });
    render(<QueueView />);
    await waitFor(() => expect(screen.getByText(/curate me/)).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /^Curate$/ }));
    await waitFor(() =>
      expect(stub.calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/api/admin/ingest/queue/q-7'))).toBe(true),
      { timeout: 3000 },
    );
  });

  it('PATCHes status=dismissed when Dismiss is clicked', async () => {
    const stub = installFetch({
      match: (url, method) => {
        if (url.includes('/api/admin/ingest/platforms')) return jsonResponse({ platforms: [] });
        if (url.includes('/api/admin/config')) return jsonResponse({ pollConcurrency: 2 });
        if (/\/api\/admin\/ingest\/queue\/[^/?]+$/.test(url) && method === 'PATCH') {
          return jsonResponse({ ok: true });
        }
        if (url.includes('/api/admin/ingest/queue')) {
          return jsonResponse({ items: [makeQueueRow({ id: 'q-8' })], total: 1 });
        }
        return null;
      },
    });
    render(<QueueView />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Dismiss/ })).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }));
    await waitFor(() => {
      const dismissCall = stub.calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/api/admin/ingest/queue/q-8'));
      expect(dismissCall).toBeDefined();
      expect((dismissCall!.body as Record<string, unknown>).status).toBe('dismissed');
    }, { timeout: 3000 });
  });

  it('uses onCurateAsQuote handoff when supplied (no PATCH happens for "Curate as Quote")', async () => {
    let prefill: { bioguideId: string | null; queueItemId: string } | null = null;
    const stub = installFetch({
      match: (url) => {
        if (url.includes('/api/admin/ingest/platforms')) return jsonResponse({ platforms: [] });
        if (url.includes('/api/admin/config')) return jsonResponse({ pollConcurrency: 2 });
        if (url.includes('/api/admin/ingest/queue')) {
          return jsonResponse({ items: [makeQueueRow({ id: 'q-9', bioguide_id: 'A000001', body_text: 'curate-as-quote me' })], total: 1 });
        }
        return null;
      },
    });
    render(<QueueView onCurateAsQuote={(p) => { prefill = p; }} />);
    await waitFor(() => expect(screen.getByText(/curate-as-quote me/)).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /Curate as Quote/i }));
    expect(prefill).not.toBeNull();
    expect(prefill!.queueItemId).toBe('q-9');
    expect(prefill!.bioguideId).toBe('A000001');
    // No PATCH was sent — the handoff defers state change to AddQuoteView.
    expect(stub.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});

/* ========================================================================== */
/* QueueView — poll controls                                                  */
/* ========================================================================== */

describe('QueueView — poll controls', () => {
  it('renders bulk-eligible platform toggles from /api/admin/ingest/platforms', async () => {
    installFetch({
      match: (url) => {
        if (url.includes('/api/admin/ingest/platforms')) {
          return jsonResponse({
            platforms: [
              makePlatform('bluesky', true, true),
              makePlatform('mastodon', true, true),
            ],
          });
        }
        if (url.includes('/api/admin/config')) return jsonResponse({ pollConcurrency: 2 });
        if (url.includes('/api/admin/ingest/queue')) return jsonResponse({ items: [], total: 0 });
        return null;
      },
    });
    render(<QueueView />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Bluesky/ })).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByRole('button', { name: /Mastodon/ })).toBeInTheDocument();
    // Auto-defaults to all bulk-eligible platforms enabled → "Poll all".
    await waitFor(() => expect(screen.getByRole('button', { name: /Sync all/i })).toBeInTheDocument(), { timeout: 3000 });
  });

  it('disables non-bulk-eligible platforms with a 🔒 marker', async () => {
    installFetch({
      match: (url) => {
        if (url.includes('/api/admin/ingest/platforms')) {
          return jsonResponse({
            platforms: [
              makePlatform('bluesky', true, true),
              makePlatform('youtube', true, false),
            ],
          });
        }
        if (url.includes('/api/admin/config')) return jsonResponse({ pollConcurrency: 2 });
        if (url.includes('/api/admin/ingest/queue')) return jsonResponse({ items: [], total: 0 });
        return null;
      },
    });
    render(<QueueView />);
    const yt = await waitFor(() => screen.getByRole('button', { name: /YouTube/ }), { timeout: 3000 });
    expect(yt).toBeDisabled();
    // The lock glyph appears inside the button.
    expect(within(yt).getByText('🔒')).toBeInTheDocument();
  });

  it('toggling a platform off changes the Poll button label', async () => {
    installFetch({
      match: (url) => {
        if (url.includes('/api/admin/ingest/platforms')) {
          return jsonResponse({
            platforms: [
              makePlatform('bluesky', true, true),
              makePlatform('mastodon', true, true),
            ],
          });
        }
        if (url.includes('/api/admin/config')) return jsonResponse({ pollConcurrency: 2 });
        if (url.includes('/api/admin/ingest/queue')) return jsonResponse({ items: [], total: 0 });
        return null;
      },
    });
    render(<QueueView />);
    // Wait for the platform toggles to render — that's our signal that the
    // init effect has fired and enabledPlatforms is populated.
    const mastodonBtn = await screen.findByRole('button', { name: /^Mastodon$/i }, { timeout: 3000 });
    // Initially everything bulk-eligible is enabled → "Poll all platforms".
    await waitFor(() => expect(screen.getByRole('button', { name: /^Sync all platforms$/i })).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(mastodonBtn);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Sync 1 platform$/i })).toBeInTheDocument(), { timeout: 3000 });
  });

  it('runs the poll loop end-to-end with a single OK handle and shows the summary', async () => {
    installFetch({
      match: (url, method) => {
        if (url.includes('/api/admin/ingest/platforms')) {
          return jsonResponse({ platforms: [makePlatform('bluesky', true, true)] });
        }
        if (url.includes('/api/admin/config')) return jsonResponse({ pollConcurrency: 1 });
        if (url.includes('/api/admin/ingest/handles') && method === 'GET') {
          return jsonResponse({
            items: [{
              id: 'h-1', platform: 'bluesky', handle: 'rep.example.com', display_name: 'Rep Alpha',
              bioguide_id: 'A000001', last_polled_at: null, last_seen_post_id: null,
            }],
          });
        }
        if (url.endsWith('/api/admin/ingest/poll-handle') && method === 'POST') {
          return jsonResponse({
            handle: 'rep.example.com', platform: 'bluesky', bioguideId: 'A000001',
            displayName: 'Rep Alpha', lastPolledAt: null, skipped: false,
            newPosts: 2, duplicates: 0, keywordMatches: 1, error: null,
          });
        }
        if (url.includes('/api/admin/ingest/queue')) return jsonResponse({ items: [], total: 0 });
        return null;
      },
    });
    render(<QueueView />);
    // Wait for the platform toggle to mount — that's the signal that the
    // bulkEligibleSet useEffect has fired and the Poll button is enabled.
    await screen.findByRole('button', { name: /^Bluesky$/i }, { timeout: 3000 });
    const pollBtn = await waitFor(
      () => screen.getByRole('button', { name: /^Sync all platform$/i }),
      { timeout: 3000 },
    );
    fireEvent.click(pollBtn);
    // Summary line appears once polling finishes ("1 polled" / "1 ok").
    await waitFor(() => expect(screen.getByText(/1 synced/)).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.getByText(/1 ok/)).toBeInTheDocument();
  });

  it('shows "No handles to poll." when handles list is empty', async () => {
    installFetch({
      match: (url, method) => {
        if (url.includes('/api/admin/ingest/platforms')) {
          return jsonResponse({ platforms: [makePlatform('bluesky', true, true)] });
        }
        if (url.includes('/api/admin/config')) return jsonResponse({ pollConcurrency: 1 });
        if (url.includes('/api/admin/ingest/handles') && method === 'GET') {
          return jsonResponse({ items: [] });
        }
        if (url.includes('/api/admin/ingest/queue')) return jsonResponse({ items: [], total: 0 });
        return null;
      },
    });
    render(<QueueView />);
    await screen.findByRole('button', { name: /^Bluesky$/i }, { timeout: 3000 });
    const pollBtn = await waitFor(
      () => screen.getByRole('button', { name: /^Sync all platform$/i }),
      { timeout: 3000 },
    );
    fireEvent.click(pollBtn);
    await waitFor(() => expect(screen.getByText(/No handles to poll/i)).toBeInTheDocument(), { timeout: 5000 });
  });

  it('surfaces a poll-handle error in the live log', async () => {
    installFetch({
      match: (url, method) => {
        if (url.includes('/api/admin/ingest/platforms')) {
          return jsonResponse({ platforms: [makePlatform('bluesky', true, true)] });
        }
        if (url.includes('/api/admin/config')) return jsonResponse({ pollConcurrency: 1 });
        if (url.includes('/api/admin/ingest/handles') && method === 'GET') {
          return jsonResponse({
            items: [{
              id: 'h-1', platform: 'bluesky', handle: 'rep.example.com', display_name: null,
              bioguide_id: null, last_polled_at: null, last_seen_post_id: null,
            }],
          });
        }
        if (url.endsWith('/api/admin/ingest/poll-handle') && method === 'POST') {
          return jsonResponse({
            handle: 'rep.example.com', platform: 'bluesky', bioguideId: null,
            displayName: null, lastPolledAt: null, skipped: false,
            newPosts: 0, duplicates: 0, keywordMatches: 0, error: 'rate-limit-from-upstream',
          });
        }
        if (url.includes('/api/admin/ingest/queue')) return jsonResponse({ items: [], total: 0 });
        return null;
      },
    });
    render(<QueueView />);
    await screen.findByRole('button', { name: /^Bluesky$/i }, { timeout: 3000 });
    const pollBtn = await waitFor(
      () => screen.getByRole('button', { name: /^Sync all platform$/i }),
      { timeout: 3000 },
    );
    fireEvent.click(pollBtn);
    await waitFor(() => expect(screen.getByText(/rate-limit-from-upstream/)).toBeInTheDocument(), { timeout: 5000 });
    // 1 failed in the summary.
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
  });

  it('renders the "skipped" outcome (backend gates a recently-polled handle)', async () => {
    installFetch({
      match: (url, method) => {
        if (url.includes('/api/admin/ingest/platforms')) {
          return jsonResponse({ platforms: [makePlatform('bluesky', true, true)] });
        }
        if (url.includes('/api/admin/config')) return jsonResponse({ pollConcurrency: 1 });
        if (url.includes('/api/admin/ingest/handles') && method === 'GET') {
          return jsonResponse({
            items: [{
              id: 'h-1', platform: 'bluesky', handle: 'h', display_name: null,
              bioguide_id: null, last_polled_at: null, last_seen_post_id: null,
            }],
          });
        }
        if (url.endsWith('/api/admin/ingest/poll-handle') && method === 'POST') {
          return jsonResponse({
            handle: 'h', platform: 'bluesky', bioguideId: null, displayName: null,
            lastPolledAt: null, skipped: true, skipReason: 'polled 2m ago',
            newPosts: 0, duplicates: 0, keywordMatches: 0, error: null,
          });
        }
        if (url.includes('/api/admin/ingest/queue')) return jsonResponse({ items: [], total: 0 });
        return null;
      },
    });
    render(<QueueView />);
    await screen.findByRole('button', { name: /^Bluesky$/i }, { timeout: 3000 });
    const pollBtn = await waitFor(
      () => screen.getByRole('button', { name: /^Sync all platform$/i }),
      { timeout: 3000 },
    );
    fireEvent.click(pollBtn);
    await waitFor(() => expect(screen.getByText(/polled 2m ago/)).toBeInTheDocument(), { timeout: 5000 });
    // Summary line only renders when polling completes; wait for it.
    await waitFor(() => expect(screen.getByText(/skipped \(cached\)/i)).toBeInTheDocument(), { timeout: 5000 });
  });

  it('Clear log button removes the live log after a run', async () => {
    installFetch({
      match: (url, method) => {
        if (url.includes('/api/admin/ingest/platforms')) {
          return jsonResponse({ platforms: [makePlatform('bluesky', true, true)] });
        }
        if (url.includes('/api/admin/config')) return jsonResponse({ pollConcurrency: 1 });
        if (url.includes('/api/admin/ingest/handles') && method === 'GET') {
          return jsonResponse({ items: [] });
        }
        if (url.includes('/api/admin/ingest/queue')) return jsonResponse({ items: [], total: 0 });
        return null;
      },
    });
    render(<QueueView />);
    await screen.findByRole('button', { name: /^Bluesky$/i }, { timeout: 3000 });
    const pollBtn = await waitFor(
      () => screen.getByRole('button', { name: /^Sync all platform$/i }),
      { timeout: 3000 },
    );
    fireEvent.click(pollBtn);
    await waitFor(() => expect(screen.getByText(/No handles to poll/i)).toBeInTheDocument(), { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: /Clear log/i }));
    await waitFor(() => expect(screen.queryByText(/No handles to poll/i)).not.toBeInTheDocument(), { timeout: 3000 });
  });
});

/* ========================================================================== */
/* ResearchView — picker / no-handle states                                   */
/* ========================================================================== */

describe('ResearchView — empty state', () => {
  it('renders the MoC picker before any selection', () => {
    installFetch({
      match: (url) => {
        if (url.includes('/api/admin/ingest/platforms')) return jsonResponse({ platforms: [] });
        return null;
      },
    });
    render(<ResearchView />);
    expect(screen.getByPlaceholderText(/Select person to research/i)).toBeInTheDocument();
  });

  it('does not render platform toggles or Fetch button until a person is selected', () => {
    installFetch({
      match: (url) => {
        if (url.includes('/api/admin/ingest/platforms')) {
          return jsonResponse({ platforms: [makePlatform('bluesky', true, true)] });
        }
        return null;
      },
    });
    render(<ResearchView />);
    expect(screen.queryByRole('button', { name: /Fetch feed/i })).not.toBeInTheDocument();
    // The Bluesky toggle inside ResearchView only renders for linked handles.
    expect(screen.queryByRole('button', { name: /^Bluesky$/ })).not.toBeInTheDocument();
  });
});

/* ========================================================================== */
/* ResearchView — picker → fetch feed → curate flow                           */
/* ========================================================================== */

/**
 * Drives the MocPicker typeahead end-to-end so the ResearchView's
 * `selectedMoc` branch is exercised: handle list, platform toggles,
 * fetchFeed POST, and per-card curatePost handoff.
 *
 * The MocPicker uses a real 200ms setTimeout debounce, so these tests
 * use real timers and waitFor with a longer timeout to span the debounce.
 */

interface NameSearchEntry {
  bioguideId: string;
  displayName: string;
  first: string;
  last: string;
  state: string;
  chamber: 'House' | 'Senate';
  district: number | null;
  party: string;
  photoUrl: string | null;
}

function makeNameSearchEntry(overrides: Partial<NameSearchEntry> = {}): NameSearchEntry {
  return {
    bioguideId: overrides.bioguideId ?? 'A000001',
    displayName: overrides.displayName ?? 'Alice Adams',
    first: overrides.first ?? 'Alice',
    last: overrides.last ?? 'Adams',
    state: overrides.state ?? 'CA',
    chamber: overrides.chamber ?? 'House',
    district: overrides.district ?? 12,
    party: overrides.party ?? 'D',
    photoUrl: overrides.photoUrl ?? null,
  };
}

/**
 * Drive the typeahead: type the query, wait for the debounced fetch
 * + dropdown render, then click the result. Returns once `selectedMoc`
 * is set in ResearchView (which we detect by waiting for the handles
 * effect to settle).
 */
async function selectPersonViaPicker(displayName: string): Promise<void> {
  const input = screen.getByPlaceholderText(/Select person to research/i);
  fireEvent.change(input, { target: { value: 'al' } });
  // Wait past the 200ms debounce + fetch resolution + dropdown render.
  await waitFor(() => expect(screen.getByText(displayName)).toBeInTheDocument(), { timeout: 5000 });
  fireEvent.click(screen.getByText(displayName));
}

describe('ResearchView — typeahead-driven flow', () => {
  it('selecting a person fetches their handles and renders linked-platform toggles', async () => {
    const stub = installFetch({
      match: (url) => {
        if (url.includes('/api/admin/ingest/platforms')) {
          return jsonResponse({
            platforms: [makePlatform('bluesky', true, true), makePlatform('mastodon', true, true)],
          });
        }
        if (url.includes('/api/name-search')) {
          return jsonResponse({ results: [makeNameSearchEntry()] });
        }
        if (url.includes('/api/admin/ingest/handles')) {
          return jsonResponse({
            items: [
              { platform: 'bluesky', handle: 'alice.bsky.social', bioguide_id: 'A000001' },
              { platform: 'mastodon', handle: 'alice@m.example', bioguide_id: 'A000001' },
              // Different person — should not surface.
              { platform: 'bluesky', handle: 'other.bsky.social', bioguide_id: 'B999999' },
            ],
          });
        }
        return null;
      },
    });
    render(<ResearchView />);
    await selectPersonViaPicker('Alice Adams');
    // Both linked platform toggles render (filtered to availableSet).
    await waitFor(
      () => expect(screen.getByRole('button', { name: /^Bluesky$/ })).toBeInTheDocument(),
      { timeout: 5000 },
    );
    expect(screen.getByRole('button', { name: /^Mastodon$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fetch feed/i })).toBeInTheDocument();
    // Handles call was issued.
    expect(stub.calls.some((c) => c.url.includes('/api/admin/ingest/handles'))).toBe(true);
  });

  it('shows the no-handle message when the selected person has no linked handles', async () => {
    installFetch({
      match: (url) => {
        if (url.includes('/api/admin/ingest/platforms')) {
          return jsonResponse({ platforms: [makePlatform('bluesky', true, true)] });
        }
        if (url.includes('/api/name-search')) {
          return jsonResponse({ results: [makeNameSearchEntry({ displayName: 'Alice Adams' })] });
        }
        if (url.includes('/api/admin/ingest/handles')) {
          return jsonResponse({ items: [] });
        }
        return null;
      },
    });
    render(<ResearchView />);
    await selectPersonViaPicker('Alice Adams');
    await waitFor(
      () => expect(screen.getByText(/No social handles linked/i)).toBeInTheDocument(),
      { timeout: 5000 },
    );
    // No fetch button when no platforms are linked.
    expect(screen.queryByRole('button', { name: /Fetch feed/i })).not.toBeInTheDocument();
  });

  it('toggling a platform changes the activePlatforms set (off then on)', async () => {
    installFetch({
      match: (url) => {
        if (url.includes('/api/admin/ingest/platforms')) {
          return jsonResponse({
            platforms: [makePlatform('bluesky', true, true), makePlatform('mastodon', true, true)],
          });
        }
        if (url.includes('/api/name-search')) {
          return jsonResponse({ results: [makeNameSearchEntry()] });
        }
        if (url.includes('/api/admin/ingest/handles')) {
          return jsonResponse({
            items: [
              { platform: 'bluesky', handle: 'alice.bsky.social', bioguide_id: 'A000001' },
              { platform: 'mastodon', handle: 'alice@m.example', bioguide_id: 'A000001' },
            ],
          });
        }
        return null;
      },
    });
    render(<ResearchView />);
    await selectPersonViaPicker('Alice Adams');
    const blueskyBtn = await waitFor(
      () => screen.getByRole('button', { name: /^Bluesky$/ }),
      { timeout: 5000 },
    );
    // Toggle off then back on — drives both branches of togglePlatform.
    fireEvent.click(blueskyBtn);
    fireEvent.click(blueskyBtn);
    // Fetch feed button is still enabled (other platforms still active).
    expect((screen.getByRole('button', { name: /Fetch feed/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('clicking Fetch feed POSTs to /api/admin/ingest/search and renders results', async () => {
    const stub = installFetch({
      match: (url, method) => {
        if (url.includes('/api/admin/ingest/platforms')) {
          return jsonResponse({ platforms: [makePlatform('bluesky', true, true)] });
        }
        if (url.includes('/api/name-search')) {
          return jsonResponse({ results: [makeNameSearchEntry()] });
        }
        if (url.includes('/api/admin/ingest/handles')) {
          return jsonResponse({
            items: [{ platform: 'bluesky', handle: 'alice.bsky.social', bioguide_id: 'A000001' }],
          });
        }
        if (url.endsWith('/api/admin/ingest/search') && method === 'POST') {
          return jsonResponse({
            bioguideId: 'A000001',
            results: {
              bluesky: {
                handle: 'alice.bsky.social',
                posts: [
                  {
                    platform: 'bluesky',
                    platformPostId: 'bsky-1',
                    authorHandle: 'alice.bsky.social',
                    authorPlatformId: 'did:1',
                    postedAt: '2026-04-30T10:00:00Z',
                    url: 'https://bsky.app/profile/alice/post/1',
                    bodyText: 'Standing with Ukraine — this is the research post.',
                    mediaRefs: [],
                  },
                ],
              },
            },
          });
        }
        return null;
      },
    });
    render(<ResearchView />);
    await selectPersonViaPicker('Alice Adams');
    const fetchBtn = await waitFor(
      () => screen.getByRole('button', { name: /Fetch feed/i }),
      { timeout: 5000 },
    );
    fireEvent.click(fetchBtn);
    await waitFor(
      () => expect(screen.getByText(/Standing with Ukraine — this is the research post/i)).toBeInTheDocument(),
      { timeout: 5000 },
    );
    // Total count line renders.
    expect(screen.getByText(/1 posts across 1 platforms/i)).toBeInTheDocument();
    // The platforms array in the request body.
    const searchCall = stub.calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/admin/ingest/search'));
    expect(searchCall).toBeDefined();
    const body = searchCall!.body as Record<string, unknown>;
    expect(body.bioguide_id).toBe('A000001');
    expect((body.platforms as string[]).includes('bluesky')).toBe(true);
  });

  it('passes filter_terms when the keyword input is set, and submits on Enter', async () => {
    const stub = installFetch({
      match: (url, method) => {
        if (url.includes('/api/admin/ingest/platforms')) {
          return jsonResponse({ platforms: [makePlatform('bluesky', true, true)] });
        }
        if (url.includes('/api/name-search')) {
          return jsonResponse({ results: [makeNameSearchEntry()] });
        }
        if (url.includes('/api/admin/ingest/handles')) {
          return jsonResponse({
            items: [{ platform: 'bluesky', handle: 'alice.bsky.social', bioguide_id: 'A000001' }],
          });
        }
        if (url.endsWith('/api/admin/ingest/search') && method === 'POST') {
          return jsonResponse({
            bioguideId: 'A000001',
            results: {
              bluesky: {
                handle: 'alice.bsky.social',
                posts: [],
              },
            },
          });
        }
        return null;
      },
    });
    render(<ResearchView />);
    await selectPersonViaPicker('Alice Adams');
    const filterInput = await waitFor(
      () => screen.getByPlaceholderText(/Filter by keyword/i),
      { timeout: 5000 },
    );
    fireEvent.change(filterInput, { target: { value: 'donbas' } });
    // Enter triggers fetchFeed via onKeyDown branch.
    fireEvent.keyDown(filterInput, { key: 'Enter' });
    await waitFor(
      () => expect(stub.calls.some(
        (c) => c.method === 'POST' && c.url.endsWith('/api/admin/ingest/search'),
      )).toBe(true),
      { timeout: 5000 },
    );
    const searchCall = stub.calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/admin/ingest/search'))!;
    expect((searchCall.body as Record<string, unknown>).filter_terms).toBe('donbas');
    // Empty-results "No posts found" branch renders.
    await waitFor(
      () => expect(screen.getByText(/No posts found/i)).toBeInTheDocument(),
      { timeout: 5000 },
    );
    // The matching summary line includes the filter terms.
    expect(screen.getByText(/matching "donbas"/i)).toBeInTheDocument();
  });

  it('renders no_handle and platform-error variants in the per-platform results', async () => {
    installFetch({
      match: (url, method) => {
        if (url.includes('/api/admin/ingest/platforms')) {
          return jsonResponse({
            platforms: [makePlatform('bluesky', true, true), makePlatform('mastodon', true, true)],
          });
        }
        if (url.includes('/api/name-search')) {
          return jsonResponse({ results: [makeNameSearchEntry()] });
        }
        if (url.includes('/api/admin/ingest/handles')) {
          return jsonResponse({
            items: [
              { platform: 'bluesky', handle: 'alice.bsky.social', bioguide_id: 'A000001' },
              { platform: 'mastodon', handle: 'alice@m.example', bioguide_id: 'A000001' },
            ],
          });
        }
        if (url.endsWith('/api/admin/ingest/search') && method === 'POST') {
          return jsonResponse({
            bioguideId: 'A000001',
            results: {
              bluesky: { handle: null, posts: [], error: 'no_handle' },
              mastodon: { handle: 'alice@m.example', posts: [], error: 'rate_limited' },
            },
          });
        }
        return null;
      },
    });
    render(<ResearchView />);
    await selectPersonViaPicker('Alice Adams');
    const fetchBtn = await waitFor(
      () => screen.getByRole('button', { name: /Fetch feed/i }),
      { timeout: 5000 },
    );
    fireEvent.click(fetchBtn);
    // no_handle branch.
    await waitFor(
      () => expect(screen.getByText(/No Bluesky handle linked/i)).toBeInTheDocument(),
      { timeout: 5000 },
    );
    // platform error branch.
    expect(screen.getByText(/Error: rate_limited/i)).toBeInTheDocument();
  });

  it('Fetch feed surfaces an error banner when the search POST throws', async () => {
    installFetch({
      match: (url, method) => {
        if (url.includes('/api/admin/ingest/platforms')) {
          return jsonResponse({ platforms: [makePlatform('bluesky', true, true)] });
        }
        if (url.includes('/api/name-search')) {
          return jsonResponse({ results: [makeNameSearchEntry()] });
        }
        if (url.includes('/api/admin/ingest/handles')) {
          return jsonResponse({
            items: [{ platform: 'bluesky', handle: 'alice.bsky.social', bioguide_id: 'A000001' }],
          });
        }
        if (url.endsWith('/api/admin/ingest/search') && method === 'POST') {
          return jsonResponse({ error: 'search_failed', detail: 'upstream blew up' }, 502);
        }
        return null;
      },
    });
    render(<ResearchView />);
    await selectPersonViaPicker('Alice Adams');
    const fetchBtn = await waitFor(
      () => screen.getByRole('button', { name: /Fetch feed/i }),
      { timeout: 5000 },
    );
    fireEvent.click(fetchBtn);
    await waitFor(
      () => expect(screen.getByText(/upstream blew up/i)).toBeInTheDocument(),
      { timeout: 5000 },
    );
  });

  it('Curate as Quote enqueues the post and calls onCurateAsQuote with the prefill', async () => {
    let prefill: import('../../src/admin/App').QuotePrefill | null = null;
    const stub = installFetch({
      match: (url, method) => {
        if (url.includes('/api/admin/ingest/platforms')) {
          return jsonResponse({ platforms: [makePlatform('bluesky', true, true)] });
        }
        if (url.includes('/api/name-search')) {
          return jsonResponse({ results: [makeNameSearchEntry()] });
        }
        if (url.includes('/api/admin/ingest/handles') && method === 'GET') {
          return jsonResponse({
            items: [{ platform: 'bluesky', handle: 'alice.bsky.social', bioguide_id: 'A000001' }],
          });
        }
        if (url.endsWith('/api/admin/ingest/search') && method === 'POST') {
          return jsonResponse({
            bioguideId: 'A000001',
            results: {
              bluesky: {
                handle: 'alice.bsky.social',
                posts: [{
                  platform: 'bluesky',
                  platformPostId: 'bsky-research-1',
                  authorHandle: 'alice.bsky.social',
                  authorPlatformId: 'did:1',
                  postedAt: '2026-04-30T10:00:00Z',
                  url: 'https://bsky.app/profile/alice/post/r1',
                  bodyText: 'Curate-this-research-post body',
                  mediaRefs: [{ kind: 'image', url: 'https://x/img.jpg' }],
                }],
              },
            },
          });
        }
        if (url.endsWith('/api/admin/ingest/queue') && method === 'POST') {
          return jsonResponse({ row: { id: 'q-r-1' }, deduped: false }, 201);
        }
        return null;
      },
    });
    render(<ResearchView onCurateAsQuote={(p) => { prefill = p; }} />);
    await selectPersonViaPicker('Alice Adams');
    const fetchBtn = await waitFor(
      () => screen.getByRole('button', { name: /Fetch feed/i }),
      { timeout: 5000 },
    );
    fireEvent.click(fetchBtn);
    const curateBtn = await waitFor(
      () => screen.getByRole('button', { name: /Curate as Quote/i }),
      { timeout: 5000 },
    );
    fireEvent.click(curateBtn);
    await waitFor(() => expect(prefill).not.toBeNull(), { timeout: 5000 });
    expect(prefill!.bioguideId).toBe('A000001');
    expect(prefill!.queueItemId).toBe('q-r-1');
    expect(prefill!.bodyText).toBe('Curate-this-research-post body');
    expect(prefill!.mediaKind).toBe('social');
    // Enqueue body included the JSON-stringified mediaRefs.
    const enqueueCall = stub.calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/admin/ingest/queue'));
    expect(enqueueCall).toBeDefined();
    const body = enqueueCall!.body as Record<string, unknown>;
    expect(body.platform_post_id).toBe('bsky-research-1');
    expect(typeof body.media_refs_json).toBe('string');
    // Button stays disabled (state === 'pending') after success per the
    // "leave it pending so the button stays visibly disabled" comment.
    await waitFor(
      () => expect((screen.getByRole('button', { name: /Sending…/i }) as HTMLButtonElement).disabled).toBe(true),
      { timeout: 5000 },
    );
  });

  it('Curate as Quote shows "Retry curate" when the enqueue POST fails', async () => {
    installFetch({
      match: (url, method) => {
        if (url.includes('/api/admin/ingest/platforms')) {
          return jsonResponse({ platforms: [makePlatform('bluesky', true, true)] });
        }
        if (url.includes('/api/name-search')) {
          return jsonResponse({ results: [makeNameSearchEntry()] });
        }
        if (url.includes('/api/admin/ingest/handles') && method === 'GET') {
          return jsonResponse({
            items: [{ platform: 'bluesky', handle: 'alice.bsky.social', bioguide_id: 'A000001' }],
          });
        }
        if (url.endsWith('/api/admin/ingest/search') && method === 'POST') {
          return jsonResponse({
            bioguideId: 'A000001',
            results: {
              bluesky: {
                handle: 'alice.bsky.social',
                posts: [{
                  platform: 'bluesky',
                  platformPostId: 'bsky-fail-1',
                  authorHandle: 'alice.bsky.social',
                  authorPlatformId: 'did:1',
                  postedAt: '2026-04-30T10:00:00Z',
                  url: 'https://bsky.app/profile/alice/post/f1',
                  bodyText: 'fail-curate body',
                  mediaRefs: [],
                }],
              },
            },
          });
        }
        if (url.endsWith('/api/admin/ingest/queue') && method === 'POST') {
          return jsonResponse({ error: 'invalid_post', detail: 'bad post' }, 400);
        }
        return null;
      },
    });
    render(<ResearchView onCurateAsQuote={() => {}} />);
    await selectPersonViaPicker('Alice Adams');
    const fetchBtn = await waitFor(
      () => screen.getByRole('button', { name: /Fetch feed/i }),
      { timeout: 5000 },
    );
    fireEvent.click(fetchBtn);
    const curateBtn = await waitFor(
      () => screen.getByRole('button', { name: /Curate as Quote/i }),
      { timeout: 5000 },
    );
    fireEvent.click(curateBtn);
    await waitFor(
      () => expect(screen.getByRole('button', { name: /Retry curate/i })).toBeInTheDocument(),
      { timeout: 5000 },
    );
  });

  it('View profile button calls onNavigateToPerson with the selected bioguide id', async () => {
    let navigated: string | null = null;
    installFetch({
      match: (url) => {
        if (url.includes('/api/admin/ingest/platforms')) {
          return jsonResponse({ platforms: [makePlatform('bluesky', true, true)] });
        }
        if (url.includes('/api/name-search')) {
          return jsonResponse({ results: [makeNameSearchEntry()] });
        }
        if (url.includes('/api/admin/ingest/handles')) {
          return jsonResponse({
            items: [{ platform: 'bluesky', handle: 'alice.bsky.social', bioguide_id: 'A000001' }],
          });
        }
        return null;
      },
    });
    render(<ResearchView onNavigateToPerson={(id) => { navigated = id; }} />);
    await selectPersonViaPicker('Alice Adams');
    const profileBtn = await waitFor(
      () => screen.getByRole('button', { name: /View profile/i }),
      { timeout: 5000 },
    );
    fireEvent.click(profileBtn);
    expect(navigated).toBe('A000001');
  });
});

/* ========================================================================== */
/* KeywordsView                                                               */
/* ========================================================================== */

interface KwRow { id: string; watch_name: string; pattern: string; is_regex: number; active: number; notify: number }

function makeKw(overrides: Partial<KwRow> = {}): KwRow {
  return {
    id: overrides.id ?? 'k-1',
    watch_name: overrides.watch_name ?? 'ukraine',
    pattern: overrides.pattern ?? 'ukraine',
    is_regex: overrides.is_regex ?? 0,
    active: overrides.active ?? 1,
    notify: overrides.notify ?? 0,
  };
}

describe('KeywordsView — list + add', () => {
  it('renders existing keyword rows with their pattern + type badge', async () => {
    installFetch({
      match: (url) => {
        if (url.includes('/api/admin/ingest/keywords')) {
          return jsonResponse({
            items: [makeKw({ id: 'k-1', watch_name: 'donbas', pattern: 'donbas' })],
          });
        }
        return null;
      },
    });
    render(<KeywordsView />);
    await waitFor(() => expect(screen.queryByText(/Loading keywords/i)).not.toBeInTheDocument(), { timeout: 3000 });
    // Watch name + pattern columns both render the same string in this row.
    expect(screen.getAllByText('donbas').length).toBeGreaterThanOrEqual(1);
    // Type badge text content is "keyword" (lowercase, in a <span>).
    expect(screen.getByText('keyword')).toBeInTheDocument();
  });

  it('shows "regex" badge for regex rows', async () => {
    installFetch({
      match: (url) => {
        if (url.includes('/api/admin/ingest/keywords')) {
          return jsonResponse({
            items: [makeKw({ id: 'k-2', watch_name: 'kyiv-watch', pattern: '\\bkyiv\\b', is_regex: 1 })],
          });
        }
        return null;
      },
    });
    render(<KeywordsView />);
    await waitFor(() => expect(screen.getByText('kyiv-watch')).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText('regex')).toBeInTheDocument();
  });

  it('blocks add when watch name is missing', async () => {
    const stub = installFetch({
      match: (url) => {
        if (url.includes('/api/admin/ingest/keywords')) return jsonResponse({ items: [] });
        return null;
      },
    });
    render(<KeywordsView />);
    await waitFor(() => expect(screen.queryByText(/Loading keywords/i)).not.toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /\+ Add/i }));
    expect(await screen.findByText(/Watch name is required/i)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('blocks add when pattern is missing', async () => {
    installFetch({
      match: (url) => {
        if (url.includes('/api/admin/ingest/keywords')) return jsonResponse({ items: [] });
        return null;
      },
    });
    render(<KeywordsView />);
    await waitFor(() => expect(screen.queryByText(/Loading keywords/i)).not.toBeInTheDocument(), { timeout: 3000 });
    fireEvent.change(screen.getByPlaceholderText(/Watch name/i), { target: { value: 'ukraine' } });
    fireEvent.click(screen.getByRole('button', { name: /\+ Add/i }));
    expect(await screen.findByText(/Pattern is required/i)).toBeInTheDocument();
  });

  it('blocks add when regex pattern is invalid', async () => {
    installFetch({
      match: (url) => {
        if (url.includes('/api/admin/ingest/keywords')) return jsonResponse({ items: [] });
        return null;
      },
    });
    render(<KeywordsView />);
    await waitFor(() => expect(screen.queryByText(/Loading keywords/i)).not.toBeInTheDocument(), { timeout: 3000 });
    fireEvent.change(screen.getByPlaceholderText(/Watch name/i), { target: { value: 'ukraine' } });
    fireEvent.change(screen.getByPlaceholderText(/Keyword or regex/i), { target: { value: '[unclosed' } });
    fireEvent.click(screen.getByLabelText(/^Regex$/i));
    fireEvent.click(screen.getByRole('button', { name: /\+ Add/i }));
    expect(await screen.findByText(/Invalid regex/i)).toBeInTheDocument();
  });

  it('POSTs to /api/admin/ingest/keywords on a successful add', async () => {
    let kws: KwRow[] = [];
    const stub = installFetch({
      match: (url, method, body) => {
        if (url.includes('/api/admin/ingest/keywords') && method === 'POST') {
          kws = [makeKw({ id: 'k-new', watch_name: (body as Record<string, unknown>).watch_name as string, pattern: (body as Record<string, unknown>).pattern as string })];
          return jsonResponse({ ok: true }, 201);
        }
        if (url.includes('/api/admin/ingest/keywords')) return jsonResponse({ items: kws });
        return null;
      },
    });
    render(<KeywordsView />);
    await waitFor(() => expect(screen.queryByText(/Loading keywords/i)).not.toBeInTheDocument(), { timeout: 3000 });
    fireEvent.change(screen.getByPlaceholderText(/Watch name/i), { target: { value: 'ukraine' } });
    fireEvent.change(screen.getByPlaceholderText(/Keyword or regex/i), { target: { value: 'ukraine' } });
    fireEvent.click(screen.getByRole('button', { name: /\+ Add/i }));
    await waitFor(() =>
      expect(stub.calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/admin/ingest/keywords'))).toBe(true),
      { timeout: 3000 },
    );
  });

  it('renders the trace ID under the add error when the backend returns one', async () => {
    installFetch({
      match: (url, method) => {
        if (url.includes('/api/admin/ingest/keywords') && method === 'POST') {
          return jsonResponse({ error: 'invalid_keyword', detail: 'pattern too short', traceId: 'tr-kw-77' }, 400);
        }
        if (url.includes('/api/admin/ingest/keywords')) return jsonResponse({ items: [] });
        return null;
      },
    });
    render(<KeywordsView />);
    await waitFor(() => expect(screen.queryByText(/Loading keywords/i)).not.toBeInTheDocument(), { timeout: 3000 });
    fireEvent.change(screen.getByPlaceholderText(/Watch name/i), { target: { value: 'x' } });
    fireEvent.change(screen.getByPlaceholderText(/Keyword or regex/i), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /\+ Add/i }));
    expect(await screen.findByText(/pattern too short/i)).toBeInTheDocument();
    expect(screen.getByText(/tr-kw-77/)).toBeInTheDocument();
  });

  it('PATCHes to /api/admin/ingest/keywords/:id when toggling a row', async () => {
    const stub = installFetch({
      match: (url, method) => {
        if (url.includes('/api/admin/ingest/keywords') && method === 'GET') {
          return jsonResponse({ items: [makeKw({ id: 'k-1', watch_name: 'donbas-watch', pattern: 'donbas', active: 1 })] });
        }
        if (/\/api\/admin\/ingest\/keywords\/[^/?]+$/.test(url) && method === 'PATCH') {
          return jsonResponse({ ok: true });
        }
        return null;
      },
    });
    render(<KeywordsView />);
    await waitFor(() => expect(screen.getByText('donbas-watch')).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /^Disable$/ }));
    await waitFor(() =>
      expect(stub.calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/api/admin/ingest/keywords/k-1'))).toBe(true),
      { timeout: 3000 },
    );
  });

  it('Seed Ukraine keywords POSTs to /api/admin/ingest/seed and renders a result blurb', async () => {
    const stub = installFetch({
      match: (url, method) => {
        if (url.endsWith('/api/admin/ingest/seed') && method === 'POST') {
          return jsonResponse({
            roster: { membersScanned: 535, handlesUpserted: 100, mastodon: 50, bluesky: 50 },
            keywords: { seeded: 12 },
            skipped: false,
          });
        }
        if (url.includes('/api/admin/ingest/keywords')) return jsonResponse({ items: [] });
        return null;
      },
    });
    render(<KeywordsView />);
    await waitFor(() => expect(screen.queryByText(/Loading keywords/i)).not.toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /Seed Ukraine keywords/i }));
    await waitFor(() => expect(screen.getByText(/Seeded 12 keyword watches/i)).toBeInTheDocument(), { timeout: 3000 });
    expect(stub.calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/admin/ingest/seed'))).toBe(true);
  });

  it('renders "Seed failed" when the seed POST throws', async () => {
    installFetch({
      match: (url, method) => {
        if (url.endsWith('/api/admin/ingest/seed') && method === 'POST') {
          return jsonResponse({ error: 'seed_failed' }, 500);
        }
        if (url.includes('/api/admin/ingest/keywords')) return jsonResponse({ items: [] });
        return null;
      },
    });
    render(<KeywordsView />);
    await waitFor(() => expect(screen.queryByText(/Loading keywords/i)).not.toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /Seed Ukraine keywords/i }));
    await waitFor(() => expect(screen.getByText(/Seed failed/i)).toBeInTheDocument(), { timeout: 3000 });
  });
});
