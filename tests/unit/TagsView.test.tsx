/**
 * Tests for src/admin/components/settings/TagsView.tsx — the Settings ▸ Tags
 * CRUD view. Tags are the shared categorization primitive (see CLAUDE.md
 * "Tags are a system primitive"); this surface is the canonical CRUD page.
 *
 * Trace:
 *   - FR-52 / AC-52.* — admin SPA, Settings home for cross-cutting knobs
 *   - Tags-as-primitive (CLAUDE.md) — shared `tags` + `*_tags` join pattern
 *   - audit_log integration: every write carries a reason on edit/delete and
 *     surfaces a copyable trace ID in the error path (CLAUDE.md "Trace IDs
 *     are user-visible on errors")
 *
 * Conventions:
 *   - No vi.mock — fetch is replaced via globalThis.fetch swap (see
 *     useAvailablePlatforms.test.tsx for the canonical pattern).
 *   - JSDOM environment from vitest.config.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { TagsView } from '../../src/admin/components/settings/TagsView';
import type { TagRow } from '../../src/admin/types';

const realFetch = globalThis.fetch;

function makeTag(overrides: Partial<TagRow> = {}): TagRow {
  return {
    id: overrides.id ?? 'tag-1',
    slug: overrides.slug ?? 'on-floor',
    label: overrides.label ?? 'On floor',
    color: overrides.color ?? '#ef4444',
    description: overrides.description ?? null,
    created_at: overrides.created_at ?? '2026-05-01T00:00:00Z',
    created_by: overrides.created_by ?? null,
    updated_at: overrides.updated_at ?? '2026-05-01T00:00:00Z',
    updated_by: overrides.updated_by ?? null,
  };
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Build a fetch stub that:
 *   - returns the current `tagsRef.current` array on GET /api/admin/tags
 *   - matches POST/PATCH/DELETE against per-test handlers
 *   - records every call into `calls` for assertions
 */
function installFetch(opts: {
  tags: TagRow[];
  onPost?: (body: unknown) => Response | Promise<Response>;
  onPatch?: (id: string, body: unknown) => Response | Promise<Response>;
  onDelete?: (id: string, query: string) => Response | Promise<Response>;
}): { calls: FetchCall[]; setTags: (next: TagRow[]) => void } {
  const calls: FetchCall[] = [];
  const tagsRef: { current: TagRow[] } = { current: opts.tags };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = null;
    if (init?.body && typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ url, method, body });
    if (method === 'GET' && url.endsWith('/api/admin/tags')) {
      return jsonResponse({ items: tagsRef.current });
    }
    if (method === 'POST' && url.endsWith('/api/admin/tags')) {
      if (opts.onPost) return opts.onPost(body);
      return jsonResponse({ tag: makeTag() }, 201);
    }
    const patchMatch = /\/api\/admin\/tags\/([^?]+)$/.exec(url);
    if (method === 'PATCH' && patchMatch) {
      if (opts.onPatch) return opts.onPatch(patchMatch[1]!, body);
      return jsonResponse({ tag: makeTag({ id: patchMatch[1]! }) });
    }
    const deleteMatch = /\/api\/admin\/tags\/([^?]+)(?:\?(.*))?$/.exec(url);
    if (method === 'DELETE' && deleteMatch) {
      if (opts.onDelete) return opts.onDelete(deleteMatch[1]!, deleteMatch[2] ?? '');
      return new Response(null, { status: 204 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return {
    calls,
    setTags: (next) => { tagsRef.current = next; },
  };
}

beforeEach(() => {
  // Each test installs its own fetch stub.
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('TagsView — list load', () => {
  it('shows "Loading…" while the initial fetch is pending, then renders the list', async () => {
    installFetch({ tags: [makeTag({ id: 't-a', slug: 'on-floor', label: 'On floor' })] });
    render(<TagsView />);
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    expect(screen.getByText('On floor')).toBeInTheDocument();
    expect(screen.getByText('/on-floor')).toBeInTheDocument();
  });

  it('shows the "+ New tag" button and the section heading', async () => {
    installFetch({ tags: [] });
    render(<TagsView />);
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: /Tags/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ New tag/ })).toBeInTheDocument();
  });

  it('renders descriptions when present', async () => {
    installFetch({
      tags: [makeTag({ id: 't-x', slug: 'caucus', label: 'Caucus', description: 'Spoke at caucus' })],
    });
    render(<TagsView />);
    await waitFor(() => expect(screen.getByText('Spoke at caucus')).toBeInTheDocument());
  });

  it('falls back to an empty list when the GET fails', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    render(<TagsView />);
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    // No rows; only the toolbar + heading remain.
    expect(screen.getByRole('button', { name: /\+ New tag/ })).toBeInTheDocument();
  });
});

describe('TagsView — create flow', () => {
  it('opens the create form when "+ New tag" is clicked', async () => {
    installFetch({ tags: [] });
    render(<TagsView />);
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    expect(screen.getByPlaceholderText('On floor')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('on-floor')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create tag/ })).toBeInTheDocument();
    // The "+ New tag" button hides while the create form is open.
    expect(screen.queryByRole('button', { name: /\+ New tag/ })).not.toBeInTheDocument();
  });

  it('cancel closes the create form without posting', async () => {
    const stub = installFetch({ tags: [] });
    render(<TagsView />);
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /\+ New tag/ })).toBeInTheDocument());
    expect(stub.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('derives slug from label as the user types (kebab-case)', async () => {
    installFetch({ tags: [] });
    render(<TagsView />);
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    const labelInput = screen.getByPlaceholderText('On floor') as HTMLInputElement;
    fireEvent.change(labelInput, { target: { value: 'Floor Speech' } });
    const slugInput = screen.getByPlaceholderText('on-floor') as HTMLInputElement;
    expect(slugInput.value).toBe('floor-speech');
  });

  it('rejects an empty label with a friendly error', async () => {
    const stub = installFetch({ tags: [] });
    render(<TagsView />);
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    fireEvent.click(screen.getByRole('button', { name: /Create tag/ }));
    expect(await screen.findByText(/Label is required/i)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('rejects an invalid slug shape', async () => {
    const stub = installFetch({ tags: [] });
    render(<TagsView />);
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    fireEvent.change(screen.getByPlaceholderText('On floor'), { target: { value: 'My Tag' } });
    // Force an illegal slug (uppercase + space) bypassing the auto-derive.
    fireEvent.change(screen.getByPlaceholderText('on-floor'), { target: { value: 'BAD SLUG!' } });
    fireEvent.click(screen.getByRole('button', { name: /Create tag/ }));
    expect(await screen.findByText(/Slug must be lowercase kebab-case/i)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('rejects an invalid color', async () => {
    const stub = installFetch({ tags: [] });
    render(<TagsView />);
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    fireEvent.change(screen.getByPlaceholderText('On floor'), { target: { value: 'My Tag' } });
    fireEvent.change(screen.getByPlaceholderText('#000000'), { target: { value: 'red' } });
    fireEvent.click(screen.getByRole('button', { name: /Create tag/ }));
    expect(await screen.findByText(/Color must be a 6-digit hex/i)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('POSTs to /api/admin/tags on success and re-fetches the list', async () => {
    const stub = installFetch({
      tags: [],
      onPost: (body) => {
        // Tag JSON payload shape (per apiAdminRoutes.test.ts).
        const b = body as Record<string, unknown>;
        expect(b.slug).toBe('my-tag');
        expect(b.label).toBe('My Tag');
        expect(b.color).toBe('#22c55e');
        expect(b.description).toBeNull();
        return jsonResponse({ tag: makeTag({ id: 'new', slug: 'my-tag', label: 'My Tag' }) }, 201);
      },
    });
    render(<TagsView />);
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    fireEvent.change(screen.getByPlaceholderText('On floor'), { target: { value: 'My Tag' } });
    // Pick the green swatch (4th in DEFAULT_COLORS).
    fireEvent.click(screen.getByRole('button', { name: /Pick color #22c55e/i }));
    // After successful create, the load() refresh kicks in; expose the row.
    stub.setTags([makeTag({ id: 'new', slug: 'my-tag', label: 'My Tag', color: '#22c55e' })]);
    fireEvent.click(screen.getByRole('button', { name: /Create tag/ }));
    await waitFor(() => expect(screen.getByText('My Tag')).toBeInTheDocument());
    const posts = stub.calls.filter((c) => c.method === 'POST');
    expect(posts.length).toBe(1);
    expect(posts[0]!.url).toMatch(/\/api\/admin\/tags$/);
    // Form is closed and "+ New tag" is back.
    expect(screen.getByRole('button', { name: /\+ New tag/ })).toBeInTheDocument();
  });

  it('passes description through to the POST body when supplied', async () => {
    const stub = installFetch({
      tags: [],
      onPost: (body) => {
        const b = body as Record<string, unknown>;
        expect(b.description).toBe('A short blurb');
        return jsonResponse({ tag: makeTag({ id: 'new' }) }, 201);
      },
    });
    render(<TagsView />);
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    fireEvent.change(screen.getByPlaceholderText('On floor'), { target: { value: 'Tagged' } });
    // Description is the only input rendered without a placeholder under the
    // "Description (optional)" label; grab it via the label.
    const descLabel = screen.getByText(/Description \(optional\)/i);
    const descInput = descLabel.parentElement!.querySelector('input') as HTMLInputElement;
    fireEvent.change(descInput, { target: { value: 'A short blurb' } });
    fireEvent.click(screen.getByRole('button', { name: /Create tag/ }));
    await waitFor(() => expect(stub.calls.some((c) => c.method === 'POST')).toBe(true));
  });

  it('surfaces a friendly error + trace ID when the POST fails with invalid_tag', async () => {
    installFetch({
      tags: [],
      onPost: () => jsonResponse(
        { error: 'invalid_tag', detail: 'Slug already in use', traceId: 'trace-abc-123' },
        400,
      ),
    });
    render(<TagsView />);
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    fireEvent.change(screen.getByPlaceholderText('On floor'), { target: { value: 'Dup' } });
    fireEvent.click(screen.getByRole('button', { name: /Create tag/ }));
    // friendlyError prefers obj.detail when present.
    expect(await screen.findByText(/Slug already in use/i)).toBeInTheDocument();
    expect(screen.getByText(/trace-abc-123/)).toBeInTheDocument();
  });

  it('falls back to the unauthorized message when the API returns "unauthorized"', async () => {
    installFetch({
      tags: [],
      onPost: () => jsonResponse({ error: 'unauthorized' }, 401),
    });
    render(<TagsView />);
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    fireEvent.change(screen.getByPlaceholderText('On floor'), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: /Create tag/ }));
    expect(await screen.findByText(/session has expired/i)).toBeInTheDocument();
  });

  it('falls back to a generic error when the response shape is unknown', async () => {
    installFetch({
      tags: [],
      onPost: () => new Response('plain-text', { status: 500 }),
    });
    render(<TagsView />);
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    fireEvent.change(screen.getByPlaceholderText('On floor'), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: /Create tag/ }));
    // No detail/error → generic message.
    expect(await screen.findByText(/Something went wrong/i)).toBeInTheDocument();
  });
});

describe('TagsView — color picker', () => {
  it('renders all 10 default color swatches with picker labels', async () => {
    installFetch({ tags: [] });
    render(<TagsView />);
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    for (const c of [
      '#ef4444', '#f97316', '#eab308', '#22c55e',
      '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
      '#64748b', '#0ea5e9',
    ]) {
      expect(screen.getByRole('button', { name: `Pick color ${c}` })).toBeInTheDocument();
    }
  });

  it('typing a hex value into the color text field updates the form', async () => {
    installFetch({ tags: [] });
    render(<TagsView />);
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    const colorInput = screen.getByPlaceholderText('#000000') as HTMLInputElement;
    fireEvent.change(colorInput, { target: { value: '#abcdef' } });
    expect(colorInput.value).toBe('#abcdef');
  });
});

describe('TagsView — edit flow', () => {
  it('clicking Edit opens the form pre-populated with the existing tag', async () => {
    installFetch({
      tags: [makeTag({ id: 't-1', slug: 'caucus', label: 'Caucus', color: '#3b82f6', description: 'desc' })],
    });
    render(<TagsView />);
    await waitFor(() => expect(screen.getByText('Caucus')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    const labelInput = screen.getByPlaceholderText('On floor') as HTMLInputElement;
    expect(labelInput.value).toBe('Caucus');
    const slugInput = screen.getByPlaceholderText('on-floor') as HTMLInputElement;
    expect(slugInput.value).toBe('caucus');
    expect(screen.getByRole('button', { name: /Save changes/ })).toBeInTheDocument();
    // Reason field appears in edit mode.
    expect(screen.getByPlaceholderText(/Briefly describe what you changed/i)).toBeInTheDocument();
  });

  it('requires a reason before submitting the edit', async () => {
    const stub = installFetch({
      tags: [makeTag({ id: 't-1', slug: 'caucus', label: 'Caucus' })],
    });
    render(<TagsView />);
    await waitFor(() => expect(screen.getByText('Caucus')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    expect(await screen.findByText(/describe why you're making this change/i)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('PATCHes to /api/admin/tags/:id with _reason and refreshes the list', async () => {
    const stub = installFetch({
      tags: [makeTag({ id: 't-1', slug: 'caucus', label: 'Caucus' })],
      onPatch: (id, body) => {
        expect(id).toBe('t-1');
        const b = body as Record<string, unknown>;
        expect(b.label).toBe('Caucus 2');
        expect(b._reason).toBe('renamed');
        return jsonResponse({ tag: makeTag({ id: 't-1', slug: 'caucus', label: 'Caucus 2' }) });
      },
    });
    render(<TagsView />);
    await waitFor(() => expect(screen.getByText('Caucus')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    fireEvent.change(screen.getByPlaceholderText('On floor'), { target: { value: 'Caucus 2' } });
    fireEvent.change(screen.getByPlaceholderText(/Briefly describe what you changed/i), {
      target: { value: 'renamed' },
    });
    stub.setTags([makeTag({ id: 't-1', slug: 'caucus', label: 'Caucus 2' })]);
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() => expect(screen.getByText('Caucus 2')).toBeInTheDocument());
    const patches = stub.calls.filter((c) => c.method === 'PATCH');
    expect(patches.length).toBe(1);
  });

  it('cancel closes the edit form', async () => {
    installFetch({
      tags: [makeTag({ id: 't-1', slug: 'caucus', label: 'Caucus' })],
    });
    render(<TagsView />);
    await waitFor(() => expect(screen.getByText('Caucus')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    expect(screen.getByRole('button', { name: /Save changes/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Save changes/ })).not.toBeInTheDocument());
    // Edit/Delete buttons are back on the row.
    expect(screen.getByRole('button', { name: /^Edit$/i })).toBeInTheDocument();
  });

  it('surfaces the friendly "no longer exists" message when PATCH returns not_found', async () => {
    installFetch({
      tags: [makeTag({ id: 't-1', slug: 'caucus', label: 'Caucus' })],
      onPatch: () => jsonResponse({ error: 'not_found' }, 404),
    });
    render(<TagsView />);
    await waitFor(() => expect(screen.getByText('Caucus')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    fireEvent.change(screen.getByPlaceholderText(/Briefly describe what you changed/i), {
      target: { value: 'whatever' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    expect(await screen.findByText(/no longer exists/i)).toBeInTheDocument();
  });

  it('maps the reason_required backend code to a human message', async () => {
    installFetch({
      tags: [makeTag({ id: 't-1', slug: 'caucus', label: 'Caucus' })],
      onPatch: () => jsonResponse({ error: 'reason_required' }, 400),
    });
    render(<TagsView />);
    await waitFor(() => expect(screen.getByText('Caucus')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    fireEvent.change(screen.getByPlaceholderText(/Briefly describe what you changed/i), {
      target: { value: 'something' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    expect(await screen.findByText(/A reason for this change is required/i)).toBeInTheDocument();
  });
});

describe('TagsView — delete flow', () => {
  it('clicking Delete opens an inline confirmation row with a reason field', async () => {
    installFetch({
      tags: [makeTag({ id: 't-1', slug: 'caucus', label: 'Caucus' })],
    });
    render(<TagsView />);
    await waitFor(() => expect(screen.getByText('Caucus')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/i }));
    expect(screen.getByText(/It will be removed from all quotes/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Why are you deleting this tag/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Confirm delete/ })).toBeInTheDocument();
  });

  it('blocks the delete when no reason is given', async () => {
    const stub = installFetch({
      tags: [makeTag({ id: 't-1', slug: 'caucus', label: 'Caucus' })],
    });
    render(<TagsView />);
    await waitFor(() => expect(screen.getByText('Caucus')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/i }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm delete/ }));
    expect(await screen.findByText(/A reason is required to delete a tag/i)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('cancel closes the confirmation row without DELETEing', async () => {
    const stub = installFetch({
      tags: [makeTag({ id: 't-1', slug: 'caucus', label: 'Caucus' })],
    });
    render(<TagsView />);
    await waitFor(() => expect(screen.getByText('Caucus')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/Why are you deleting/i)).not.toBeInTheDocument(),
    );
    expect(stub.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('DELETEs to /api/admin/tags/:id?reason=... and refreshes after success', async () => {
    const stub = installFetch({
      tags: [makeTag({ id: 't-1', slug: 'caucus', label: 'Caucus' })],
      onDelete: (id, query) => {
        expect(id).toBe('t-1');
        expect(query).toMatch(/reason=duplicate/);
        return new Response(null, { status: 204 });
      },
    });
    render(<TagsView />);
    await waitFor(() => expect(screen.getByText('Caucus')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/i }));
    fireEvent.change(screen.getByPlaceholderText(/Why are you deleting/i), {
      target: { value: 'duplicate' },
    });
    stub.setTags([]);
    fireEvent.click(screen.getByRole('button', { name: /Confirm delete/ }));
    await waitFor(() => expect(screen.queryByText('Caucus')).not.toBeInTheDocument());
    const deletes = stub.calls.filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBe(1);
  });

  it('renders an error banner with trace ID when DELETE fails', async () => {
    installFetch({
      tags: [makeTag({ id: 't-1', slug: 'caucus', label: 'Caucus' })],
      onDelete: () => jsonResponse(
        { error: 'invalid_tag', detail: 'Tag is in use', traceId: 'tr-del-1' },
        400,
      ),
    });
    render(<TagsView />);
    await waitFor(() => expect(screen.getByText('Caucus')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/i }));
    fireEvent.change(screen.getByPlaceholderText(/Why are you deleting/i), {
      target: { value: 'because' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Confirm delete/ }));
    expect(await screen.findByText(/Tag is in use/)).toBeInTheDocument();
    expect(screen.getByText(/tr-del-1/)).toBeInTheDocument();
  });

  it('dismissing the delete error banner clears the message', async () => {
    installFetch({
      tags: [makeTag({ id: 't-1', slug: 'caucus', label: 'Caucus' })],
      onDelete: () => jsonResponse({ error: 'invalid_tag', detail: 'No good' }, 400),
    });
    render(<TagsView />);
    await waitFor(() => expect(screen.getByText('Caucus')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/i }));
    fireEvent.change(screen.getByPlaceholderText(/Why are you deleting/i), {
      target: { value: 'reason' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Confirm delete/ }));
    await screen.findByText(/No good/);
    fireEvent.click(screen.getByRole('button', { name: '✕' }));
    await waitFor(() => expect(screen.queryByText(/No good/)).not.toBeInTheDocument());
  });

  it('clicking Delete on one row while editing another cancels the edit', async () => {
    installFetch({
      tags: [
        makeTag({ id: 't-1', slug: 'a', label: 'Alpha' }),
        makeTag({ id: 't-2', slug: 'b', label: 'Beta' }),
      ],
    });
    render(<TagsView />);
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    // Open edit on Alpha.
    const editButtons = screen.getAllByRole('button', { name: /^Edit$/i });
    fireEvent.click(editButtons[0]!);
    expect(screen.getByRole('button', { name: /Save changes/ })).toBeInTheDocument();
    // Now click delete on Beta.
    const deleteButtons = screen.getAllByRole('button', { name: /^Delete$/i });
    fireEvent.click(deleteButtons[deleteButtons.length - 1]!);
    // Edit form should disappear; delete confirm appears.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Save changes/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/It will be removed from all quotes/i)).toBeInTheDocument();
  });
});

describe('TagsView — copyable trace ID', () => {
  it('renders a clickable trace badge that copies to the clipboard', async () => {
    let copied = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (s: string) => { copied = s; },
      },
    });
    installFetch({
      tags: [],
      onPost: () => jsonResponse(
        { error: 'invalid_tag', detail: 'bad data', traceId: 'tr-copy-99' },
        400,
      ),
    });
    render(<TagsView />);
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    fireEvent.change(screen.getByPlaceholderText('On floor'), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: /Create tag/ }));
    const badge = await screen.findByTitle(/Click to copy this trace ID/i);
    await act(async () => {
      fireEvent.click(badge);
      // Let the promise chain settle.
      await Promise.resolve();
    });
    expect(copied).toBe('tr-copy-99');
    // The check-mark replaces the copy glyph after click.
    await waitFor(() => expect(within(badge).getByText('✓')).toBeInTheDocument());
  });
});
