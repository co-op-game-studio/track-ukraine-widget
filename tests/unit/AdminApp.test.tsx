/**
 * Admin App megamenu — v4 replaces the row-of-tabs nav with a single
 * megamenu trigger that drops down a 3-column panel (Workspace / Curation /
 * Admin). The standalone Votes + Comments tab carve-outs (AC-52.16, AC-52.65)
 * still apply: those entities are edited inline inside Bills, never as
 * top-level destinations.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { App } from '../../src/admin/App';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    return new Response(JSON.stringify({ email: 'alice@example.com' }), { status: 200 });
  });
});

function openMegamenu(): HTMLElement {
  // The trigger is the only aria-haspopup="menu" element in the chrome.
  const trigger = screen.getByRole('button', { expanded: false });
  fireEvent.click(trigger);
  return screen.getByRole('menu');
}

describe('Admin App megamenu (FR-52 AC-52.16 + AC-52.65, v4 nav)', () => {
  it('exposes the v4 sections via the megamenu (Bills + Curation + Activity + Admin)', () => {
    render(<App />);
    const menu = openMegamenu();
    // Every top-level destination is a real <a href> link in the megamenu.
    expect(within(menu).getByRole('link', { name: /^Bills$/ })).toBeInTheDocument();
    expect(within(menu).getByRole('link', { name: /^People$/ })).toBeInTheDocument();
    expect(within(menu).getByRole('link', { name: /^Activity$/ })).toBeInTheDocument();
    // Curation funnel — replaces standalone "Social Feed" + "Quotes" tabs.
    expect(within(menu).getByRole('link', { name: /^Inbox$/ })).toBeInTheDocument();
    expect(within(menu).getByRole('link', { name: /^All quotes$/ })).toBeInTheDocument();
    // Admin column — replaces v3 Settings.
    expect(within(menu).getByRole('link', { name: /^Tags$/ })).toBeInTheDocument();
    expect(within(menu).getByRole('link', { name: /^Keywords$/ })).toBeInTheDocument();
  });

  it('does NOT expose a standalone Votes destination (AC-52.16)', () => {
    render(<App />);
    const menu = openMegamenu();
    expect(within(menu).queryByRole('link', { name: /^Votes$/ })).toBeNull();
  });

  it('does NOT expose a standalone Comments destination (AC-52.65)', () => {
    render(<App />);
    const menu = openMegamenu();
    expect(within(menu).queryByRole('link', { name: /^Comments$/ })).toBeNull();
  });
});
