/**
 * Tests for src/admin/components/settings/PollStatusView.tsx.
 *
 * Settings ▸ Poll status — system-wide health for the social poll loop.
 * Verifies:
 *   - Loading state on first render.
 *   - Default filter ("error") is sent in the URL.
 *   - Empty list under "error" filter shows the celebratory empty-state.
 *   - Successful render of HandleStatusRow payload (handle, platform,
 *     bioguide_id link, error text, trace ID).
 *   - 5xx fetch failure degrades to empty list (no throw).
 *   - Refresh button re-issues a GET.
 *   - Filter select rewires the request to ?status=ok / no-param.
 *   - Trace ID copy button writes to clipboard and flips the icon to "copied".
 *   - "never tried" badge when last_poll_status is null.
 *
 * Trace: FR-58 / settings ▸ poll status (per-handle health card).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { PollStatusView } from '../../src/admin/components/settings/PollStatusView';
import type { HandleStatusRow } from '../../src/admin/types';

const realFetch = globalThis.fetch;
const realClipboard = (globalThis.navigator as Navigator).clipboard;

interface Captured {
  urls: string[];
}

function makeRow(over: Partial<HandleStatusRow> = {}): HandleStatusRow {
  return {
    handle_id: 'h1',
    platform: 'bluesky',
    handle: 'sendurbin.bsky.social',
    display_name: 'Senator Durbin',
    bioguide_id: 'D000563',
    last_polled_at: '2026-05-05T12:00:00Z',
    last_poll_attempted_at: '2026-05-05T12:30:00Z',
    last_poll_status: 'error',
    last_poll_error: 'rate limited by upstream',
    last_poll_trace_id: 'trace-abc-123',
    ...over,
  };
}

function installFetch(
  handler: (url: string) => Response | Promise<Response>,
  captured?: Captured,
) {
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    captured?.urls.push(url);
    return handler(url);
  };
}

beforeEach(() => {
  // Install a writable clipboard mock for jsdom (which has none by default).
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (_t: string) => {} },
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: realClipboard,
  });
});

describe('PollStatusView', () => {
  it('shows loading state then "no failing handles" empty-state under default error filter', async () => {
    const captured: Captured = { urls: [] };
    installFetch(
      () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
      captured,
    );
    render(<PollStatusView />);
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/No failing handles/i)).toBeInTheDocument());
    // Default filter is 'error', so URL must include ?status=error.
    expect(captured.urls.some((u) => u.includes('/api/admin/ingest/handle-status?status=error'))).toBe(true);
  });

  it('renders an error row with handle, platform, bioguide link, error text, and trace id', async () => {
    installFetch(() =>
      new Response(JSON.stringify({ items: [makeRow()] }), { status: 200 }),
    );
    render(<PollStatusView />);
    await waitFor(() => expect(screen.getByText('@sendurbin.bsky.social')).toBeInTheDocument());
    expect(screen.getByText('bluesky')).toBeInTheDocument();
    expect(screen.getByText(/D000563/)).toBeInTheDocument();
    expect(screen.getByText(/rate limited by upstream/)).toBeInTheDocument();
    // Trace id is rendered as a copy button.
    expect(screen.getByText('trace-abc-123')).toBeInTheDocument();
    // Status badge shows "error".
    expect(screen.getByText(/^error$/i)).toBeInTheDocument();
  });

  it('5xx fetch degrades to empty list without throwing', async () => {
    installFetch(() => new Response('boom', { status: 500 }));
    render(<PollStatusView />);
    // After failure, error filter still in effect → empty-state appears.
    await waitFor(() => expect(screen.getByText(/No failing handles/i)).toBeInTheDocument());
  });

  it('refresh button re-issues the GET', async () => {
    const captured: Captured = { urls: [] };
    installFetch(
      () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
      captured,
    );
    render(<PollStatusView />);
    await waitFor(() => expect(screen.getByText(/No failing handles/i)).toBeInTheDocument());
    const before = captured.urls.length;
    fireEvent.click(screen.getByRole('button', { name: /Refresh/i }));
    await waitFor(() => expect(captured.urls.length).toBe(before + 1));
  });

  it('filter select switches request to ?status=ok and to no-param for "all"', async () => {
    const captured: Captured = { urls: [] };
    installFetch(
      () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
      captured,
    );
    render(<PollStatusView />);
    await waitFor(() => expect(captured.urls.length).toBeGreaterThan(0));

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'ok' } });
    await waitFor(() => expect(captured.urls.some((u) => u.includes('?status=ok'))).toBe(true));

    fireEvent.change(select, { target: { value: 'all' } });
    await waitFor(() =>
      expect(
        captured.urls.some((u) => u.endsWith('/api/admin/ingest/handle-status')),
      ).toBe(true),
    );
  });

  it('renders "ok" status row without an error box and no trace button', async () => {
    installFetch(() =>
      new Response(
        JSON.stringify({
          items: [
            makeRow({
              last_poll_status: 'ok',
              last_poll_error: null,
              last_poll_trace_id: null,
            }),
          ],
        }),
        { status: 200 },
      ),
    );
    render(<PollStatusView />);
    await waitFor(() => expect(screen.getByText('@sendurbin.bsky.social')).toBeInTheDocument());
    // No error text or trace id rendered.
    expect(screen.queryByText(/rate limited/i)).toBeNull();
    expect(screen.queryByText(/trace-abc-123/)).toBeNull();
  });

  it('renders "never tried" badge when last_poll_status is null', async () => {
    installFetch(() =>
      new Response(
        JSON.stringify({
          items: [
            makeRow({
              last_poll_status: null,
              last_poll_error: null,
              last_poll_trace_id: null,
              last_polled_at: null,
            }),
          ],
        }),
        { status: 200 },
      ),
    );
    render(<PollStatusView />);
    await waitFor(() => expect(screen.getByText(/never tried/i)).toBeInTheDocument());
    // "last success: never" branch in relTime.
    expect(screen.getByText(/last success: never/i)).toBeInTheDocument();
  });

  it('omits bioguide link when bioguide_id is null', async () => {
    installFetch(() =>
      new Response(
        JSON.stringify({
          items: [
            makeRow({
              bioguide_id: null,
              last_poll_status: 'ok',
              last_poll_error: null,
              last_poll_trace_id: null,
            }),
          ],
        }),
        { status: 200 },
      ),
    );
    render(<PollStatusView />);
    await waitFor(() => expect(screen.getByText('@sendurbin.bsky.social')).toBeInTheDocument());
    // No anchor with the bioguide link present.
    expect(document.querySelector('a[href*="#/people/"]')).toBeNull();
  });

  it('trace id button copies to clipboard and flips icon to "copied"', async () => {
    let copied: string | null = null;
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (t: string) => {
          copied = t;
        },
      },
    });
    installFetch(() =>
      new Response(JSON.stringify({ items: [makeRow()] }), { status: 200 }),
    );
    render(<PollStatusView />);
    await waitFor(() => expect(screen.getByText('trace-abc-123')).toBeInTheDocument());
    const traceBtn = screen.getByTitle(/Click to copy this trace ID/i);
    await act(async () => {
      fireEvent.click(traceBtn);
    });
    await waitFor(() => expect(copied).toBe('trace-abc-123'));
    await waitFor(() => expect(screen.getByText(/copied/i)).toBeInTheDocument());
  });

  it('trace id button swallows clipboard rejection (no throw)', async () => {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('clipboard denied');
        },
      },
    });
    installFetch(() =>
      new Response(JSON.stringify({ items: [makeRow()] }), { status: 200 }),
    );
    render(<PollStatusView />);
    await waitFor(() => expect(screen.getByText('trace-abc-123')).toBeInTheDocument());
    const traceBtn = screen.getByTitle(/Click to copy this trace ID/i);
    await act(async () => {
      fireEvent.click(traceBtn);
    });
    // Should not have flipped to "copied" — but should not have crashed either.
    expect(screen.getByText('trace-abc-123')).toBeInTheDocument();
  });

  it('renders relative-time strings across the seconds/minutes/hours/days branches', async () => {
    const now = Date.now();
    installFetch(() =>
      new Response(
        JSON.stringify({
          items: [
            makeRow({ handle_id: 'a', handle: 'a-secs', last_poll_attempted_at: new Date(now - 5_000).toISOString() }),
            makeRow({ handle_id: 'b', handle: 'b-mins', last_poll_attempted_at: new Date(now - 5 * 60_000).toISOString() }),
            makeRow({ handle_id: 'c', handle: 'c-hours', last_poll_attempted_at: new Date(now - 5 * 60 * 60_000).toISOString() }),
            makeRow({ handle_id: 'd', handle: 'd-days', last_poll_attempted_at: new Date(now - 5 * 24 * 60 * 60_000).toISOString() }),
          ],
        }),
        { status: 200 },
      ),
    );
    render(<PollStatusView />);
    await waitFor(() => expect(screen.getByText('@a-secs')).toBeInTheDocument());
    expect(screen.getByText(/last attempted: \ds ago/i)).toBeInTheDocument();
    expect(screen.getByText(/last attempted: 5m ago/i)).toBeInTheDocument();
    expect(screen.getByText(/last attempted: 5h ago/i)).toBeInTheDocument();
    expect(screen.getByText(/last attempted: 5d ago/i)).toBeInTheDocument();
  });
});
