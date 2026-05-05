/**
 * BillInlineSections — inline editors for votes and comments.
 *
 * Traces to AC-52.23 (supersedes the "+ Add (T-133)" placeholder language).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { BillVotesSection, BillCommentsSection } from '../../src/admin/components/BillInlineSections';

interface RouteCall {
  url: string;
  method: string;
  body: unknown;
}

function installFetch(opts: {
  votes?: unknown[];
  comments?: unknown[];
  onCall?: (c: RouteCall) => void;
} = {}) {
  let votesCallCount = 0;
  let commentsCallCount = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = (init?.method ?? (typeof input !== 'string' ? (input as Request).method : 'GET')) || 'GET';
    const bodyText = (init?.body as string | undefined) ?? null;
    const body = bodyText ? JSON.parse(bodyText) : null;
    opts.onCall?.({ url, method, body });

    if (url.includes('/api/admin/votes') && method === 'GET') {
      votesCallCount++;
      return new Response(JSON.stringify({ items: opts.votes ?? [] }), { status: 200 });
    }
    if (url.includes('/api/admin/comments') && method === 'GET') {
      commentsCallCount++;
      return new Response(JSON.stringify({ items: opts.comments ?? [] }), { status: 200 });
    }
    if (url.match(/\/api\/admin\/votes\/[^/?]+$/) && method === 'PATCH') {
      return new Response(JSON.stringify({ row: { id: 'v1', ...body } }), { status: 200 });
    }
    if (url.match(/\/api\/admin\/votes\/[^?]+\?reason=/) && method === 'DELETE') {
      return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    }
    if (url.endsWith('/api/admin/votes') && method === 'POST') {
      return new Response(
        JSON.stringify({ row: { id: 'v_new', ...body, created_at: 'x', updated_at: 'x' } }),
        { status: 201 },
      );
    }
    if (url.match(/\/api\/admin\/comments\/[^/?]+$/) && method === 'PATCH') {
      return new Response(JSON.stringify({ row: { id: 'c1', ...body } }), { status: 200 });
    }
    if (url.match(/\/api\/admin\/comments\/[^?]+\?reason=/) && method === 'DELETE') {
      return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    }
    if (url.endsWith('/api/admin/comments') && method === 'POST') {
      return new Response(
        JSON.stringify({ row: { id: 'c_new', ...body, created_at: 'x', updated_at: 'x' } }),
        { status: 201 },
      );
    }
    return new Response('not found', { status: 404 });
  });
  return {
    get votesCallCount() { return votesCallCount; },
    get commentsCallCount() { return commentsCallCount; },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

const sampleVote = {
  id: 'v1',
  bill_id: '117-HR-2471',
  chamber: 'House',
  congress: 117,
  session: 2,
  roll_call: 65,
  date: '2022-03-10',
  weight: 0.9,
  direction_multiplier: 1,
  kind: 'concur',
  weight_reason: null,
  url: null,
  action: null,
  action_date: null,
  created_at: 'x',
  updated_at: 'x',
};

const sampleComment = {
  id: 'c1',
  bill_id: '117-HR-2471',
  attached_to_roll_call_id: null,
  body_markdown: 'Bipartisan support note',
  weight: 0.5,
  direction: 1,
  author_email: 'alice@example.com',
  created_at: 'x',
  updated_at: 'x',
};

/* -------------------------------------------------------------------------- */
/*                                Votes editor                                */
/* -------------------------------------------------------------------------- */

describe('BillVotesSection — inline editor (AC-52.23)', () => {
  it('AC-52.23(a)+(d) [updated by AC-52.68]: Save stays enabled; PATCH fires once change-notes is filled', async () => {
    const calls: RouteCall[] = [];
    installFetch({ votes: [sampleVote], onCall: (c) => calls.push(c) });
    render(<BillVotesSection billId="117-HR-2471" />);

    const weightInput = await screen.findByDisplayValue('0.9');
    const row = weightInput.closest('form, [data-row="vote"]') as HTMLElement;
    const saveBtn = within(row).getByRole('button', { name: /^Save$/i });

    // Edit weight, no change-notes yet — Save is enabled (AC-52.68) but won't PATCH.
    fireEvent.change(weightInput, { target: { value: '1.5' } });
    expect(saveBtn).toBeEnabled();

    // Fill change-notes → click Save → PATCH fires with _reason.
    const reasonInput = within(row).getByLabelText(/^Change notes$/i);
    fireEvent.change(reasonInput, { target: { value: 'bumping weight per roll-call review' } });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/votes/v1'));
      expect(patch).toBeDefined();
      const body = patch!.body as Record<string, unknown>;
      expect(body['weight']).toBe(1.5);
      expect(body['_reason']).toBe('bumping weight per roll-call review');
    });
  });

  /* ------------------------------------------------------------------------ */
  /*    AC-52.68 — Save flashes change-notes when empty on update            */
  /* ------------------------------------------------------------------------ */

  it('AC-52.68(i): Save button on existing vote row is NOT disabled when change-notes is empty', async () => {
    installFetch({ votes: [sampleVote] });
    render(<BillVotesSection billId="117-HR-2471" />);
    const weight = await screen.findByDisplayValue('0.9');
    const row = weight.closest('form, [data-row="vote"]') as HTMLElement;
    const saveBtn = within(row).getByRole('button', { name: /^Save$/i });
    // Change-notes is empty (initial render). Save must be enabled per AC-52.68.
    expect(saveBtn).toBeEnabled();
  });

  it('AC-52.68(ii): clicking Save with empty change-notes does NOT fire a PATCH', async () => {
    const calls: RouteCall[] = [];
    installFetch({ votes: [sampleVote], onCall: (c) => calls.push(c) });
    render(<BillVotesSection billId="117-HR-2471" />);
    const weight = await screen.findByDisplayValue('0.9');
    const row = weight.closest('form, [data-row="vote"]') as HTMLElement;

    // Edit weight, leave change-notes empty.
    fireEvent.change(weight, { target: { value: '2.5' } });
    fireEvent.click(within(row).getByRole('button', { name: /^Save$/i }));

    // Give any microtasks a chance to flush.
    await new Promise((r) => setTimeout(r, 50));
    const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/votes/'));
    expect(patch).toBeUndefined();
  });

  it('AC-52.68(iii): Save with empty change-notes flips aria-invalid on the change-notes input', async () => {
    installFetch({ votes: [sampleVote] });
    render(<BillVotesSection billId="117-HR-2471" />);
    const weight = await screen.findByDisplayValue('0.9');
    const row = weight.closest('form, [data-row="vote"]') as HTMLElement;
    const reason = within(row).getByLabelText(/^Change notes$/i) as HTMLInputElement;

    // Pre-click: not invalid.
    expect(reason.getAttribute('aria-invalid')).not.toBe('true');

    fireEvent.click(within(row).getByRole('button', { name: /^Save$/i }));
    // Synchronous state update from onSubmit early-return.
    expect(reason.getAttribute('aria-invalid')).toBe('true');
  });
});

describe('BillCommentsSection — Save flash (AC-52.68)', () => {
  it('AC-52.68(i)+(iii): comment Save stays enabled, flips aria-invalid on empty change-notes', async () => {
    installFetch({ comments: [sampleComment] });
    render(<BillCommentsSection billId="117-HR-2471" />);
    // Open the section (closed by default).
    fireEvent.click(await screen.findByRole('button', { name: /Comments \(/i }));

    const body = await screen.findByDisplayValue('Bipartisan support note');
    const row = body.closest('form, [data-row="comment"]') as HTMLElement;
    const saveBtn = within(row).getByRole('button', { name: /^Save$/i });
    expect(saveBtn).toBeEnabled();

    const reason = within(row).getByLabelText(/^Change notes$/i) as HTMLInputElement;
    expect(reason.getAttribute('aria-invalid')).not.toBe('true');

    fireEvent.click(saveBtn);
    expect(reason.getAttribute('aria-invalid')).toBe('true');
  });

  it('AC-52.68(ii): comment Save with empty change-notes does NOT fire PATCH', async () => {
    const calls: RouteCall[] = [];
    installFetch({ comments: [sampleComment], onCall: (c) => calls.push(c) });
    render(<BillCommentsSection billId="117-HR-2471" />);
    fireEvent.click(await screen.findByRole('button', { name: /Comments \(/i }));

    const body = await screen.findByDisplayValue('Bipartisan support note');
    const row = body.closest('form, [data-row="comment"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /^Save$/i }));

    await new Promise((r) => setTimeout(r, 50));
    const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/comments/'));
    expect(patch).toBeUndefined();
  });

  it('AC-52.46+: votes section has NO manual-add affordance (import-only)', async () => {
    installFetch({ votes: [] });
    render(<BillVotesSection billId="117-HR-2471" />);
    // Wait for the empty-state hint.
    await screen.findByText(/imported from Congress\.gov/i);
    // No "Add" button anywhere in the votes section.
    expect(screen.queryByRole('button', { name: /^Add$/i })).toBeNull();
    // No `data-row="vote-new"` form.
    expect(document.querySelector('[data-row="vote-new"]')).toBeNull();
  });

  it('AC-52.23(e): Delete fires DELETE with ?reason= populated', async () => {
    const calls: RouteCall[] = [];
    installFetch({ votes: [sampleVote], onCall: (c) => calls.push(c) });
    // jsdom's window.confirm always returns true unless stubbed; force true.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(window, 'prompt').mockReturnValue('superseded by roll-call 67');
    render(<BillVotesSection billId="117-HR-2471" />);

    const weightInput = await screen.findByDisplayValue('0.9');
    const row = weightInput.closest('form, [data-row="vote"]') as HTMLElement;
    const delBtn = within(row).getByRole('button', { name: /^Delete$/i });
    fireEvent.click(delBtn);

    await waitFor(() => {
      const del = calls.find((c) => c.method === 'DELETE' && c.url.includes('/votes/v1'));
      expect(del).toBeDefined();
      expect(del!.url).toMatch(/[?&]reason=superseded/);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                              Comments editor                               */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*                       AC-52.24 — bill direction header                     */
/* -------------------------------------------------------------------------- */

describe('BillVotesSection — bill direction context (AC-52.24)', () => {
  it('pro-ukraine: renders strip explaining +1 = for Ukraine, -1 = against', async () => {
    installFetch({ votes: [] });
    render(<BillVotesSection billId="117-HR-2471" billDirection="pro-ukraine" />);
    const strip = await screen.findByTestId('bill-direction-strip');
    expect(strip.textContent).toMatch(/pro-ukraine/i);
    expect(strip.textContent).toMatch(/\+1/);
    expect(strip.textContent).toMatch(/for Ukraine/i);
    expect(strip.textContent).toMatch(/−1|-1/);
    expect(strip.textContent).toMatch(/against/i);
  });

  it('anti-ukraine: signs swapped (+1 = against, -1 = for)', async () => {
    installFetch({ votes: [] });
    render(<BillVotesSection billId="118-HR-9999" billDirection="anti-ukraine" />);
    const strip = await screen.findByTestId('bill-direction-strip');
    expect(strip.textContent).toMatch(/anti-ukraine/i);
    // +1 voting along an anti-ukraine bill = voting AGAINST Ukraine
    expect(strip.textContent).toMatch(/\+1[^−\-]+against/i);
    expect(strip.textContent).toMatch(/(−1|-1)[^+]+for/i);
  });

  it('ambiguous: no positional gloss', async () => {
    installFetch({ votes: [] });
    render(<BillVotesSection billId="118-HR-1" billDirection="ambiguous" />);
    const strip = await screen.findByTestId('bill-direction-strip');
    expect(strip.textContent).toMatch(/ambiguous/i);
    expect(strip.textContent).not.toMatch(/for Ukraine/i);
    expect(strip.textContent).not.toMatch(/against Ukraine/i);
  });
});

/* -------------------------------------------------------------------------- */
/*                       AC-52.25 — vote URL click-through                    */
/* -------------------------------------------------------------------------- */

describe('BillVotesSection — vote URL field (AC-52.25)', () => {
  it('renders ↗ Open link when row has a valid https URL', async () => {
    installFetch({
      votes: [{ ...sampleVote, url: 'https://clerk.house.gov/Votes/2022065' }],
    });
    render(<BillVotesSection billId="117-HR-2471" billDirection="pro-ukraine" />);
    const link = await screen.findByRole('link', { name: /↗ Open/i });
    expect(link).toHaveAttribute('href', 'https://clerk.house.gov/Votes/2022065');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('does NOT render link when URL is empty', async () => {
    installFetch({ votes: [{ ...sampleVote, url: null }] });
    render(<BillVotesSection billId="117-HR-2471" billDirection="pro-ukraine" />);
    await screen.findByDisplayValue('0.9'); // wait for row
    expect(screen.queryByRole('link', { name: /↗ Open/i })).toBeNull();
  });

  it('does NOT render link for javascript: URL (sanitizer rejection)', async () => {
    installFetch({
      votes: [{ ...sampleVote, url: 'javascript:alert(1)' }],
    });
    render(<BillVotesSection billId="117-HR-2471" billDirection="pro-ukraine" />);
    await screen.findByDisplayValue('0.9');
    expect(screen.queryByRole('link', { name: /↗ Open/i })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*           AC-52.27 — static identifiers + labeled editable fields          */
/* -------------------------------------------------------------------------- */

describe('BillVotesSection — static identifiers + labels (AC-52.27)', () => {
  it('AC-52.27(a): existing row renders chamber / roll-call / date / kind as text, not inputs', async () => {
    installFetch({ votes: [sampleVote] });
    render(<BillVotesSection billId="117-HR-2471" billDirection="pro-ukraine" />);
    // Wait for the row.
    const weight = await screen.findByDisplayValue('0.9');
    const row = weight.closest('form, [data-row="vote"]') as HTMLElement;

    // No <select> for chamber on existing rows (it was an editable select before).
    expect(within(row).queryByRole('combobox', { name: /chamber/i })).toBeNull();
    // No <input> with the existing roll_call value.
    const rollCallInputs = within(row).queryAllByDisplayValue('65');
    // 65 is the sample roll_call — must NOT appear as an editable input value.
    expect(rollCallInputs.length).toBe(0);
    // But the value MUST be visible somewhere as static text in the row.
    expect(within(row).getByText(/65/)).toBeInTheDocument();
    // Kind 'concur' must show as text.
    expect(within(row).getByText(/concur/i)).toBeInTheDocument();
    // Chamber 'House' must show as text in the static header.
    expect(within(row).getByText(/House/)).toBeInTheDocument();
  });

  it('AC-52.27(b) + AC-52.61: editable controls (weight, direction, URL, weight_reason, change-notes) all carry visible labels', async () => {
    installFetch({ votes: [sampleVote] });
    render(<BillVotesSection billId="117-HR-2471" billDirection="pro-ukraine" />);
    const weight = await screen.findByDisplayValue('0.9');
    const row = weight.closest('form, [data-row="vote"]') as HTMLElement;
    // AC-52.61 inline edit row: Weight | Direction | URL | Weight rationale.
    // URL became a labeled link inline (replaces the old static-key row).
    expect(within(row).getByText(/^Weight$/i)).toBeInTheDocument();
    expect(within(row).getByText(/^Direction$/i)).toBeInTheDocument();
    expect(within(row).getByText(/^URL$/i)).toBeInTheDocument();
    expect(within(row).getByText(/^Weight rationale$/i)).toBeInTheDocument();
    expect(within(row).getByText(/^Change notes$/i)).toBeInTheDocument();
  });

  it('AC-52.27(c): weight_reason and change-notes label cells have max-width ≤ 60ch', async () => {
    installFetch({ votes: [sampleVote] });
    render(<BillVotesSection billId="117-HR-2471" billDirection="pro-ukraine" />);
    const weight = await screen.findByDisplayValue('0.9');
    const row = weight.closest('form, [data-row="vote"]') as HTMLElement;

    // AC-52.61 — flex sizing moved off the input onto the label wrapper.
    // Look at the input's nearest <label> for the cap.
    const weightReason = within(row).getByLabelText(/Weight rationale/i) as HTMLElement;
    const changeNotes = within(row).getByLabelText(/Change notes/i) as HTMLElement;
    const wrLabel = weightReason.closest('label') as HTMLLabelElement;
    const cnLabel = changeNotes.closest('label') as HTMLLabelElement;
    expect((wrLabel.style.maxWidth || '').toLowerCase()).toMatch(/60ch|640px|72ch/);
    expect((cnLabel.style.maxWidth || '').toLowerCase()).toMatch(/60ch|640px|72ch/);
  });

  it('AC-52.35 + AC-52.61: existing-row URL renders inline as ↗ Open link, NOT an editable input', async () => {
    installFetch({
      votes: [{ ...sampleVote, url: 'https://clerk.house.gov/Votes/2022065' }],
    });
    render(<BillVotesSection billId="117-HR-2471" billDirection="pro-ukraine" />);
    const weight = await screen.findByDisplayValue('0.9');
    const row = weight.closest('form, [data-row="vote"]') as HTMLElement;
    // No editable "Vote URL" input. The new editable row uses a "URL" label
    // wrapping a link, not an input field.
    expect(within(row).queryByRole('textbox', { name: /Vote URL/i })).toBeNull();
    // ↗ Open link is present and points to the row's URL.
    const link = within(row).getByRole('link', { name: /↗ Open/i });
    expect(link).toHaveAttribute('href', 'https://clerk.house.gov/Votes/2022065');
  });

  it('AC-52.27(d): valid URL still renders the ↗ Open link (regression for AC-52.25)', async () => {
    installFetch({
      votes: [{ ...sampleVote, url: 'https://clerk.house.gov/Votes/2022065' }],
    });
    render(<BillVotesSection billId="117-HR-2471" billDirection="pro-ukraine" />);
    const link = await screen.findByRole('link', { name: /↗ Open/i });
    expect(link).toHaveAttribute('href', 'https://clerk.house.gov/Votes/2022065');
  });
});

/* -------------------------------------------------------------------------- */
/*                  AC-52.26 — inline vote-context disclosure                 */
/* -------------------------------------------------------------------------- */

describe('BillVotesSection — inline vote context (AC-52.26)', () => {
  function withContext(votes: unknown[], context?: unknown, contextStatus = 200) {
    const calls: RouteCall[] = [];
    let contextFetchCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = (init?.method ?? 'GET');
      calls.push({ url, method, body: null });
      if (url.includes('/api/admin/votes') && method === 'GET') {
        return new Response(JSON.stringify({ items: votes }), { status: 200 });
      }
      if (url.includes('/api/admin/comments') && method === 'GET') {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (url.includes('/api/congress/v3/house-vote/') && method === 'GET') {
        contextFetchCount++;
        if (contextStatus !== 200) {
          return new Response(JSON.stringify({ error: 'upstream_500', detail: 'boom' }), { status: contextStatus });
        }
        return new Response(JSON.stringify(context), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    return { calls, get contextFetchCount() { return contextFetchCount; } };
  }

  const houseDetail = {
    houseRollCallVote: {
      voteQuestion: 'On Passage of the Bill',
      result: 'Passed',
      votePartyTotal: [
        { voteParty: 'R', party: { name: 'R', type: 'R' }, yeaTotal: 100, nayTotal: 50, presentTotal: 0, notVotingTotal: 5 },
        { voteParty: 'D', party: { name: 'D', type: 'D' }, yeaTotal: 200, nayTotal: 10, presentTotal: 1, notVotingTotal: 2 },
      ],
    },
  };

  // AC-52.62 — disclosure is now PRE-EXPANDED (no toggle); fetch on mount.
  it('AC-52.26(i) + AC-52.62: House row fetches once on mount and renders question/result/totals', async () => {
    const ctx = withContext([sampleVote], houseDetail);
    render(<BillVotesSection billId="117-HR-2471" billDirection="pro-ukraine" />);
    const weight = await screen.findByDisplayValue('0.9');
    const row = weight.closest('form, [data-row="vote"]') as HTMLElement;

    await waitFor(() => {
      expect(within(row).getByText(/On Passage of the Bill/)).toBeInTheDocument();
    });
    expect(within(row).getByText(/Passed/)).toBeInTheDocument();
    expect(within(row).getByText(/Y 300/)).toBeInTheDocument();
    expect(within(row).getByText(/N 60/)).toBeInTheDocument();
    expect(ctx.contextFetchCount).toBe(1);
  });

  // AC-52.26(ii) is obsolete — there's no collapse/expand toggle anymore.
  it.skip('AC-52.26(ii): collapsing + re-expanding does NOT re-fetch (superseded by AC-52.62)', () => {
    expect(true).toBe(true);
  });

  // AC-52.64 — Senate inline context now fetches the canonical XML and parses it.
  // The "fallback link" obsoleted; superseded test below asserts the Senate
  // fetch happens through the /api/senate proxy.
  it.skip('AC-52.26(iii): Senate row renders fallback link inline (superseded by AC-52.64)', () => {
    expect(true).toBe(true);
  });

  it('AC-52.26(iv) + AC-52.62: upstream 5xx renders error message inline', async () => {
    withContext([sampleVote], null, 500);
    render(<BillVotesSection billId="117-HR-2471" billDirection="pro-ukraine" />);
    const weight = await screen.findByDisplayValue('0.9');
    const row = weight.closest('form, [data-row="vote"]') as HTMLElement;
    await waitFor(() =>
      expect(within(row).getByText(/Could not load vote context/i)).toBeInTheDocument(),
    );
  });
});

describe('BillCommentsSection — inline editor (AC-52.23)', () => {
  it('AC-52.23(b)+(d) [updated by AC-52.68]: Save stays enabled; PATCH fires once change-notes is filled', async () => {
    const calls: RouteCall[] = [];
    installFetch({ comments: [sampleComment], onCall: (c) => calls.push(c) });
    render(<BillCommentsSection billId="117-HR-2471" />);

    // Section starts collapsed — open it first.
    fireEvent.click(await screen.findByRole('button', { name: /Comments \(/i }));

    const body = await screen.findByDisplayValue('Bipartisan support note');
    const row = body.closest('form, [data-row="comment"]') as HTMLElement;
    expect(row).toBeTruthy();
    const saveBtn = within(row).getByRole('button', { name: /^Save$/i });

    fireEvent.change(body, { target: { value: 'Bipartisan support note (revised)' } });
    // AC-52.68 — Save is enabled; clicking now would flash but not PATCH.
    expect(saveBtn).toBeEnabled();

    const reasonInput = within(row).getByPlaceholderText(/change.notes|reason/i);
    fireEvent.change(reasonInput, { target: { value: 'fixed typo' } });
    expect(saveBtn).toBeEnabled();

    fireEvent.click(saveBtn);

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/comments/c1'));
      expect(patch).toBeDefined();
      const reqBody = patch!.body as Record<string, unknown>;
      expect(reqBody['body_markdown']).toBe('Bipartisan support note (revised)');
      expect(reqBody['_reason']).toBe('fixed typo');
    });
  });

  it('AC-52.23(c): Add row POSTs to /api/admin/comments with form values', async () => {
    const calls: RouteCall[] = [];
    installFetch({ comments: [], onCall: (c) => calls.push(c) });
    render(<BillCommentsSection billId="117-HR-2471" />);

    fireEvent.click(await screen.findByRole('button', { name: /Comments \(/i }));

    const addBtn = await screen.findByRole('button', { name: /^Add$/i });
    const addRow = addBtn.closest('form, [data-row="comment-new"]') as HTMLElement;
    // Placeholder updated to focus on bill-level annotation (no roll-call ref).
    const body = within(addRow).getByLabelText(/Comment body/i);
    fireEvent.change(body, { target: { value: 'House passage note' } });
    fireEvent.click(addBtn);

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/admin/comments'));
      expect(post).toBeDefined();
      const reqBody = post!.body as Record<string, unknown>;
      expect(reqBody['bill_id']).toBe('117-HR-2471');
      expect(reqBody['body_markdown']).toBe('House passage note');
    });
  });
});
