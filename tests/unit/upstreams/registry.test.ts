/**
 * Tests for proxy/upstreams/registry.ts — UpstreamFetcher dispatch.
 *
 * The registry holds every fetcher and picks the right one via `canHandle`.
 * Fail-loud: throws when no fetcher claims the key.
 */
import { describe, expect, it, vi } from 'vitest';
import { createUpstreamRegistry } from '../../../proxy/upstreams/registry';

const NOW = new Date('2026-04-19T00:00:00Z');

describe('createUpstreamRegistry — dispatch by canHandle', () => {
  it('returns a fetcher for senate-xml', () => {
    const reg = createUpstreamRegistry({ apiKey: 'k', fetch: vi.fn(), now: () => NOW });
    const f = reg.getFor({ kind: 'senate-xml', params: { congress: 117, session: 2, rollCall: 78 } });
    expect(f).not.toBeNull();
    expect(f?.canHandle({ kind: 'senate-xml', params: {} })).toBe(true);
  });

  it('returns a fetcher for each of the 6 cache kinds we cover', () => {
    const reg = createUpstreamRegistry({ apiKey: 'k', fetch: vi.fn(), now: () => NOW });
    const kinds = [
      'senate-xml', 'house-roster', 'house-vote-detail',
      'bill-actions', 'bill-summaries', 'member-detail', 'census-geocoder',
    ] as const;
    for (const kind of kinds) {
      const f = reg.getFor({ kind, params: {} });
      expect(f, `kind=${kind} has no fetcher`).not.toBeNull();
    }
  });

  it('returns null for unhandled cache kind', () => {
    const reg = createUpstreamRegistry({ apiKey: 'k', fetch: vi.fn(), now: () => NOW });
    // member-profile is a KV-owned kind, not routed through any upstream
    expect(reg.getFor({ kind: 'member-profile', params: {} })).toBeNull();
  });
});
