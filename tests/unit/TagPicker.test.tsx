/**
 * TagPicker — multi-select chip picker with built-in "+ New tag" inline-create.
 *
 * Per CLAUDE.md "Tags are a system primitive": when adding categorization to
 * any resource, prefer the shared `tags` table (color-coded, audited, single
 * CRUD UI under Settings ▸ Tags) over per-resource enum columns. The
 * TagPicker is the shared selector so any consumer of the picker (Add Quote,
 * inline edit, future quote-bearing surfaces) gets on-the-fly tag creation
 * for free without re-implementing it.
 *
 * These tests cover the picker behavior end-to-end plus the two un-exported
 * helpers in `src/admin/components/Tag.tsx` exercised through the picker:
 *
 *   - `slugify()` — derives the POST body's `slug` from the user-typed label.
 *     We assert the slug shape via the recorded POST body for a range of
 *     input shapes (uppercase, accents, spaces, punctuation, length cap,
 *     leading/trailing dashes).
 *   - `errorMsgOf()` — extracts a human-readable message from an unknown
 *     error. Each known error shape is exercised by stubbing `globalThis.fetch`
 *     so that the fetcher's `parseError` produces the corresponding `FetchError`
 *     object (which has `error` and optional `detail`), or a plain Error
 *     (network failure), and we assert the rendered create-error text.
 *
 * Conventions:
 *   - No `vi.mock` — `globalThis.fetch` is replaced via swap (see
 *     TagsView.test.tsx for the canonical multi-route stub helper).
 *   - JSDOM environment from vitest.config.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { TagPicker } from '../../src/admin/components/Tag';
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

function installFetch(opts: {
  onPost?: (body: unknown) => Response | Promise<Response>;
}): { calls: FetchCall[] } {
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
    if (method === 'POST' && url.endsWith('/api/admin/tags')) {
      if (opts.onPost) return opts.onPost(body);
      return jsonResponse({ tag: makeTag({ id: 'new' }) }, 201);
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { calls };
}

/**
 * Controlled wrapper that stores `selectedIds` in local state so the picker
 * sees its updates after `onChange` fires. Mirrors how real consumers
 * (Add Quote, inline edit) own the selected-id state.
 */
function ControlledPicker(props: {
  available: TagRow[];
  initialSelected?: string[];
  onChangeSpy?: (next: string[]) => void;
  onTagCreated?: (t: TagRow) => void;
  allowInlineCreate?: boolean;
  /** Render the create button if and only if onTagCreated is supplied. */
  withCreated?: boolean;
}): React.ReactElement {
  const [available, setAvailable] = useState<TagRow[]>(props.available);
  const [selected, setSelected] = useState<string[]>(props.initialSelected ?? []);
  const onTagCreated = props.withCreated === false
    ? undefined
    : (t: TagRow) => {
        setAvailable((prev) => [...prev, t]);
        props.onTagCreated?.(t);
      };
  return (
    <TagPicker
      available={available}
      selectedIds={selected}
      onChange={(next) => { setSelected(next); props.onChangeSpy?.(next); }}
      onTagCreated={onTagCreated}
      allowInlineCreate={props.allowInlineCreate}
    />
  );
}

beforeEach(() => {
  // Per-test fetch installation.
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('TagPicker — render', () => {
  it('renders all available tags as toggle buttons', () => {
    render(<ControlledPicker available={[
      makeTag({ id: 't-1', label: 'Alpha' }),
      makeTag({ id: 't-2', label: 'Beta' }),
    ]} />);
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Beta' })).toBeInTheDocument();
  });

  it('shows "No tags yet." when available is empty (and not creating)', () => {
    render(<ControlledPicker available={[]} withCreated={false} />);
    expect(screen.getByText(/No tags yet/i)).toBeInTheDocument();
  });

  it('renders the "+ New tag" affordance when onTagCreated is provided', () => {
    render(<ControlledPicker available={[]} />);
    expect(screen.getByRole('button', { name: /\+ New tag/ })).toBeInTheDocument();
  });

  it('hides the "+ New tag" affordance when onTagCreated is omitted', () => {
    render(<ControlledPicker available={[]} withCreated={false} />);
    expect(screen.queryByRole('button', { name: /\+ New tag/ })).toBeNull();
  });

  it('hides the "+ New tag" affordance when allowInlineCreate=false', () => {
    render(<ControlledPicker available={[]} allowInlineCreate={false} />);
    expect(screen.queryByRole('button', { name: /\+ New tag/ })).toBeNull();
  });

  it('paints a selected chip with the tag color background', () => {
    const { container } = render(<ControlledPicker
      available={[makeTag({ id: 't-1', label: 'Selected', color: '#3b82f6' })]}
      initialSelected={['t-1']}
    />);
    const btn = container.querySelector('button[title]') as HTMLButtonElement;
    expect(btn.style.background).toMatch(/#3b82f6|rgb\(59,\s*130,\s*246\)/);
  });

  it('leaves an unselected chip with a transparent background', () => {
    const { container } = render(<ControlledPicker
      available={[makeTag({ id: 't-1', label: 'NotPicked', color: '#3b82f6' })]}
    />);
    const btn = container.querySelector('button[title]') as HTMLButtonElement;
    expect(btn.style.background).toBe('transparent');
  });

  it('uses black foreground on a light selected chip (luminance flip)', () => {
    const { container } = render(<ControlledPicker
      available={[makeTag({ id: 't-1', label: 'Bright', color: '#ffffff' })]}
      initialSelected={['t-1']}
    />);
    const btn = container.querySelector('button[title]') as HTMLButtonElement;
    expect(btn.style.color).toBe('rgb(0, 0, 0)');
  });

  it('uses white foreground on a dark selected chip', () => {
    const { container } = render(<ControlledPicker
      available={[makeTag({ id: 't-1', label: 'Dark', color: '#000000' })]}
      initialSelected={['t-1']}
    />);
    const btn = container.querySelector('button[title]') as HTMLButtonElement;
    expect(btn.style.color).toBe('rgb(255, 255, 255)');
  });
});

describe('TagPicker — toggle selection', () => {
  it('clicking an unselected chip adds its id to onChange', () => {
    const onChange = vi.fn();
    render(<ControlledPicker
      available={[makeTag({ id: 't-1', label: 'Alpha' })]}
      onChangeSpy={onChange}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(onChange).toHaveBeenCalledWith(['t-1']);
  });

  it('clicking a selected chip removes its id from onChange', () => {
    const onChange = vi.fn();
    render(<ControlledPicker
      available={[makeTag({ id: 't-1', label: 'Alpha' })]}
      initialSelected={['t-1']}
      onChangeSpy={onChange}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('preserves other selected ids when toggling one tag off', () => {
    const onChange = vi.fn();
    render(<ControlledPicker
      available={[
        makeTag({ id: 't-1', label: 'Alpha' }),
        makeTag({ id: 't-2', label: 'Beta' }),
      ]}
      initialSelected={['t-1', 't-2']}
      onChangeSpy={onChange}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(onChange).toHaveBeenCalledWith(['t-2']);
  });

  it('toggling multiple chips on accumulates the selection', () => {
    const onChange = vi.fn();
    render(<ControlledPicker
      available={[
        makeTag({ id: 't-1', label: 'Alpha' }),
        makeTag({ id: 't-2', label: 'Beta' }),
      ]}
      onChangeSpy={onChange}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(onChange).toHaveBeenLastCalledWith(['t-1']);
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }));
    expect(onChange).toHaveBeenLastCalledWith(['t-1', 't-2']);
  });
});

describe('TagPicker — inline-create open/close', () => {
  it('clicking "+ New tag" opens the inline form with name input + preview chip', () => {
    render(<ControlledPicker available={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    expect(screen.getByPlaceholderText(/New tag name/i)).toBeInTheDocument();
    // Live preview chip falls back to "preview" placeholder text.
    expect(screen.getByText(/preview/i)).toBeInTheDocument();
    // Quick-color swatches render aria-labels for each entry.
    expect(screen.getByRole('button', { name: /Pick color #ef4444/i })).toBeInTheDocument();
  });

  it('hides "+ New tag" while the form is open and re-shows it after Cancel', () => {
    render(<ControlledPicker available={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    expect(screen.queryByRole('button', { name: /\+ New tag/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(screen.getByRole('button', { name: /\+ New tag/ })).toBeInTheDocument();
  });

  it('Escape closes the inline form without posting', () => {
    const stub = installFetch({});
    render(<ControlledPicker available={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    const input = screen.getByPlaceholderText(/New tag name/i);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByRole('button', { name: /\+ New tag/ })).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('Cancel clears any prior error message', async () => {
    installFetch({ onPost: () => jsonResponse({ error: 'invalid_tag', detail: 'bad' }, 400) });
    render(<ControlledPicker available={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    fireEvent.change(screen.getByPlaceholderText(/New tag name/i), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: /Create \+ apply/i }));
    expect(await screen.findByText(/bad/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    expect(screen.queryByText(/bad/)).toBeNull();
  });

  it('typing into the name input updates the preview chip text', () => {
    render(<ControlledPicker available={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    fireEvent.change(screen.getByPlaceholderText(/New tag name/i), { target: { value: 'Hello' } });
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('clicking a quick-color swatch updates the hex text input', () => {
    render(<ControlledPicker available={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    fireEvent.click(screen.getByRole('button', { name: /Pick color #22c55e/i }));
    const hexInput = screen.getByPlaceholderText('#000000') as HTMLInputElement;
    expect(hexInput.value).toBe('#22c55e');
  });

  it('typing into the hex text input updates the chosen color', () => {
    render(<ControlledPicker available={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    const hexInput = screen.getByPlaceholderText('#000000') as HTMLInputElement;
    fireEvent.change(hexInput, { target: { value: '#abcdef' } });
    expect(hexInput.value).toBe('#abcdef');
  });
});

describe('TagPicker — inline-create validation (in-component, no POST)', () => {
  it('an empty/whitespace name disables the submit button', () => {
    render(<ControlledPicker available={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    const submit = screen.getByRole('button', { name: /Create \+ apply/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/New tag name/i), { target: { value: '   ' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/New tag name/i), { target: { value: 'OK' } });
    expect(submit.disabled).toBe(false);
  });

  it('rejects a name that slugifies to empty (only punctuation) without POSTing', async () => {
    const stub = installFetch({});
    render(<ControlledPicker available={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    fireEvent.change(screen.getByPlaceholderText(/New tag name/i), { target: { value: '!!!' } });
    fireEvent.click(screen.getByRole('button', { name: /Create \+ apply/i }));
    expect(await screen.findByText(/must contain a letter or digit/i)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('TagPicker — slugify (exercised via the POST body)', () => {
  /**
   * The slug field on the POST body is produced by `slugify(label)`. Each
   * input below pins the slugify rules end-to-end:
   *   - lowercase
   *   - non-[a-z0-9] runs collapsed to single "-"
   *   - leading/trailing "-" stripped
   *   - capped at 64 chars
   *
   * Note: slugify uses a plain `[^a-z0-9]+` collapse, so accented characters
   * become separators (no NFD normalization). The test pins that behavior.
   */
  async function createAndCaptureBody(label: string): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> = {};
    installFetch({
      onPost: (body) => {
        captured = body as Record<string, unknown>;
        return jsonResponse({ tag: makeTag({ id: 'new', slug: String(captured.slug), label }) }, 201);
      },
    });
    render(<ControlledPicker available={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    fireEvent.change(screen.getByPlaceholderText(/New tag name/i), { target: { value: label } });
    fireEvent.click(screen.getByRole('button', { name: /Create \+ apply/i }));
    await waitFor(() => expect(captured.slug).toBeDefined(), { timeout: 3000 });
    return captured;
  }

  it('lowercases uppercase input', async () => {
    const body = await createAndCaptureBody('UPPER');
    expect(body.slug).toBe('upper');
  });

  it('collapses spaces into single dashes', async () => {
    const body = await createAndCaptureBody('Hello   World');
    expect(body.slug).toBe('hello-world');
  });

  it('strips leading and trailing punctuation/dashes', async () => {
    const body = await createAndCaptureBody('  --Hello!--  ');
    expect(body.slug).toBe('hello');
  });

  it('treats accents as separators (no NFD normalization)', async () => {
    const body = await createAndCaptureBody('café');
    // 'c', 'a', 'f' kept; 'é' is non-[a-z0-9] so becomes a separator that
    // gets stripped (trailing). The result is "caf".
    expect(body.slug).toBe('caf');
  });

  it('collapses mixed punctuation runs into a single dash', async () => {
    const body = await createAndCaptureBody('foo & bar / baz');
    expect(body.slug).toBe('foo-bar-baz');
  });

  it('preserves internal digits', async () => {
    const body = await createAndCaptureBody('Section 230 update');
    expect(body.slug).toBe('section-230-update');
  });

  it('caps the slug at 64 characters', async () => {
    const long = 'a'.repeat(80);
    const body = await createAndCaptureBody(long);
    expect((body.slug as string).length).toBe(64);
  });

  it('passes the trimmed label (not the raw input) as the label field', async () => {
    const body = await createAndCaptureBody('  Padded Label  ');
    expect(body.label).toBe('Padded Label');
    expect(body.slug).toBe('padded-label');
  });
});

describe('TagPicker — successful create flow', () => {
  it('POSTs to /api/admin/tags, calls onTagCreated, auto-applies the new tag, closes the form', async () => {
    const onTagCreated = vi.fn();
    const onChange = vi.fn();
    const newTag = makeTag({ id: 'new-1', slug: 'fresh', label: 'Fresh', color: '#22c55e' });
    const stub = installFetch({
      onPost: () => jsonResponse({ tag: newTag }, 201),
    });
    render(<ControlledPicker
      available={[]}
      onTagCreated={onTagCreated}
      onChangeSpy={onChange}
    />);
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    fireEvent.change(screen.getByPlaceholderText(/New tag name/i), { target: { value: 'Fresh' } });
    fireEvent.click(screen.getByRole('button', { name: /Pick color #22c55e/i }));
    fireEvent.click(screen.getByRole('button', { name: /Create \+ apply/i }));

    await waitFor(() => expect(onTagCreated).toHaveBeenCalledWith(newTag), { timeout: 3000 });
    expect(onChange).toHaveBeenCalledWith(['new-1']);

    // Form closes (the "+ New tag" button reappears).
    await waitFor(() => expect(screen.getByRole('button', { name: /\+ New tag/ })).toBeInTheDocument(), { timeout: 3000 });

    // The new tag is now selectable and visible (parent appended it).
    expect(screen.getByRole('button', { name: 'Fresh' })).toBeInTheDocument();

    const post = stub.calls.find((c) => c.method === 'POST')!;
    expect(post.url).toMatch(/\/api\/admin\/tags$/);
    const body = post.body as Record<string, unknown>;
    expect(body.label).toBe('Fresh');
    expect(body.slug).toBe('fresh');
    expect(body.color).toBe('#22c55e');
    expect(body.description).toBeNull();
  });

  it('appends the new id to an existing selection rather than replacing it', async () => {
    const onChange = vi.fn();
    installFetch({
      onPost: () => jsonResponse({ tag: makeTag({ id: 'new-2', label: 'Extra' }) }, 201),
    });
    render(<ControlledPicker
      available={[makeTag({ id: 't-1', label: 'Alpha' })]}
      initialSelected={['t-1']}
      onChangeSpy={onChange}
    />);
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    fireEvent.change(screen.getByPlaceholderText(/New tag name/i), { target: { value: 'Extra' } });
    fireEvent.click(screen.getByRole('button', { name: /Create \+ apply/i }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(['t-1', 'new-2']), { timeout: 3000 });
  });

  it('Enter inside the name input submits the create form', async () => {
    const newTag = makeTag({ id: 'k-1', label: 'Keyboard' });
    const stub = installFetch({
      onPost: () => jsonResponse({ tag: newTag }, 201),
    });
    render(<ControlledPicker available={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    const input = screen.getByPlaceholderText(/New tag name/i);
    fireEvent.change(input, { target: { value: 'Keyboard' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(stub.calls.some((c) => c.method === 'POST')).toBe(true), { timeout: 3000 });
  });
});

describe('TagPicker — errorMsgOf (exercised via failed POST)', () => {
  /**
   * `errorMsgOf` runs in the catch branch of `createTag`. The fetcher throws
   * a `FetchError` (plain object: { status, error, detail?, traceId? }) on
   * non-2xx responses, and a real `Error` on network failure. Each branch
   * below pins one shape.
   */

  it('uses obj.detail when the FetchError has a detail string', async () => {
    installFetch({
      onPost: () => jsonResponse({ error: 'invalid_tag', detail: 'Slug already in use' }, 400),
    });
    render(<ControlledPicker available={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    fireEvent.change(screen.getByPlaceholderText(/New tag name/i), { target: { value: 'Dup' } });
    fireEvent.click(screen.getByRole('button', { name: /Create \+ apply/i }));
    expect(await screen.findByText(/Slug already in use/)).toBeInTheDocument();
  });

  it('falls back to obj.error when no detail is present (e.g., "unauthorized")', async () => {
    installFetch({
      onPost: () => jsonResponse({ error: 'unauthorized' }, 401),
    });
    render(<ControlledPicker available={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    fireEvent.change(screen.getByPlaceholderText(/New tag name/i), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: /Create \+ apply/i }));
    expect(await screen.findByText(/unauthorized/)).toBeInTheDocument();
  });

  it('uses Error.message when fetch throws a real Error (network failure)', async () => {
    globalThis.fetch = (async () => { throw new Error('NetworkOffline'); }) as typeof fetch;
    render(<ControlledPicker available={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    fireEvent.change(screen.getByPlaceholderText(/New tag name/i), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: /Create \+ apply/i }));
    expect(await screen.findByText(/NetworkOffline/)).toBeInTheDocument();
  });

  it('falls back to a synthetic http_NNN error code when the body is non-JSON', async () => {
    // Non-JSON body → fetcher.parseError sets error: `http_${status}` with no detail.
    globalThis.fetch = (async () => new Response('plain', { status: 500 })) as typeof fetch;
    render(<ControlledPicker available={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    fireEvent.change(screen.getByPlaceholderText(/New tag name/i), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: /Create \+ apply/i }));
    expect(await screen.findByText(/http_500/)).toBeInTheDocument();
  });

  it('toggles the submit button label between idle and "Creating…" while in flight', async () => {
    const pending: { resolve: ((r: Response) => void) | null } = { resolve: null };
    globalThis.fetch = ((async () => new Promise<Response>((res) => { pending.resolve = res; })) as typeof fetch);
    render(<ControlledPicker available={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ New tag/ }));
    fireEvent.change(screen.getByPlaceholderText(/New tag name/i), { target: { value: 'Slow' } });
    fireEvent.click(screen.getByRole('button', { name: /Create \+ apply/i }));
    // Submitting flag flips the label.
    await waitFor(() => expect(screen.getByRole('button', { name: /Creating/i })).toBeInTheDocument(), { timeout: 3000 });
    // Resolve the in-flight POST so the test does not hang.
    pending.resolve?.(jsonResponse({ tag: makeTag({ id: 'late', label: 'Slow' }) }, 201));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Creating/i })).toBeNull(), { timeout: 3000 });
  });
});
