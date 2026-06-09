/**
 * Admin App megamenu — v4 replaces the row-of-tabs nav with a single
 * megamenu trigger that drops down a multi-column panel (Workspace / Curation /
 * Admin / Help). The standalone Votes + Comments tab carve-outs (AC-52.16,
 * AC-52.65) still apply: those entities are edited inline inside Bills, never
 * as top-level destinations.
 *
 * FR-61 (v4.3.0): the Admin column is gated on the `isAdmin` hint from
 * /api/admin/config. These tests mock config to control that hint.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../../src/admin/App';

function renderApp() {
  return render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);
}

/**
 * Mock fetch: whoami → email; config → { isAdmin }; everything else → a benign
 * superset shape ({ email, items:[], members:[] }) so list views (PeopleTab,
 * etc.) that the `/` → `/people` redirect mounts don't crash on undefined data.
 */
function mockFetch(isAdmin: boolean) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/admin/config')) {
      return new Response(JSON.stringify({ isAdmin, pollConcurrency: 4, socialPollCron: '0 6 * * *', socialPollStalenessMin: 55 }), { status: 200 });
    }
    return new Response(JSON.stringify({ email: 'alice@example.com', items: [], members: [] }), { status: 200 });
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockFetch(true);
});

function openMegamenu(): HTMLElement {
  // The trigger is the only aria-haspopup="menu" element in the chrome.
  const trigger = screen.getByRole('button', { expanded: false });
  fireEvent.click(trigger);
  return screen.getByRole('menu');
}

describe('Admin App megamenu (FR-52 AC-52.16 + AC-52.65, v4 nav)', () => {
  it('exposes the v4 sections via the megamenu (Bills + Curation + Activity + Admin)', async () => {
    renderApp();
    // Wait for the isAdmin config fetch to resolve so the Admin column renders.
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/admin/config'), expect.anything()));
    const menu = openMegamenu();
    // Every top-level destination is a real <a href> link in the megamenu.
    expect(within(menu).getByRole('link', { name: /^Bills$/ })).toBeInTheDocument();
    expect(within(menu).getByRole('link', { name: /^People$/ })).toBeInTheDocument();
    expect(within(menu).getByRole('link', { name: /^Activity$/ })).toBeInTheDocument();
    // Curation funnel — replaces standalone "Social Feed" + "Quotes" tabs.
    // Inbox is temporarily unlinked from the menu (workflow not ready) but
    // the route still resolves; assert against Add quote + All quotes instead.
    expect(within(menu).getByRole('link', { name: /^Add quote$/ })).toBeInTheDocument();
    expect(within(menu).getByRole('link', { name: /^All quotes$/ })).toBeInTheDocument();
    expect(within(menu).queryByRole('link', { name: /^Inbox$/ })).toBeNull();
    // Admin column — replaces v3 Settings. Visible because isAdmin=true.
    await waitFor(() => expect(within(menu).getByRole('link', { name: /^Tags$/ })).toBeInTheDocument());
    expect(within(menu).getByRole('link', { name: /^Keywords$/ })).toBeInTheDocument();
  });

  it('FR-61: hides the Admin column when isAdmin is false', async () => {
    vi.restoreAllMocks();
    mockFetch(false);
    renderApp();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/admin/config'), expect.anything()));
    const menu = openMegamenu();
    // Researcher sections still present…
    expect(within(menu).getByRole('link', { name: /^People$/ })).toBeInTheDocument();
    // …but the Admin/config surfaces are gone.
    expect(within(menu).queryByRole('link', { name: /^Tags$/ })).toBeNull();
    expect(within(menu).queryByRole('link', { name: /^Keywords$/ })).toBeNull();
    expect(within(menu).queryByRole('link', { name: /^Cache$/ })).toBeNull();
  });

  it('does NOT expose a standalone Votes destination (AC-52.16)', () => {
    renderApp();
    const menu = openMegamenu();
    expect(within(menu).queryByRole('link', { name: /^Votes$/ })).toBeNull();
  });

  it('does NOT expose a standalone Comments destination (AC-52.65)', () => {
    renderApp();
    const menu = openMegamenu();
    expect(within(menu).queryByRole('link', { name: /^Comments$/ })).toBeNull();
  });
});
