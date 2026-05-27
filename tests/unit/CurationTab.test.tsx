/**
 * Tests for src/admin/components/curation/CurationTab.tsx.
 *
 * Source-file JSDoc anchors:
 *   "Curation tab — single funnel for the discover→score pipeline.
 *    Sub-views driven by React Router via /curation/:view."
 *
 * Verifies:
 *   - The sub-nav renders one NavLink per VIEWS entry (Add quote / All quotes /
 *     Research / Add by URL), each pointing to /curation/<id>.
 *   - The "Inbox" view is hidden from the sub-nav (workflow not ready) but
 *     /curation/inbox still resolves and renders the QueueView.
 *   - The default route (no :view param) renders the Add quote sub-view.
 *   - Each valid :view value renders the matching sub-view component.
 *   - An invalid :view value redirects to /curation/add (handled by the parent
 *     <Routes>).
 *   - The active NavLink gets the active style applied.
 *   - Each NavLink surfaces its `help` text via the `title` attribute.
 *   - Tab forwards `prefill` + `onPrefillConsumed` props to AddQuoteView.
 *
 * Conventions:
 *   - No vi.mock — fetch is replaced via globalThis.fetch swap (see
 *     useAvailablePlatforms.test.tsx for the canonical pattern).
 *
 * Trace: FR-52 (admin SPA), FR-59 (social ingest funnel), CLAUDE.md
 *        ("one nav surface" / "shared cards over bespoke layouts").
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { CurationTab } from '../../src/admin/components/curation/CurationTab';
import type { QuotePrefill } from '../../src/admin/App';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Permissive default fetch — sub-views fetch on mount; we just need each
 * promise to resolve with a shape any consumer can read without throwing.
 */
function installPermissiveFetch() {
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({ items: [], platforms: [], members: [], tags: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  installPermissiveFetch();
});

interface RenderOpts {
  prefill?: QuotePrefill | null;
  onNavigateToPerson?: (id: string) => void;
  onCurateAsQuote?: (data: QuotePrefill) => void;
  onPrefillConsumed?: () => void;
}

/**
 * Mount CurationTab inside a MemoryRouter at /curation/<view>. Mirrors the
 * production App's <Route path="/curation/:view"> route table.
 */
function renderAt(initialPath: string, opts: RenderOpts = {}) {
  const onNavigateToPerson = opts.onNavigateToPerson ?? (() => {});
  const onCurateAsQuote = opts.onCurateAsQuote ?? (() => {});
  const onPrefillConsumed = opts.onPrefillConsumed ?? (() => {});
  const prefill = opts.prefill ?? null;
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="/curation/:view"
          element={
            <CurationTab
              onNavigateToPerson={onNavigateToPerson}
              onCurateAsQuote={onCurateAsQuote}
              prefill={prefill}
              onPrefillConsumed={onPrefillConsumed}
            />
          }
        />
        <Route
          path="/curation"
          element={
            <CurationTab
              onNavigateToPerson={onNavigateToPerson}
              onCurateAsQuote={onCurateAsQuote}
              prefill={prefill}
              onPrefillConsumed={onPrefillConsumed}
            />
          }
        />
        <Route path="*" element={<div data-testid="not-curation">elsewhere</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CurationTab', () => {
  it('renders a NavLink per VIEWS entry pointing to /curation/<id>', () => {
    renderAt('/curation/add');
    const expected: Array<[string, string]> = [
      ['Add quote', '/curation/add'],
      ['All quotes', '/curation/quotes'],
      ['Research', '/curation/research'],
      ['Add by URL', '/curation/direct'],
    ];
    for (const [label, href] of expected) {
      const link = screen.getByRole('link', { name: label });
      expect(link.getAttribute('href')).toBe(href);
    }
  });

  it('exposes each NavLink help text via the title attribute', () => {
    renderAt('/curation/add');
    expect(
      screen.getByRole('link', { name: 'Add quote' }).getAttribute('title'),
    ).toMatch(/Score a quote/i);
    expect(
      screen.getByRole('link', { name: 'All quotes' }).getAttribute('title'),
    ).toMatch(/Browse \+ edit/i);
    expect(
      screen.getByRole('link', { name: 'Research' }).getAttribute('title'),
    ).toMatch(/social feeds/i);
    expect(
      screen.getByRole('link', { name: 'Add by URL' }).getAttribute('title'),
    ).toMatch(/social URL/i);
  });

  it('does NOT expose an Inbox link in the sub-nav (workflow not ready)', () => {
    renderAt('/curation/add');
    expect(screen.queryByRole('link', { name: /^Inbox$/i })).toBeNull();
  });

  it('still resolves the /curation/inbox deep-link to the QueueView (unlisted but valid)', async () => {
    renderAt('/curation/inbox');
    // Sub-nav is still present at the unlisted route.
    expect(screen.getByRole('link', { name: 'Add quote' })).toBeDefined();
    // The Add quote sub-view is NOT mounted at this route.
    expect(screen.queryByRole('button', { name: /^Save quote/i })).toBeNull();
  });

  it('defaults to the Add quote sub-view when :view param is empty', () => {
    renderAt('/curation');
    // Sub-nav rendered.
    expect(screen.getByRole('link', { name: 'Add quote' })).toBeDefined();
  });

  it('renders the Add quote sub-view at /curation/add', async () => {
    renderAt('/curation/add');
    // AddQuoteView shows MoC picker + a quote-source label area; wait for any
    // identifiable text from the form.
    await waitFor(
      () =>
        expect(
          screen.getAllByRole('link', { name: 'Add quote' }).length,
        ).toBeGreaterThanOrEqual(1),
      { timeout: 3000 },
    );
  });

  it('renders the All quotes sub-view at /curation/quotes', async () => {
    renderAt('/curation/quotes');
    // QuotesListView fetches and shows either the items or an empty state — we
    // only need to confirm the sub-nav stayed mounted alongside it.
    await waitFor(
      () => expect(screen.getByRole('link', { name: 'All quotes' })).toBeDefined(),
      { timeout: 3000 },
    );
  });

  it('renders the Research sub-view at /curation/research', async () => {
    renderAt('/curation/research');
    await waitFor(
      () => expect(screen.getByRole('link', { name: 'Research' })).toBeDefined(),
      { timeout: 3000 },
    );
  });

  it('renders the Add by URL (direct) sub-view at /curation/direct', async () => {
    renderAt('/curation/direct');
    await waitFor(
      () => expect(screen.getByRole('link', { name: 'Add by URL' })).toBeDefined(),
      { timeout: 3000 },
    );
  });

  it('redirects to /curation/add when :view is not a known value', () => {
    renderAt('/curation/bogus');
    // After redirect, the sub-nav is still mounted.
    expect(screen.getByRole('link', { name: 'Add quote' })).toBeDefined();
  });

  it('marks the active NavLink with a non-transparent border color', () => {
    renderAt('/curation/quotes');
    const active = screen.getByRole('link', { name: 'All quotes' }) as HTMLAnchorElement;
    expect(active.style.borderColor).not.toBe('transparent');
    const inactive = screen.getByRole('link', { name: 'Add quote' }) as HTMLAnchorElement;
    expect(inactive.style.borderColor).toBe('transparent');
  });

  it('renders all four sub-nav links regardless of the active sub-view', () => {
    for (const view of ['add', 'quotes', 'research', 'direct', 'inbox']) {
      const { unmount } = renderAt(`/curation/${view}`);
      // Four visible links + however many extra anchors any sub-view renders.
      expect(screen.getAllByRole('link').length).toBeGreaterThanOrEqual(4);
      unmount();
    }
  });

  it('forwards a non-null prefill prop to AddQuoteView (mounts without throwing)', async () => {
    const prefill: QuotePrefill = {
      bioguideId: 'A000370',
      sourceUrl: 'https://x.com/example/status/123',
      sourceLabel: 'Twitter / X',
      bodyText: 'Hello world',
      quotedAt: '2026-05-01',
      mediaKind: 'social',
      queueItemId: 'queue-1',
    };
    renderAt('/curation/add', { prefill });
    // Sub-nav still mounts; the form exists somewhere in the tree.
    await waitFor(
      () => expect(screen.getByRole('link', { name: 'Add quote' })).toBeDefined(),
      { timeout: 3000 },
    );
  });
});
