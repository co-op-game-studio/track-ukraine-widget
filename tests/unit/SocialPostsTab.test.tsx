/**
 * SocialPostsTab — schema integrity + create/update flow.
 *
 * Traces:
 *   AC-52.38 — comments/social_posts/quotes carry weight + direction
 *   AC-52.41 — UI renders weight + direction controls
 *   AC-52.42 — POST/PATCH bodies use weight + direction (not score_adjustment)
 *   FR-52    — researcher SPA edits curated content via /api/admin/social-posts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SocialPostsTab } from '../../src/admin/components/SocialPostsTab';
import type { SocialPostRow } from '../../src/admin/types';

interface PostCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

function installFetch(opts: { items?: SocialPostRow[]; onCall?: (c: PostCall) => void } = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = init?.method ?? 'GET';
    const bodyText = (init?.body as string | undefined) ?? null;
    const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
    opts.onCall?.({ url, method, body });
    if (url.endsWith('/api/admin/social-posts') && method === 'GET') {
      return new Response(JSON.stringify({ items: opts.items ?? [] }), { status: 200 });
    }
    if (url.endsWith('/api/admin/social-posts') && method === 'POST') {
      return new Response(
        JSON.stringify({ row: { id: 'p_new', ...body, created_at: 'x', updated_at: 'x' } }),
        { status: 201 },
      );
    }
    if (url.match(/\/api\/admin\/social-posts\/[^?]+/) && method === 'PATCH') {
      return new Response(JSON.stringify({ row: { id: 'p1', ...body } }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

const SAMPLE: SocialPostRow = {
  id: '01HQXSAMPLEPOST000000000',
  bioguide_id: 'D000563',
  platform: 'x',
  url: 'https://x.com/SenatorDurbin/status/123',
  posted_at: '2026-04-28T12:00:00Z',
  body_text: 'Stand with Ukraine.',
  weight: 0.5,
  direction: 1,
  comment: null,
  author_email: 'alice@example.com',
  created_at: '2026-05-02T00:00:00Z',
  updated_at: '2026-05-02T00:00:00Z',
};

beforeEach(() => {
  vi.restoreAllMocks();
  installFetch();
});

describe('SocialPostsTab — schema (AC-52.38 + AC-52.41)', () => {
  it('renders Weight + Direction labels (NOT score_adjustment slider)', async () => {
    installFetch({ items: [SAMPLE] });
    render(<SocialPostsTab />);
    fireEvent.click(await screen.findByText(/D000563.*Stand with Ukraine/));
    expect(screen.getByText(/^Weight$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Direction$/i)).toBeInTheDocument();
    // Old slider label should NOT be present.
    expect(screen.queryByText(/Score adjustment/i)).toBeNull();
  });

  it('Direction select carries integer wire values (-1, 0, +1)', async () => {
    installFetch({ items: [SAMPLE] });
    render(<SocialPostsTab />);
    fireEvent.click(await screen.findByText(/D000563/));
    const selects = [...document.querySelectorAll('select')];
    const directionSelect = selects.find((s) => {
      const labelText = s.parentElement?.querySelector('span')?.textContent ?? '';
      return /Direction/i.test(labelText);
    }) as HTMLSelectElement;
    expect(directionSelect).toBeDefined();
    const optionValues = [...directionSelect.options].map((o) => o.value);
    expect(optionValues).toContain('1');
    expect(optionValues).toContain('0');
    expect(optionValues).toContain('-1');
  });

  it('Direction options have human pro/anti labels', async () => {
    installFetch({ items: [SAMPLE] });
    render(<SocialPostsTab />);
    fireEvent.click(await screen.findByText(/D000563/));
    const selects = [...document.querySelectorAll('select')];
    const directionSelect = selects.find((s) => {
      const labelText = s.parentElement?.querySelector('span')?.textContent ?? '';
      return /Direction/i.test(labelText);
    }) as HTMLSelectElement;
    const labels = [...directionSelect.options].map((o) => o.textContent ?? '');
    expect(labels.some((l) => /pro-Ukraine/i.test(l))).toBe(true);
    expect(labels.some((l) => /anti-Ukraine/i.test(l))).toBe(true);
    expect(labels.some((l) => /unstated/i.test(l))).toBe(true);
  });

  it('Weight input is numeric with 0..5 range and 0.05 step', async () => {
    installFetch({ items: [SAMPLE] });
    render(<SocialPostsTab />);
    fireEvent.click(await screen.findByText(/D000563/));
    const weightInput = [...document.querySelectorAll('input[type="number"]')].find((el) => {
      const labelText = el.parentElement?.querySelector('span')?.textContent ?? '';
      return /^Weight/i.test(labelText);
    }) as HTMLInputElement;
    expect(weightInput).toBeDefined();
    // jsdom mirrors HTMLInputElement min/max/step via attributes; check via getAttribute.
    expect(weightInput.getAttribute('min')).toBe('0');
    expect(weightInput.getAttribute('max')).toBe('5');
    expect(weightInput.getAttribute('step')).toBe('0.05');
  });
});

describe('SocialPostsTab — wire shape (AC-52.42)', () => {
  it('PATCH body carries weight + direction (no score_adjustment)', async () => {
    const calls: PostCall[] = [];
    installFetch({ items: [SAMPLE], onCall: (c) => calls.push(c) });
    render(<SocialPostsTab />);
    fireEvent.click(await screen.findByText(/D000563/));

    // Edit the weight field.
    const weightInput = [...document.querySelectorAll('input[type="number"]')].find((el) => {
      const labelText = el.parentElement?.querySelector('span')?.textContent ?? '';
      return /^Weight/i.test(labelText);
    }) as HTMLInputElement;
    fireEvent.change(weightInput, { target: { value: '2.5' } });

    // Type into the change-notes textarea.
    const textareas = [...document.querySelectorAll('textarea')];
    const changeNotes = textareas.find((t) =>
      /change notes/i.test(t.parentElement?.textContent ?? ''),
    ) as HTMLTextAreaElement;
    fireEvent.change(changeNotes, { target: { value: 'tweaked weight per review' } });

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/social-posts/'));
      expect(patch).toBeDefined();
      const body = patch!.body as Record<string, unknown>;
      expect(body['weight']).toBe(2.5);
      expect(body['direction']).toBeDefined();
      // Crucial: the legacy `score_adjustment` field SHALL NOT be in the wire.
      expect(body).not.toHaveProperty('score_adjustment');
    });
  });

  it('POST body for new row carries weight + direction defaults', async () => {
    const calls: PostCall[] = [];
    installFetch({ onCall: (c) => calls.push(c) });
    render(<SocialPostsTab />);

    // The +New affordance lives in the list-aside header.
    fireEvent.click(await screen.findByRole('button', { name: /\+ New/i }));

    // Fill required fields enough to submit. Walk up to the wrapping <label>
    // since the URL widget nests its <input> inside an extra <div>.
    function findInputByLabel(re: RegExp): HTMLInputElement {
      const inputs = [...document.querySelectorAll('input[type="text"], input[type="url"]')] as HTMLInputElement[];
      return inputs.find((el) => {
        const label = el.closest('label');
        const labelText = label?.querySelector('span')?.textContent ?? '';
        return re.test(labelText);
      })!;
    }
    fireEvent.change(findInputByLabel(/Bioguide/i), { target: { value: 'D000563' } });
    fireEvent.change(findInputByLabel(/Post URL/i), { target: { value: 'https://x.com/x/1' } });

    const textareas = [...document.querySelectorAll('textarea')];
    const bodyTa = textareas.find((t) =>
      /^Post text/i.test(t.parentElement?.querySelector('span')?.textContent ?? ''),
    ) as HTMLTextAreaElement;
    fireEvent.change(bodyTa, { target: { value: 'Stand with Ukraine.' } });

    fireEvent.click(screen.getByRole('button', { name: /^Create$/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/admin/social-posts'));
      expect(post).toBeDefined();
      const body = post!.body as Record<string, unknown>;
      expect(body['bioguide_id']).toBe('D000563');
      expect(body['weight']).toBeDefined();
      expect(body['direction']).toBeDefined();
      expect(body).not.toHaveProperty('score_adjustment');
    });
  });

  it('list label uses the new bioguide · platform · body_text shape', async () => {
    installFetch({ items: [SAMPLE] });
    render(<SocialPostsTab />);
    expect(await screen.findByText(/D000563 · x · Stand with Ukraine/)).toBeInTheDocument();
  });
});
