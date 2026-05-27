/**
 * Tests for src/ingest/register.ts.
 *
 * The module body has side-effects (registers Bluesky + Mastodon at import time).
 * This test verifies:
 *   - Side-effect imports register the always-on adapters
 *   - registerYouTube() conditionally adds YouTube when an API key is present
 *
 * Trace: FR-59.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { _resetRegistry, listPlatforms, getAdapter } from '../../../src/ingest/factory';

beforeEach(() => {
  _resetRegistry();
});

describe('register.ts side-effect import', () => {
  it('registers bluesky + mastodon at module load', async () => {
    // Re-import to re-trigger module-level side-effects after the reset.
    // Vite/vitest caches modules, so we use the dynamic-import trick + vi.resetModules
    // to force re-evaluation. Simpler: register them by hand here since the
    // side-effect IS the test — and the module's idempotent.
    await import('../../../src/ingest/register');
    const slugs = listPlatforms();
    expect(slugs).toContain('bluesky');
    expect(slugs).toContain('mastodon');
  });
});

describe('registerYouTube', () => {
  it('registers YouTube when called with an API key', async () => {
    const { registerYouTube } = await import('../../../src/ingest/register');
    registerYouTube('test-api-key');
    const yt = getAdapter('youtube');
    expect(yt).toBeDefined();
    expect(yt.platform).toBe('youtube');
  });
});
