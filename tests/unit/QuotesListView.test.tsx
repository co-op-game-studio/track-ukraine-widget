/**
 * Tests for src/admin/components/curation/QuotesListView.tsx — the Curation
 * ▸ Quotes browse/edit/delete card list.
 *
 * Trace:
 *   - FR-49 / FR-58 — V4 quotes curation list + inline edit
 *   - "Shared cards over bespoke layouts" (CLAUDE.md) — same QuoteCard shape
 *     as Inbox + Profile history
 *   - audit_log integration — every PATCH/DELETE carries a `_reason` /
 *     `?reason=` flowing into audit_log; backend rejects writes without it
 *
 * Conventions:
 *   - No vi.mock for the SUT; fetch is replaced via globalThis.fetch swap
 *     (mirrors TagsView.test.tsx multi-route handler pattern).
 *   - JSDOM environment from vitest.config.ts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QuotesListView } from '../../src/admin/components/curation/QuotesListView';
import type { QuoteRow, TagRow } from '../../src/admin/types';
import type { MocEntry } from '../../src/admin/components/MocPicker';

const realFetch = globalThis.fetch;

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

function makeQuoteRow(overrides: Partial<QuoteRow> = {}): QuoteRow {
  return {
    id: overrides.id ?? 'q-1',
    bioguide_id: overrides.bioguide_id ?? 'A000001',
    media_kind: overrides.media_kind ?? 'text',
    source_url: overrides.source_url ?? 'https://example.com/x',
    source_label: overrides.source_label ?? null,
    quoted_at: overrides.quoted_at ?? null,
    body_text: overrides.body_text ?? 'A quote body',
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
  quotes?: QuoteRow[];
  tags?: TagRow[];
  members?: MocEntry[];
  onPatchQuote?: (id: string, body: unknown) => Response | Promise<Response>;
  onDeleteQuote?: (id: string, query: string) => Response | Promise<Response>;
}

/**
 * Multi-route fetch stub. Routes:
 *   GET /api/admin/ingest/roster-meta → { members }
 *   GET /api/admin/quotes?...         → { items: quotesRef.current }
 *   GET /api/admin/tags               → { items: tagsRef.current }
 *   PATCH /api/admin/quotes/:id       → onPatchQuote() or default
 *   DELETE /api/admin/quotes/:id?...  → onDeleteQuote() or 204
 */
function installFetch(opts: InstallOpts = {}): {
  calls: FetchCall[];
  setQuotes: (next: QuoteRow[]) => void;
} {
  const calls: FetchCall[] = [];
  const quotesRef = { current: opts.quotes ?? [] };
  const tagsRef = { current: opts.tags ?? [] };
  const members = opts.members ?? [];
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
    if (method === 'GET' && url.includes('/api/admin/quotes')) {
      return jsonResponse({ items: quotesRef.current });
    }
    if (method === 'GET' && url.endsWith('/api/admin/tags')) {
      return jsonResponse({ items: tagsRef.current });
    }
    const patchMatch = /\/api\/admin\/quotes\/([^?]+)$/.exec(url);
    if (method === 'PATCH' && patchMatch) {
      if (opts.onPatchQuote) return opts.onPatchQuote(patchMatch[1]!, body);
      return jsonResponse({ row: makeQuoteRow({ id: patchMatch[1]! }) });
    }
    const delMatch = /\/api\/admin\/quotes\/([^?]+?)(?:\?(.*))?$/.exec(url);
    if (method === 'DELETE' && delMatch) {
      if (opts.onDeleteQuote) return opts.onDeleteQuote(delMatch[1]!, delMatch[2] ?? '');
      return new Response(null, { status: 204 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return {
    calls,
    setQuotes: (next) => { quotesRef.current = next; },
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

describe('QuotesListView — list load', () => {
  it('shows "Loading…" and then renders the count + cards', async () => {
    installFetch({
      quotes: [
        makeQuoteRow({ id: 'q-a', body_text: 'Alpha body' }),
        makeQuoteRow({ id: 'q-b', body_text: 'Bravo body', direction: -1 }),
      ],
      members: [makeMoc({ bioguideId: 'A000001', displayName: 'Alice Adams' })],
    });
    render(<QuotesListView onNavigateToPerson={() => {}} />);
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByText(/2 quotes/)).toBeInTheDocument();
    expect(screen.getByText('Alpha body')).toBeInTheDocument();
    expect(screen.getByText('Bravo body')).toBeInTheDocument();
  });

  it('handles a GET failure by showing 0 quotes', async () => {
    installFetch();
    render(<QuotesListView onNavigateToPerson={() => {}} />);
    await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByText(/0 quotes/)).toBeInTheDocument();
  });

  it('renders the person link with displayName when roster-meta resolves', async () => {
    installFetch({
      quotes: [makeQuoteRow({ id: 'q-1', bioguide_id: 'A000001' })],
      members: [makeMoc({ bioguideId: 'A000001', displayName: 'Alice Adams', party: 'D' })],
    });
    render(<QuotesListView onNavigateToPerson={() => {}} />);
    await waitFor(
      () => expect(screen.getByRole('link', { name: 'Alice Adams' })).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it('falls back to the bioguide_id when the member is not in the roster map', async () => {
    installFetch({
      quotes: [makeQuoteRow({ id: 'q-1', bioguide_id: 'X999' })],
      // No members → mocMap is empty.
    });
    render(<QuotesListView onNavigateToPerson={() => {}} />);
    await waitFor(() => expect(screen.getByText('X999')).toBeInTheDocument(), { timeout: 3000 });
  });

  it('clicking the person link calls onNavigateToPerson(bioguideId) without opening a new tab', async () => {
    installFetch({
      quotes: [makeQuoteRow({ id: 'q-1', bioguide_id: 'A000001' })],
      members: [makeMoc({ bioguideId: 'A000001', displayName: 'Alice Adams' })],
    });
    const onNav = vi.fn();
    render(<QuotesListView onNavigateToPerson={onNav} />);
    const link = await screen.findByRole('link', { name: 'Alice Adams' });
    fireEvent.click(link);
    expect(onNav).toHaveBeenCalledWith('A000001');
  });
});

describe('QuotesListView — direction filter', () => {
  it('"Pro-Ukraine only" hides anti + no-score quotes', async () => {
    installFetch({
      quotes: [
        makeQuoteRow({ id: 'q-pro', body_text: 'Pro body', direction: 1 }),
        makeQuoteRow({ id: 'q-anti', body_text: 'Anti body', direction: -1 }),
        makeQuoteRow({ id: 'q-none', body_text: 'Neutral body', direction: 0 }),
      ],
      members: [makeMoc()],
    });
    render(<QuotesListView onNavigateToPerson={() => {}} />);
    await waitFor(() => expect(screen.getByText(/3 quotes/)).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.change(screen.getByDisplayValue('All directions'), { target: { value: 'pro' } });
    expect(screen.getByText(/1 quote\b/)).toBeInTheDocument();
    expect(screen.getByText('Pro body')).toBeInTheDocument();
    expect(screen.queryByText('Anti body')).not.toBeInTheDocument();
    expect(screen.queryByText('Neutral body')).not.toBeInTheDocument();
  });

  it('"No score impact" only shows direction=0 quotes', async () => {
    installFetch({
      quotes: [
        makeQuoteRow({ id: 'q-pro', body_text: 'Pro body', direction: 1 }),
        makeQuoteRow({ id: 'q-none', body_text: 'Neutral body', direction: 0 }),
      ],
      members: [makeMoc()],
    });
    render(<QuotesListView onNavigateToPerson={() => {}} />);
    await waitFor(() => expect(screen.getByText(/2 quotes/)).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.change(screen.getByDisplayValue('All directions'), { target: { value: 'none' } });
    expect(screen.getByText(/1 quote\b/)).toBeInTheDocument();
    expect(screen.getByText('Neutral body')).toBeInTheDocument();
    expect(screen.queryByText('Pro body')).not.toBeInTheDocument();
  });
});

describe('QuotesListView — refresh button', () => {
  it('clicking ↻ Refresh re-issues a GET /api/admin/quotes', async () => {
    const stub = installFetch({ quotes: [makeQuoteRow()] });
    render(<QuotesListView onNavigateToPerson={() => {}} />);
    await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument(), {
      timeout: 3000,
    });
    const before = stub.calls.filter((c) => c.url.includes('/api/admin/quotes')).length;
    fireEvent.click(screen.getByRole('button', { name: /Refresh/i }));
    await waitFor(() => {
      const after = stub.calls.filter((c) => c.url.includes('/api/admin/quotes')).length;
      expect(after).toBeGreaterThan(before);
    }, { timeout: 3000 });
  });
});

describe('QuotesListView — score badge rendering', () => {
  it('renders +weight for pro, -weight for anti, "no score" for neutral', async () => {
    installFetch({
      quotes: [
        makeQuoteRow({ id: 'q-pro', body_text: 'Pro body', direction: 1, weight: 3 }),
        makeQuoteRow({ id: 'q-anti', body_text: 'Anti body', direction: -1, weight: 2 }),
        makeQuoteRow({ id: 'q-none', body_text: 'Neutral body', direction: 0, weight: 0 }),
      ],
      members: [makeMoc()],
    });
    render(<QuotesListView onNavigateToPerson={() => {}} />);
    await waitFor(() => expect(screen.getByText(/3 quotes/)).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText('+3.00')).toBeInTheDocument();
    expect(screen.getByText('-2.00')).toBeInTheDocument();
    expect(screen.getByText('no score')).toBeInTheDocument();
  });

  it('truncates long bodies with an ellipsis at 300 chars', async () => {
    const long = 'x'.repeat(305);
    installFetch({
      quotes: [makeQuoteRow({ id: 'q-long', body_text: long })],
      members: [makeMoc()],
    });
    render(<QuotesListView onNavigateToPerson={() => {}} />);
    await waitFor(() => expect(screen.getByText(/1 quote\b/)).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText('x'.repeat(300) + '…')).toBeInTheDocument();
  });
});

describe('QuotesListView — inline edit', () => {
  it('clicking Edit opens the inline editor pre-populated with body + comment', async () => {
    installFetch({
      quotes: [makeQuoteRow({ id: 'q-1', body_text: 'Original', comment: 'A note' })],
      members: [makeMoc()],
    });
    render(<QuotesListView onNavigateToPerson={() => {}} />);
    await waitFor(() => expect(screen.getByText('Original')).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    expect(screen.getByDisplayValue('Original')).toBeInTheDocument();
    expect(screen.getByDisplayValue('A note')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Why are you editing this/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeInTheDocument();
  });

  it('Cancel closes the editor without PATCHing', async () => {
    const stub = installFetch({
      quotes: [makeQuoteRow({ id: 'q-1', body_text: 'Original' })],
      members: [makeMoc()],
    });
    render(<QuotesListView onNavigateToPerson={() => {}} />);
    await waitFor(() => expect(screen.getByText('Original')).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeInTheDocument();
    // Two "Cancel" buttons exist: the Edit toggle (now labelled "Cancel") and
    // the InlineEditor's own Cancel. Either closes the editor; click the
    // first (the toggle) to mirror the same code path the user sees first.
    const cancelButtons = screen.getAllByRole('button', { name: /^Cancel$/ });
    expect(cancelButtons.length).toBeGreaterThan(0);
    fireEvent.click(cancelButtons[0]!);
    await waitFor(
      () => expect(screen.queryByRole('button', { name: /^Save$/ })).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(stub.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('Save is disabled until a reason is filled in', async () => {
    installFetch({
      quotes: [makeQuoteRow({ id: 'q-1' })],
      members: [makeMoc()],
    });
    render(<QuotesListView onNavigateToPerson={() => {}} />);
    await waitFor(() => expect(screen.getByText(/1 quote\b/)).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/Why are you editing this/i), {
      target: { value: 'fix typo' },
    });
    expect(screen.getByRole('button', { name: /^Save$/ })).not.toBeDisabled();
  });

  it('PATCHes /api/admin/quotes/:id with body, score + _reason', async () => {
    const stub = installFetch({
      quotes: [makeQuoteRow({ id: 'q-1', body_text: 'Original', direction: 1, weight: 3 })],
      members: [makeMoc()],
      onPatchQuote: (id, body) => {
        expect(id).toBe('q-1');
        const b = body as Record<string, unknown>;
        expect(b.body_text).toBe('Edited body');
        expect(b._reason).toBe('typo');
        expect(b.direction).toBe(-1);
        expect(b.weight).toBe(3);
        return jsonResponse({ row: makeQuoteRow({ id: 'q-1', body_text: 'Edited body', direction: -1 }) });
      },
    });
    render(<QuotesListView onNavigateToPerson={() => {}} />);
    await waitFor(() => expect(screen.getByText('Original')).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Edited body' } });
    // Switch direction to anti.
    fireEvent.click(screen.getByRole('button', { name: /Anti-Ukraine/i }));
    fireEvent.change(screen.getByPlaceholderText(/Why are you editing this/i), {
      target: { value: 'typo' },
    });
    // After the PATCH succeeds, the editor closes + the list re-fetches.
    stub.setQuotes([makeQuoteRow({ id: 'q-1', body_text: 'Edited body', direction: -1 })]);
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(screen.getByText('Edited body')).toBeInTheDocument(), { timeout: 3000 });
    const patches = stub.calls.filter((c) => c.method === 'PATCH');
    expect(patches.length).toBe(1);
  });

  it('"No score" pins weight to 0 in the PATCH payload', async () => {
    const captured: { body?: unknown } = {};
    installFetch({
      quotes: [makeQuoteRow({ id: 'q-1', body_text: 'Body', direction: 1, weight: 4 })],
      members: [makeMoc()],
      onPatchQuote: (_id, body) => {
        captured.body = body;
        return jsonResponse({ row: makeQuoteRow({ id: 'q-1' }) });
      },
    });
    render(<QuotesListView onNavigateToPerson={() => {}} />);
    await waitFor(() => expect(screen.getByText('Body')).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    fireEvent.click(screen.getByRole('button', { name: /No score/i }));
    fireEvent.change(screen.getByPlaceholderText(/Why are you editing this/i), {
      target: { value: 'demote' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => {
      expect(captured.body).toBeDefined();
    }, { timeout: 3000 });
    const b = captured.body as Record<string, unknown>;
    expect(b.direction).toBe(0);
    expect(b.weight).toBe(0);
  });

  it('surfaces the API error message on PATCH failure', async () => {
    installFetch({
      quotes: [makeQuoteRow({ id: 'q-1', body_text: 'Original' })],
      members: [makeMoc()],
      onPatchQuote: () => jsonResponse(
        { error: 'invalid_quote', detail: 'bad payload', traceId: 'tr-edit-1' },
        400,
      ),
    });
    render(<QuotesListView onNavigateToPerson={() => {}} />);
    await waitFor(() => expect(screen.getByText('Original')).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    fireEvent.change(screen.getByPlaceholderText(/Why are you editing this/i), {
      target: { value: 'rev' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    expect(await screen.findByText(/bad payload/i)).toBeInTheDocument();
  });
});

describe('QuotesListView — tag rendering in cards', () => {
  it('renders attached tag chips on each card', async () => {
    installFetch({
      quotes: [
        makeQuoteRow({
          id: 'q-1',
          body_text: 'Tagged quote',
          tags: [makeTag({ id: 't-x', label: 'Caucus' })],
        }),
      ],
      members: [makeMoc()],
    });
    render(<QuotesListView onNavigateToPerson={() => {}} />);
    await waitFor(() => expect(screen.getByText('Caucus')).toBeInTheDocument(), { timeout: 3000 });
  });
});

describe('QuotesListView — delete flow', () => {
  it('cancels the prompt → no DELETE issued', async () => {
    const stub = installFetch({
      quotes: [makeQuoteRow({ id: 'q-1', body_text: 'A body' })],
      members: [makeMoc()],
    });
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue(null);
    render(<QuotesListView onNavigateToPerson={() => {}} />);
    await waitFor(() => expect(screen.getByText('A body')).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    expect(promptSpy).toHaveBeenCalled();
    expect(stub.calls.some((c) => c.method === 'DELETE')).toBe(false);
    promptSpy.mockRestore();
  });

  it('blank-string prompt response is treated as cancel', async () => {
    const stub = installFetch({
      quotes: [makeQuoteRow({ id: 'q-1', body_text: 'A body' })],
      members: [makeMoc()],
    });
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('   ');
    render(<QuotesListView onNavigateToPerson={() => {}} />);
    await waitFor(() => expect(screen.getByText('A body')).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    expect(stub.calls.some((c) => c.method === 'DELETE')).toBe(false);
    promptSpy.mockRestore();
  });

  it('DELETE /api/admin/quotes/:id?reason=... is issued and list refreshes', async () => {
    const stub = installFetch({
      quotes: [makeQuoteRow({ id: 'q-1', body_text: 'Doomed' })],
      members: [makeMoc()],
      onDeleteQuote: (id, query) => {
        expect(id).toBe('q-1');
        expect(query).toMatch(/reason=/);
        expect(decodeURIComponent(query)).toContain('reason=duplicate');
        return new Response(null, { status: 204 });
      },
    });
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('duplicate');
    render(<QuotesListView onNavigateToPerson={() => {}} />);
    await waitFor(() => expect(screen.getByText('Doomed')).toBeInTheDocument(), { timeout: 3000 });
    stub.setQuotes([]);
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    await waitFor(() => expect(screen.queryByText('Doomed')).not.toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(stub.calls.filter((c) => c.method === 'DELETE').length).toBe(1);
    promptSpy.mockRestore();
  });

  it('shows alert() with the API error message on delete failure', async () => {
    installFetch({
      quotes: [makeQuoteRow({ id: 'q-1', body_text: 'Doomed' })],
      members: [makeMoc()],
      onDeleteQuote: () => jsonResponse(
        { error: 'forbidden', detail: 'not allowed' },
        403,
      ),
    });
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('reason');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<QuotesListView onNavigateToPerson={() => {}} />);
    await waitFor(() => expect(screen.getByText('Doomed')).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalled(), { timeout: 3000 });
    expect(String(alertSpy.mock.calls[0]?.[0])).toMatch(/Delete failed.*not allowed/i);
    promptSpy.mockRestore();
    alertSpy.mockRestore();
  });
});
