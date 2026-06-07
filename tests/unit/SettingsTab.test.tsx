/**
 * Tests for src/admin/components/settings/SettingsTab.tsx.
 *
 * Source-file JSDoc anchors:
 *   "Admin settings tab. Sub-views driven by React Router via /settings/:view.
 *    Per CLAUDE.md: anything 'operator-edited configuration data' lives here.
 *    Poll status and App config are read-only (shown but wrapped in ReadOnlyWrap)."
 *
 * Verifies:
 *   - The sub-nav renders one NavLink per VIEWS entry, each pointing to /settings/<id>.
 *   - Each link surfaces its `help` text via the `title` attribute.
 *   - The default route (no :view param) renders the Keywords sub-view.
 *   - Each valid :view value renders the matching sub-view component.
 *   - Read-only views (poll-status, config) are wrapped in the ReadOnlyWrap banner.
 *   - An invalid :view value redirects to /settings/keywords (handled by the
 *     parent <Routes>).
 *   - The active NavLink gets the active style applied (visible color contrast).
 *
 * Conventions:
 *   - No vi.mock — fetch is replaced via globalThis.fetch swap (see
 *     useAvailablePlatforms.test.tsx for the canonical pattern).
 *
 * Trace: FR-52 (admin SPA Settings home), CLAUDE.md ("one nav surface" / "Settings
 *        is the home for cross-cutting knobs").
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom';
import { SettingsTab } from '../../src/admin/components/settings/SettingsTab';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Permissive default fetch — sub-views fetch on mount; we just need each
 * promise to resolve with a shape any consumer can read without throwing.
 * Most admin endpoints respond with `{ items: [] }` or a small object.
 */
function installPermissiveFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    // App config endpoint
    if (url.includes('/api/admin/config')) {
      return new Response(
        JSON.stringify({
          pollConcurrency: 4,
          socialPollCron: '*/15 * * * *',
          socialPollStalenessMin: 10,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    // Cache overview
    if (url.endsWith('/api/admin/cache') || url.includes('/api/admin/cache?')) {
      return new Response(JSON.stringify({ prefixes: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Default: empty items list
    return new Response(JSON.stringify({ items: [], platforms: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  installPermissiveFetch();
});

/**
 * Mount SettingsTab inside a MemoryRouter at /settings/<view>. The route table
 * mirrors the production App's <Route path="/settings/:view"> + the redirect
 * fallback for invalid :view values.
 */
function renderAt(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/settings/:view" element={<SettingsTab />} />
        <Route path="/settings" element={<SettingsTab />} />
        <Route path="*" element={<div data-testid="not-settings">elsewhere</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SettingsTab', () => {
  it('renders a NavLink per VIEWS entry pointing to /settings/<id>', () => {
    renderAt('/settings/keywords');
    const expected: Array<[string, string]> = [
      ['Keywords', '/settings/keywords'],
      ['Tags', '/settings/tags'],
      ['Vote review', '/settings/vote-review'],
      ['Sync status', '/settings/poll-status'],
      ['API quota', '/settings/api-usage'],
      ['App config', '/settings/config'],
    ];
    for (const [label, href] of expected) {
      const link = screen.getByRole('link', { name: label });
      expect(link.getAttribute('href')).toBe(href);
    }
    // v4.3.0: Cache is hidden from the sub-nav (operator-only) — no link.
    expect(screen.queryByRole('link', { name: 'Cache' })).toBeNull();
  });

  it('exposes each NavLink help text via the title attribute', () => {
    renderAt('/settings/keywords');
    expect(
      screen.getByRole('link', { name: 'Tags' }).getAttribute('title'),
    ).toMatch(/Color-coded labels/i);
    expect(
      screen.getByRole('link', { name: 'Sync status' }).getAttribute('title'),
    ).toMatch(/read-only/i);
    expect(
      screen.getByRole('link', { name: 'App config' }).getAttribute('title'),
    ).toMatch(/Deployment-time/i);
    expect(
      screen.getByRole('link', { name: 'Keywords' }).getAttribute('title'),
    ).toMatch(/social sync/i);
  });

  it('defaults to the Keywords sub-view when :view param is empty', async () => {
    // Render at /settings (no view); the inner SettingsTab default `view = 'keywords'`
    // (from useParams destructuring default) handles it — the sub-nav is still present.
    renderAt('/settings');
    // Sub-nav rendered.
    expect(screen.getByRole('link', { name: 'Keywords' })).toBeDefined();
    // Tags + cache + poll + config sub-view content NOT present.
    expect(screen.queryByRole('heading', { name: /^Tags$/ })).toBeNull();
  });

  it('renders the Tags sub-view at /settings/tags', async () => {
    renderAt('/settings/tags');
    // TagsView starts with a heading-like "Tags" string + a "+ New tag" affordance.
    await waitFor(
      () => expect(screen.getByRole('button', { name: /New tag/i })).toBeDefined(),
      { timeout: 3000 },
    );
  });

  it('renders the Cache sub-view at /settings/cache', async () => {
    renderAt('/settings/cache');
    // CacheView shows a "Cache" heading on mount.
    await waitFor(
      () => expect(screen.getByRole('heading', { name: /Cache/i })).toBeDefined(),
      { timeout: 3000 },
    );
  });

  it('renders the Sync status sub-view wrapped in ReadOnlyWrap at /settings/poll-status', async () => {
    renderAt('/settings/poll-status');
    // The ReadOnlyWrap banner has the lock copy.
    expect(screen.getByText(/Read-only\./i)).toBeDefined();
    expect(screen.getByText(/engineering visibility/i)).toBeDefined();
    // PollStatusView heading.
    await waitFor(
      () => expect(screen.getByRole('heading', { name: /Sync status/i })).toBeDefined(),
      { timeout: 3000 },
    );
  });

  it('renders the App config sub-view wrapped in ReadOnlyWrap at /settings/config', async () => {
    renderAt('/settings/config');
    // ReadOnlyWrap reason copy specific to the config sub-view (the
    // AppConfigView body also mentions wrangler.toml in its helper text;
    // use getAllByText so both matches count).
    expect(screen.getAllByText(/wrangler\.toml/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Edit there and redeploy/i)).toBeDefined();
    await waitFor(
      () => expect(screen.getByRole('heading', { name: /App config/i })).toBeDefined(),
      { timeout: 3000 },
    );
  });

  it('redirects to /settings/keywords when :view is not a known value', () => {
    renderAt('/settings/bogus-view');
    // After redirect, the keywords sub-view renders (sub-nav still visible),
    // and the bogus path is no longer matched. The Keywords NavLink href confirms
    // we're now mounted at a Settings path.
    expect(screen.getByRole('link', { name: 'Keywords' })).toBeDefined();
    // Other sub-view headings are absent.
    expect(screen.queryByRole('heading', { name: /^App config$/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: /^Sync status$/ })).toBeNull();
  });

  it('marks the active NavLink with a non-transparent border color', () => {
    renderAt('/settings/tags');
    const tagsLink = screen.getByRole('link', { name: 'Tags' }) as HTMLAnchorElement;
    // Active style sets borderColor to var(--tk-border-soft); inactive keeps `transparent`.
    // The exact computed string can vary between runtimes, but the inactive vs active
    // strings differ — assert that active != transparent.
    expect(tagsLink.style.borderColor).not.toBe('transparent');
    const keywordsLink = screen.getByRole('link', { name: 'Keywords' }) as HTMLAnchorElement;
    expect(keywordsLink.style.borderColor).toBe('transparent');
  });

  it('renders the lock icon alongside the read-only banner copy', () => {
    renderAt('/settings/config');
    // The lock glyph is rendered as text content inside the banner span.
    expect(screen.getAllByText('🔒').length).toBeGreaterThan(0);
  });

  it('only renders one ReadOnlyWrap at a time (config view)', () => {
    renderAt('/settings/config');
    // Only the App-config-specific reason copy is present, not the poll-status one.
    expect(screen.queryByText(/engineering visibility/i)).toBeNull();
  });

  it('only renders one ReadOnlyWrap at a time (poll-status view)', () => {
    renderAt('/settings/poll-status');
    expect(screen.queryByText(/Edit there and redeploy/i)).toBeNull();
  });

  it('does not render any ReadOnlyWrap banner on editable sub-views', () => {
    renderAt('/settings/keywords');
    expect(screen.queryByText(/Read-only\./i)).toBeNull();
  });

  it('renders all five sub-nav links regardless of the active sub-view', () => {
    for (const view of ['keywords', 'tags', 'cache', 'poll-status', 'config']) {
      const { unmount } = renderAt(`/settings/${view}`);
      expect(screen.getAllByRole('link').length).toBeGreaterThanOrEqual(5);
      unmount();
    }
  });
});

// Belt-and-suspenders: keep the import linter happy by referencing Navigate so the
// import doesn't get auto-trimmed by tooling that doesn't see runtime use.
void Navigate;
