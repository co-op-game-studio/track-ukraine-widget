/**
 * Tests for src/admin/components/AuditTab.tsx.
 *
 * Source-file JSDoc anchors:
 *   "Audit / Recent Activity tab. FR-52 AC-52.5 + FR-58.
 *    Read-only feed of the latest audit_log rows from /api/admin/audit.
 *    Shows actor, action, target, reason, before/after diff, trace ID."
 *
 * Verifies:
 *   - Loading state renders the "Loading audit log…" placeholder before the fetch resolves.
 *   - Empty state renders "No audit entries yet." when items=[].
 *   - Error state renders "Audit error: <detail>" and prefers `detail` over `error`.
 *   - Error state falls back to `error` when `detail` is absent.
 *   - Success state renders one item per row with actor, action, target (row_title fallback to row_id),
 *     reason, trace ID, and a `<details>` block when before/after present.
 *   - The `<details>` block is omitted when both before and after are null.
 *   - relTime formatting buckets (just now / Nm ago / Nh ago / Nd ago / iso slice) all render.
 *   - relTime returns the raw iso string when given an unparseable date.
 *
 * Trace: FR-52 AC-52.5 + FR-58 (admin audit log view).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuditTab } from '../../src/admin/components/AuditTab';
import type { AuditFullItem } from '../../src/admin/types';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function makeItem(over: Partial<AuditFullItem> = {}): AuditFullItem {
  return {
    id: 'audit-1',
    actor_email: 'curator@example.com',
    action: 'update',
    target_table: 'bills',
    row_id: '01HQXBILL01',
    row_title: 'Test bill',
    before: null,
    after: null,
    reason: null,
    trace_id: 'trace-abcdef',
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...over,
  };
}

function fetchOk(items: (AuditFullItem & { reason?: string | null })[]): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify({ items }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof globalThis.fetch;
}

describe('AuditTab', () => {
  beforeEach(() => {
    globalThis.fetch = fetchOk([]);
  });

  it('renders "Loading audit log…" while the fetch is pending', () => {
    let resolveFetch!: (r: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    globalThis.fetch = async () => pending;
    render(<AuditTab />);
    expect(screen.getByText(/Loading audit log…/i)).toBeDefined();
    // Resolve to release the pending promise.
    resolveFetch(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it('renders the empty-state placeholder when items=[]', async () => {
    globalThis.fetch = fetchOk([]);
    render(<AuditTab />);
    await waitFor(() => expect(screen.getByText(/No audit entries yet\./i)).toBeDefined());
  });

  it('treats a missing `items` field on the API response as empty', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof globalThis.fetch;
    render(<AuditTab />);
    await waitFor(() => expect(screen.getByText(/No audit entries yet\./i)).toBeDefined());
  });

  it('surfaces the `detail` field from a FetchError', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'forbidden', detail: 'No CF Access JWT' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof globalThis.fetch;
    render(<AuditTab />);
    await waitFor(() => expect(screen.getByText(/Audit error:/i)).toBeDefined());
    expect(screen.getByText(/No CF Access JWT/i)).toBeDefined();
  });

  it('falls back to the `error` field when `detail` is absent', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'gateway_down' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof globalThis.fetch;
    render(<AuditTab />);
    await waitFor(() => expect(screen.getByText(/gateway_down/i)).toBeDefined());
  });

  it('renders one item per row with actor, action, target.row_title, reason, trace, and a diff toggle', async () => {
    const items = [
      makeItem({
        id: 'a1',
        actor_email: 'alice@example.com',
        action: 'update',
        target_table: 'bills',
        row_title: 'HR-1601 Ukraine Aid',
        reason: 'fix typo',
        before: { title: 'old' },
        after: { title: 'new' },
        trace_id: 'trace-aaa',
      }),
    ];
    globalThis.fetch = fetchOk(items);
    render(<AuditTab />);
    await waitFor(() => expect(screen.getByText('alice@example.com')).toBeDefined());
    expect(screen.getByText('update')).toBeDefined();
    // Target row uses the row_title (preferred over row_id).
    expect(screen.getByText(/HR-1601 Ukraine Aid/)).toBeDefined();
    // Reason renders.
    expect(screen.getByText(/fix typo/)).toBeDefined();
    // Trace ID renders inside a <code>.
    expect(screen.getByText('trace-aaa')).toBeDefined();
    // The before/after summary toggle is present (collapsed <details>).
    expect(screen.getByText(/before \/ after/i)).toBeDefined();
    // The pre block content is in the DOM (always rendered, just visually collapsed).
    const pre = document.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toMatch(/"before"/);
    expect(pre!.textContent).toMatch(/"after"/);
  });

  it('uses row_id as the target suffix when row_title is null', async () => {
    const items = [makeItem({ id: 'a2', row_title: null, row_id: '01HQXROW00000000000000ABCD' })];
    globalThis.fetch = fetchOk(items);
    render(<AuditTab />);
    await waitFor(() => expect(screen.getByText(/01HQXROW00000000000000ABCD/)).toBeDefined());
  });

  it('omits the <details> diff block when before AND after are both null', async () => {
    const items = [makeItem({ id: 'a3', before: null, after: null, reason: null })];
    globalThis.fetch = fetchOk(items);
    render(<AuditTab />);
    await waitFor(() => expect(screen.getByText('curator@example.com')).toBeDefined());
    expect(document.querySelector('details')).toBeNull();
  });

  it('renders the <details> block when only `after` is non-null (insert case)', async () => {
    const items = [makeItem({ id: 'a4', before: null, after: { title: 'new bill' } })];
    globalThis.fetch = fetchOk(items);
    render(<AuditTab />);
    await waitFor(() => expect(screen.getByText(/before \/ after/i)).toBeDefined());
    expect(document.querySelector('details')).not.toBeNull();
  });

  it('omits the reason block when reason is null', async () => {
    const items = [makeItem({ id: 'a5', reason: null })];
    globalThis.fetch = fetchOk(items);
    render(<AuditTab />);
    await waitFor(() => expect(screen.getByText('curator@example.com')).toBeDefined());
    expect(screen.queryByText(/^Reason:/)).toBeNull();
  });

  it('relTime: renders "just now" for a < 1 minute timestamp', async () => {
    const items = [
      makeItem({
        id: 'rt-now',
        created_at: new Date(Date.now() - 10_000).toISOString(),
      }),
    ];
    globalThis.fetch = fetchOk(items);
    render(<AuditTab />);
    await waitFor(() => expect(screen.getByText(/just now/i)).toBeDefined());
  });

  it('relTime: renders "Nm ago" for a < 1 hour timestamp', async () => {
    const items = [
      makeItem({
        id: 'rt-min',
        created_at: new Date(Date.now() - 7 * 60_000).toISOString(),
      }),
    ];
    globalThis.fetch = fetchOk(items);
    render(<AuditTab />);
    await waitFor(() => expect(screen.getByText(/^7m ago$/)).toBeDefined());
  });

  it('relTime: renders "Nh ago" for a < 1 day timestamp', async () => {
    const items = [
      makeItem({
        id: 'rt-hr',
        created_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
      }),
    ];
    globalThis.fetch = fetchOk(items);
    render(<AuditTab />);
    await waitFor(() => expect(screen.getByText(/^3h ago$/)).toBeDefined());
  });

  it('relTime: renders "Nd ago" for a < 30 day timestamp', async () => {
    const items = [
      makeItem({
        id: 'rt-day',
        created_at: new Date(Date.now() - 5 * 24 * 60 * 60_000).toISOString(),
      }),
    ];
    globalThis.fetch = fetchOk(items);
    render(<AuditTab />);
    await waitFor(() => expect(screen.getByText(/^5d ago$/)).toBeDefined());
  });

  it('relTime: renders the YYYY-MM-DD slice for >= 30 day timestamps', async () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60_000).toISOString();
    const items = [makeItem({ id: 'rt-old', created_at: old })];
    globalThis.fetch = fetchOk(items);
    render(<AuditTab />);
    await waitFor(() => expect(screen.getByText(old.slice(0, 10))).toBeDefined());
  });

  it('relTime: returns the raw iso string when the date is unparseable', async () => {
    const items = [makeItem({ id: 'rt-bad', created_at: 'not-a-date' })];
    globalThis.fetch = fetchOk(items);
    render(<AuditTab />);
    await waitFor(() => expect(screen.getByText('not-a-date')).toBeDefined());
  });

  it('renders multiple items, one <li> per row, keyed by id', async () => {
    const items = [
      makeItem({ id: 'm1', actor_email: 'first@example.com' }),
      makeItem({ id: 'm2', actor_email: 'second@example.com' }),
      makeItem({ id: 'm3', actor_email: 'third@example.com' }),
    ];
    globalThis.fetch = fetchOk(items);
    render(<AuditTab />);
    await waitFor(() => expect(screen.getByText('first@example.com')).toBeDefined());
    expect(screen.getByText('second@example.com')).toBeDefined();
    expect(screen.getByText('third@example.com')).toBeDefined();
    expect(document.querySelectorAll('li').length).toBe(3);
  });
});
