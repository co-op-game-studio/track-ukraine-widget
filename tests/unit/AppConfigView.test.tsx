/**
 * Tests for src/admin/components/settings/AppConfigView.tsx.
 *
 * Source-file JSDoc anchors:
 *   "Settings ▸ App config — read-only display of deployment-time settings.
 *    Everything here is set per-env in wrangler.toml (cron schedule, concurrency)
 *    and surfaced via /api/admin/config."
 *
 * Verifies:
 *   - Initial render shows the static heading + muted helper text + Lifting cap table
 *     (which is independent of the fetched config).
 *   - After GET /api/admin/config resolves, the dynamic config table renders the
 *     deployment-time values (POLL_CONCURRENCY, SOCIAL_POLL_CRON, derived staleness,
 *     curation mode static row).
 *   - On fetch error with a `detail` field, the detail string is surfaced as the
 *     error message.
 *   - On fetch error without a `detail` field, the stringified error is surfaced.
 *   - The static "Lifting rate / quota caps" table renders all four platforms with
 *     external links carrying target=_blank + rel=noopener.
 *
 * Trace: FR-52 AC-52.x (admin Settings ▸ App config surface).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AppConfigView } from '../../src/admin/components/settings/AppConfigView';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('AppConfigView', () => {
  beforeEach(() => {
    // Default: a happy fetch response so each test that doesn't override gets sane values.
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          pollConcurrency: 4,
          socialPollCron: '*/15 * * * *',
          socialPollStalenessMin: 10,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
  });

  it('renders the static heading and helper text immediately on mount', () => {
    render(<AppConfigView />);
    expect(screen.getByRole('heading', { name: /App config/i, level: 2 })).toBeDefined();
    expect(screen.getByText(/Read-only deployment-time settings/i)).toBeDefined();
    expect(screen.getByText(/wrangler\.toml/i)).toBeDefined();
  });

  it('renders the static "Lifting rate / quota caps" subhead and all four platform rows on mount', () => {
    render(<AppConfigView />);
    expect(screen.getByRole('heading', { name: /Lifting rate \/ quota caps/i, level: 3 })).toBeDefined();
    // All four platform rows render synchronously (independent of fetch).
    expect(screen.getByText('Bluesky')).toBeDefined();
    expect(screen.getByText('Mastodon')).toBeDefined();
    expect(screen.getByText('YouTube')).toBeDefined();
    expect(screen.getByText('Twitter / X')).toBeDefined();
  });

  it('YouTube and Twitter quota rows expose external links with safe target/rel', () => {
    render(<AppConfigView />);
    const ytLink = screen.getByRole('link', { name: /Google Cloud Console/i });
    expect(ytLink.getAttribute('target')).toBe('_blank');
    expect(ytLink.getAttribute('rel')).toMatch(/noopener/);
    expect(ytLink.getAttribute('href')).toMatch(/console\.cloud\.google\.com/);

    const xLink = screen.getByRole('link', { name: /developer\.x\.com/i });
    expect(xLink.getAttribute('target')).toBe('_blank');
    expect(xLink.getAttribute('rel')).toMatch(/noopener/);
  });

  it('renders the dynamic config table once /api/admin/config resolves', async () => {
    render(<AppConfigView />);
    // Wait for the configured row labels to appear.
    await waitFor(() => expect(screen.getByText('POLL_CONCURRENCY')).toBeDefined());
    expect(screen.getByText('SOCIAL_POLL_CRON')).toBeDefined();
    expect(screen.getByText(/staleness window \(derived\)/i)).toBeDefined();
    expect(screen.getByText(/curation mode/i)).toBeDefined();
    // Values render.
    expect(screen.getByText('4')).toBeDefined();
    expect(screen.getByText('*/15 * * * *')).toBeDefined();
    expect(screen.getByText('10 min')).toBeDefined();
    expect(screen.getByText('Keyword-only')).toBeDefined();
  });

  it('does not render the dynamic config table while fetch is pending', () => {
    let resolveFetch!: (r: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    globalThis.fetch = async () => pending;
    render(<AppConfigView />);
    // Dynamic-table-only labels are absent pre-resolution.
    expect(screen.queryByText('POLL_CONCURRENCY')).toBeNull();
    expect(screen.queryByText('SOCIAL_POLL_CRON')).toBeNull();
    // Resolve to clean up the pending promise (no assertion needed).
    resolveFetch(
      new Response(
        JSON.stringify({
          pollConcurrency: 1,
          socialPollCron: '* * * * *',
          socialPollStalenessMin: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
  });

  it('surfaces the `detail` field from a structured FetchError on non-2xx', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ error: 'forbidden', detail: 'CF Access denied for this user' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
    render(<AppConfigView />);
    await waitFor(() =>
      expect(screen.getByText(/CF Access denied for this user/)).toBeDefined(),
    );
    // Dynamic config table did NOT render.
    expect(screen.queryByText('POLL_CONCURRENCY')).toBeNull();
  });

  it('falls back to String(error) when the rejection has no `detail` field', async () => {
    // Throw a non-Response error from inside fetch — the catch branch stringifies it.
    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    render(<AppConfigView />);
    await waitFor(() =>
      expect(screen.getByText(/network down/)).toBeDefined(),
    );
  });

  it('renders the SOCIAL_POLL_CRON value with monospaced font styling', async () => {
    render(<AppConfigView />);
    const cronCell = await screen.findByText('*/15 * * * *');
    // The `mono` Row variant adds the monospace font-family style.
    expect((cronCell as HTMLElement).style.fontFamily).toMatch(/mono/);
  });
});
