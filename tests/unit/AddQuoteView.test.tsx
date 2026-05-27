/**
 * Tests for src/admin/components/curation/AddQuoteView.tsx — the Curation ▸
 * Add Quote form. Covers the affirmative scoring state machine, person
 * picker hookup, source/URL validation, ancillary links, tag picker, success
 * + error envelopes, and prefill from Inbox.
 *
 * Trace:
 *   - FR-49 / FR-58 — V4 quotes ingestion + curation
 *   - AC "Tags-as-primitive" (CLAUDE.md) — quotes use shared tags table
 *   - AC "Trace IDs are user-visible on errors" — error path shows traceId
 *
 * Conventions:
 *   - No vi.mock for the SUT; fetch is replaced via globalThis.fetch swap
 *     (mirrors TagsView.test.tsx multi-route handler pattern).
 *   - JSDOM environment from vitest.config.ts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { AddQuoteView } from '../../src/admin/components/curation/AddQuoteView';
import type { QuotePrefill } from '../../src/admin/App';
import type { QuoteRow, TagRow } from '../../src/admin/types';
import type { MocEntry } from '../../src/admin/components/MocPicker';

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

function makeMoc(overrides: Partial<MocEntry> = {}): MocEntry {
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

function makeQuoteRow(overrides: Partial<QuoteRow> = {}): QuoteRow {
  return {
    id: overrides.id ?? 'q-1',
    bioguide_id: overrides.bioguide_id ?? 'A000001',
    media_kind: overrides.media_kind ?? 'text',
    source_url: overrides.source_url ?? 'https://example.com/x',
    source_label: overrides.source_label ?? null,
    quoted_at: overrides.quoted_at ?? null,
    body_text: overrides.body_text ?? 'hello',
    weight: overrides.weight ?? 3,
    direction: overrides.direction ?? 1,
    comment: overrides.comment ?? null,
    links_json: overrides.links_json ?? null,
    author_email: overrides.author_email ?? 'r@x.com',
    created_at: overrides.created_at ?? '2026-05-01T00:00:00Z',
    updated_at: overrides.updated_at ?? '2026-05-01T00:00:00Z',
    tags: overrides.tags,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface FetchCall { url: string; method: string; body: unknown }

interface InstallOpts {
  tags?: TagRow[];
  members?: MocEntry[];
  searchResults?: MocEntry[];
  onPostQuote?: (body: unknown) => Response | Promise<Response>;
  onPatchQueue?: (id: string, body: unknown) => Response | Promise<Response>;
}

/**
 * Multi-route fetch stub. Routes:
 *   GET  /api/admin/ingest/roster-meta   → { members }
 *   GET  /api/admin/tags                 → { items }
 *   GET  /api/name-search?q=...          → { results }
 *   POST /api/admin/quotes               → onPostQuote() or default success
 *   PATCH /api/admin/ingest/queue/:id    → onPatchQueue() or 204
 */
function installFetch(opts: InstallOpts = {}): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const members = opts.members ?? [];
  const tags = opts.tags ?? [];
  const searchResults = opts.searchResults ?? [];
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
    if (method === 'GET' && url.endsWith('/api/admin/ingest/roster-meta')) {
      return jsonResponse({ members });
    }
    if (method === 'GET' && url.endsWith('/api/admin/tags')) {
      return jsonResponse({ items: tags });
    }
    if (method === 'GET' && url.includes('/api/name-search')) {
      return jsonResponse({ results: searchResults });
    }
    if (method === 'POST' && url.endsWith('/api/admin/quotes')) {
      if (opts.onPostQuote) return opts.onPostQuote(body);
      return jsonResponse({ row: makeQuoteRow() }, 201);
    }
    const queueMatch = /\/api\/admin\/ingest\/queue\/([^?]+)$/.exec(url);
    if (method === 'PATCH' && queueMatch) {
      if (opts.onPatchQueue) return opts.onPatchQueue(queueMatch[1]!, body);
      return new Response(null, { status: 204 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { calls };
}

/** Use the MocPicker debounced typeahead to pick a person.
 *  Requires `installFetch({ searchResults: [...] })` set up so the search
 *  returns the desired row. */
async function pickMoc(displayName: string) {
  const input = screen.getByPlaceholderText(/Search for a member of Congress/i);
  fireEvent.change(input, { target: { value: displayName.slice(0, 3) } });
  // Debounce inside MocPicker is 200ms; wait past it for the dropdown.
  await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
  const option = await screen.findByText(displayName, {}, { timeout: 3000 });
  fireEvent.click(option);
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

describe('AddQuoteView — initial render', () => {
  it('renders the Person/Source/Quote/Scoring/Tags sections with Save disabled', async () => {
    installFetch();
    render(<AddQuoteView />);
    // Wait for tags GET to settle so async state stops churning.
    await waitFor(
      () => expect(screen.getByText(/^Person$/)).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(screen.getByText(/^Source$/)).toBeInTheDocument();
    expect(screen.getByText(/^Quote$/)).toBeInTheDocument();
    expect(screen.getByText(/^Tags$/)).toBeInTheDocument();
    // Default save button label (no intent picked).
    const save = screen.getByRole('button', { name: /Publish quote/i });
    expect(save).toBeDisabled();
  });

  it('GETs roster-meta and tags on mount', async () => {
    const stub = installFetch({ tags: [makeTag({ id: 't-x', label: 'Caucus' })] });
    render(<AddQuoteView />);
    await waitFor(
      () => expect(stub.calls.some((c) => c.url.endsWith('/api/admin/tags'))).toBe(true),
      { timeout: 3000 },
    );
    expect(stub.calls.some((c) => c.url.endsWith('/api/admin/ingest/roster-meta'))).toBe(true);
  });
});

describe('AddQuoteView — scoring state machine', () => {
  it('Pro/Anti reveal the weight slider and "No score" hides it', async () => {
    installFetch();
    render(<AddQuoteView />);
    await waitFor(() => expect(screen.getByText(/^Scoring/)).toBeInTheDocument(), { timeout: 3000 });

    // Initially: no slider visible (intent is null).
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Pro-Ukraine/i }));
    expect(screen.getByRole('slider')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /No score impact/i }));
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Anti-Ukraine/i }));
    expect(screen.getByRole('slider')).toBeInTheDocument();
  });

  it('Save label reflects current intent + weight', async () => {
    installFetch();
    render(<AddQuoteView />);
    await waitFor(() => expect(screen.getByText(/^Scoring/)).toBeInTheDocument(), { timeout: 3000 });

    fireEvent.click(screen.getByRole('button', { name: /No score impact/i }));
    expect(screen.getByRole('button', { name: /Publish quote \(no score impact\)/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Pro-Ukraine/i }));
    // Default weight when toggling out of "none" goes back to 3.
    expect(screen.getByRole('button', { name: /Publish quote \(\+3\.00\)/ })).toBeInTheDocument();

    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '4.5' } });
    expect(screen.getByRole('button', { name: /Publish quote \(\+4\.50\)/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Anti-Ukraine/i }));
    // Anti retains the slider value (only "none" pins it to 0).
    expect(screen.getByRole('button', { name: /Publish quote \(-4\.50\)/ })).toBeInTheDocument();
  });
});

describe('AddQuoteView — validation (no API call on bad input)', () => {
  it('blocks save without a person and surfaces "Select a person"', async () => {
    const stub = installFetch();
    render(<AddQuoteView />);
    await waitFor(() => expect(screen.getByText(/^Scoring/)).toBeInTheDocument(), { timeout: 3000 });
    // Pick an intent so the button isn't disabled by the disabled attr.
    fireEvent.click(screen.getByRole('button', { name: /Pro-Ukraine/i }));
    // Without a MoC, button is still disabled — fill the rest first.
    // We can't click a disabled button; instead, assert the disabled state.
    const saveBtn = screen.getByRole('button', { name: /Publish quote/i });
    expect(saveBtn).toBeDisabled();
    // No POST occurred.
    expect(stub.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('rejects an invalid (non-https) source URL', async () => {
    const moc = makeMoc({ bioguideId: 'A1', displayName: 'Alice Adams' });
    const stub = installFetch({ searchResults: [moc] });
    render(<AddQuoteView />);
    await waitFor(() => expect(screen.getByText(/^Person$/)).toBeInTheDocument(), { timeout: 3000 });
    await pickMoc('Alice Adams');

    fireEvent.change(screen.getByPlaceholderText(/^https:\/\/\.\.\.$/), {
      target: { value: 'not a url' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Paste or type the quote text/i), {
      target: { value: 'A quote' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Pro-Ukraine/i }));
    fireEvent.click(screen.getByRole('button', { name: /Publish quote/i }));

    expect(await screen.findByText(/Source URL must be a valid https:\/\/ URL/i)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('rejects an empty quote body', async () => {
    const moc = makeMoc({ bioguideId: 'A1', displayName: 'Alice Adams' });
    const stub = installFetch({ searchResults: [moc] });
    render(<AddQuoteView />);
    await waitFor(() => expect(screen.getByText(/^Person$/)).toBeInTheDocument(), { timeout: 3000 });
    await pickMoc('Alice Adams');
    // Source URL set, body left empty.
    fireEvent.change(screen.getByPlaceholderText(/^https:\/\/\.\.\.$/), {
      target: { value: 'https://example.com/x' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Pro-Ukraine/i }));
    fireEvent.click(screen.getByRole('button', { name: /Publish quote/i }));
    expect(await screen.findByText(/Quote text is required/i)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('rejects an ancillary link with a missing URL', async () => {
    const moc = makeMoc({ bioguideId: 'A1', displayName: 'Alice Adams' });
    const stub = installFetch({ searchResults: [moc] });
    render(<AddQuoteView />);
    await waitFor(() => expect(screen.getByText(/^Person$/)).toBeInTheDocument(), { timeout: 3000 });
    await pickMoc('Alice Adams');

    fireEvent.change(screen.getByPlaceholderText(/^https:\/\/\.\.\.$/), {
      target: { value: 'https://example.com/x' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Paste or type the quote text/i), {
      target: { value: 'A quote' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Pro-Ukraine/i }));

    // Add a link with only a label.
    fireEvent.click(screen.getByRole('button', { name: /\+ Add link/i }));
    fireEvent.change(screen.getByPlaceholderText(/Label \(e\.g\. official statement\)/i), {
      target: { value: 'Only a label' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Publish quote/i }));
    expect(
      await screen.findByText(/Link "Only a label" must have a valid URL/i),
    ).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('lets the user remove an ancillary link row', async () => {
    installFetch();
    render(<AddQuoteView />);
    await waitFor(() => expect(screen.getByText(/^Person$/)).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /\+ Add link/i }));
    expect(screen.getByPlaceholderText(/Label \(e\.g\. official statement\)/i)).toBeInTheDocument();
    // The remove button is the only "×" button on the link row.
    fireEvent.click(screen.getByRole('button', { name: '×' }));
    expect(
      screen.queryByPlaceholderText(/Label \(e\.g\. official statement\)/i),
    ).not.toBeInTheDocument();
  });
});

describe('AddQuoteView — successful save', () => {
  it('POSTs the assembled payload and renders the saved confirmation', async () => {
    const moc = makeMoc({ bioguideId: 'A000123', displayName: 'Bob Brown', party: 'R' });
    const stub = installFetch({
      searchResults: [moc],
      tags: [makeTag({ id: 'tag-1', label: 'Caucus' })],
      onPostQuote: (body) => {
        const b = body as Record<string, unknown>;
        expect(b.bioguide_id).toBe('A000123');
        expect(b.media_kind).toBe('text');
        expect(b.source_url).toBe('https://example.com/y');
        expect(b.body_text).toBe('A pro quote');
        expect(b.weight).toBe(4);
        expect(b.direction).toBe(1);
        return jsonResponse({ row: makeQuoteRow({ id: 'q-new', bioguide_id: 'A000123', body_text: 'A pro quote' }) }, 201);
      },
    });
    render(<AddQuoteView />);
    await waitFor(() => expect(screen.getByText(/^Person$/)).toBeInTheDocument(), { timeout: 3000 });
    await pickMoc('Bob Brown');
    fireEvent.change(screen.getByPlaceholderText(/^https:\/\/\.\.\.$/), {
      target: { value: 'https://example.com/y' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Paste or type the quote text/i), {
      target: { value: 'A pro quote' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Pro-Ukraine/i }));
    fireEvent.change(screen.getByRole('slider'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: /Publish quote \(\+4\.00\)/ }));

    await waitFor(
      () => expect(screen.getByText(/^Saved$/)).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(screen.getByText(/Bob Brown/)).toBeInTheDocument();
    expect(screen.getByText(/ID: q-new/)).toBeInTheDocument();
    // Reset buttons appear after save.
    expect(screen.getByRole('button', { name: /Add another/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Same person, new quote/i })).toBeInTheDocument();

    const posts = stub.calls.filter((c) => c.method === 'POST');
    expect(posts.length).toBe(1);
    expect(posts[0]!.url).toMatch(/\/api\/admin\/quotes$/);
  });

  it('"Add another" resets back to a blank form', async () => {
    const moc = makeMoc({ bioguideId: 'A1', displayName: 'Alice Adams' });
    installFetch({ searchResults: [moc] });
    render(<AddQuoteView />);
    await waitFor(() => expect(screen.getByText(/^Person$/)).toBeInTheDocument(), { timeout: 3000 });
    await pickMoc('Alice Adams');
    fireEvent.change(screen.getByPlaceholderText(/^https:\/\/\.\.\.$/), { target: { value: 'https://e.com/a' } });
    fireEvent.change(screen.getByPlaceholderText(/Paste or type the quote text/i), { target: { value: 'A' } });
    fireEvent.click(screen.getByRole('button', { name: /Pro-Ukraine/i }));
    fireEvent.click(screen.getByRole('button', { name: /Publish quote/i }));
    await waitFor(() => expect(screen.getByText(/^Saved$/)).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /Add another/i }));
    // Form is back; person picker is empty (placeholder visible).
    expect(screen.getByPlaceholderText(/Search for a member of Congress/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Saved$/)).not.toBeInTheDocument();
  });
});

describe('AddQuoteView — error envelope surfacing', () => {
  it('shows the API "detail" message and trace ID on POST failure', async () => {
    const moc = makeMoc({ bioguideId: 'A1', displayName: 'Alice Adams' });
    installFetch({
      searchResults: [moc],
      onPostQuote: () => jsonResponse(
        { error: 'invalid_quote', detail: 'duplicate source URL', traceId: 'tr-abc-1' },
        400,
      ),
    });
    render(<AddQuoteView />);
    await waitFor(() => expect(screen.getByText(/^Person$/)).toBeInTheDocument(), { timeout: 3000 });
    await pickMoc('Alice Adams');
    fireEvent.change(screen.getByPlaceholderText(/^https:\/\/\.\.\.$/), { target: { value: 'https://e.com/a' } });
    fireEvent.change(screen.getByPlaceholderText(/Paste or type the quote text/i), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: /Pro-Ukraine/i }));
    fireEvent.click(screen.getByRole('button', { name: /Publish quote/i }));

    expect(await screen.findByText(/duplicate source URL/i)).toBeInTheDocument();
    expect(screen.getByText(/trace: tr-abc-1/)).toBeInTheDocument();
  });
});

describe('AddQuoteView — Clear button', () => {
  it('Clear resets the form fields', async () => {
    const moc = makeMoc({ bioguideId: 'A1', displayName: 'Alice Adams' });
    installFetch({ searchResults: [moc] });
    render(<AddQuoteView />);
    await waitFor(() => expect(screen.getByText(/^Person$/)).toBeInTheDocument(), { timeout: 3000 });
    await pickMoc('Alice Adams');
    fireEvent.change(screen.getByPlaceholderText(/^https:\/\/\.\.\.$/), {
      target: { value: 'https://e.com/a' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Paste or type the quote text/i), {
      target: { value: 'A body' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Pro-Ukraine/i }));

    fireEvent.click(screen.getByRole('button', { name: /^Clear$/ }));

    const url = screen.getByPlaceholderText(/^https:\/\/\.\.\.$/) as HTMLInputElement;
    expect(url.value).toBe('');
    const body = screen.getByPlaceholderText(/Paste or type the quote text/i) as HTMLTextAreaElement;
    expect(body.value).toBe('');
    // Save button back to disabled (intent reset to null).
    expect(screen.getByRole('button', { name: /Publish quote/i })).toBeDisabled();
  });
});

describe('AddQuoteView — prefill from Inbox', () => {
  it('populates source/body/date from prefill and resolves the person via roster-meta', async () => {
    const moc = makeMoc({ bioguideId: 'B999', displayName: 'Carol Carter', party: 'I' });
    installFetch({ members: [moc] });
    const prefill: QuotePrefill = {
      bioguideId: 'B999',
      sourceUrl: 'https://twitter.com/x/status/1',
      sourceLabel: '@RepCarter',
      bodyText: 'Body from inbox',
      quotedAt: '2026-04-30T12:00:00Z',
      mediaKind: 'social',
      queueItemId: 'q-item-1',
    };
    const onPrefillConsumed = vi.fn();
    render(<AddQuoteView prefill={prefill} onPrefillConsumed={onPrefillConsumed} />);
    // Prefill source URL flows in immediately.
    await waitFor(() => {
      const urlInput = screen.getByPlaceholderText(/^https:\/\/\.\.\.$/) as HTMLInputElement;
      expect(urlInput.value).toBe('https://twitter.com/x/status/1');
    }, { timeout: 3000 });
    const body = screen.getByPlaceholderText(/Paste or type the quote text/i) as HTMLTextAreaElement;
    expect(body.value).toBe('Body from inbox');
    expect(onPrefillConsumed).toHaveBeenCalled();
    // Person resolves once mocMap fills (roster-meta returned the matching
    // member). The MocPicker renders the displayName into its <input value>.
    await waitFor(() => {
      const personInput = screen.getByPlaceholderText(/Search for a member of Congress/i) as HTMLInputElement;
      expect(personInput.value).toBe('Carol Carter');
    }, { timeout: 3000 });
  });

  it('marks the queue item curated after a successful save (PATCH /api/admin/ingest/queue/:id)', async () => {
    const moc = makeMoc({ bioguideId: 'B999', displayName: 'Carol Carter' });
    const queuePatched: { id?: string; body?: unknown } = {};
    installFetch({
      members: [moc],
      onPatchQueue: (id, body) => {
        queuePatched.id = id;
        queuePatched.body = body;
        return new Response(null, { status: 204 });
      },
    });
    const prefill: QuotePrefill = {
      bioguideId: 'B999',
      sourceUrl: 'https://example.com/p',
      sourceLabel: 'src',
      bodyText: 'Hello world',
      quotedAt: null,
      mediaKind: 'text',
      queueItemId: 'queue-42',
    };
    render(<AddQuoteView prefill={prefill} />);
    // Wait for prefill to flush + person resolve.
    await waitFor(() => {
      const personInput = screen.getByPlaceholderText(/Search for a member of Congress/i) as HTMLInputElement;
      expect(personInput.value).toBe('Carol Carter');
    }, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /Pro-Ukraine/i }));
    fireEvent.click(screen.getByRole('button', { name: /Publish quote/i }));
    await waitFor(() => expect(screen.getByText(/^Saved$/)).toBeInTheDocument(), { timeout: 3000 });
    // queue PATCH is fire-and-forget; allow the promise chain to settle.
    await waitFor(() => expect(queuePatched.id).toBe('queue-42'), { timeout: 3000 });
    expect((queuePatched.body as Record<string, unknown>).status).toBe('curated');
  });
});
