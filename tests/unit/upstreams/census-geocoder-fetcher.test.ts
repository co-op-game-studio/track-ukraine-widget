/**
 * Tests for proxy/upstreams/census-geocoder-fetcher.ts.
 *
 * NOT R2-eligible (address uniqueness). No sessionStatus stamping.
 * Carries raw path+qs parameters because the Census geocoder has many
 * sub-endpoints and this tier should not encode route knowledge.
 *
 * Traces: FR-40 AC-40.7, FR-41 data-type matrix.
 */
import { describe, expect, it, vi } from 'vitest';
import { CensusGeocoderFetcher } from '../../../proxy/upstreams/census-geocoder-fetcher';

const NOW = new Date('2026-04-19T00:00:00Z');
const BODY = JSON.stringify({ result: { addressMatches: [] } });

describe('CensusGeocoderFetcher', () => {
  it('canHandle census-geocoder', () => {
    const f = new CensusGeocoderFetcher({ fetch: vi.fn(), now: () => NOW });
    expect(f.canHandle({ kind: 'census-geocoder', params: {} })).toBe(true);
    expect(f.canHandle({ kind: 'member-detail', params: {} })).toBe(false);
  });

  it('composes geocoding.geo.census.gov + path + qs', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(BODY, { status: 200 }));
    const f = new CensusGeocoderFetcher({ fetch: mock, now: () => NOW });
    await f.fetch(
      { kind: 'census-geocoder', params: { path: 'geocoder/geographies/onelineaddress', qs: 'address=1600+Pennsylvania&benchmark=4' } },
      { traceId: 'tr_0123456789abcdef' },
    );
    const url = mock.mock.calls[0]![0] as string;
    expect(url).toBe('https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?address=1600+Pennsylvania&benchmark=4');
  });

  it('handles empty qs cleanly', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(BODY, { status: 200 }));
    const f = new CensusGeocoderFetcher({ fetch: mock, now: () => NOW });
    await f.fetch(
      { kind: 'census-geocoder', params: { path: 'x/y', qs: '' } },
      { traceId: 'tr_0123456789abcdef' },
    );
    expect(mock.mock.calls[0]![0]).toBe('https://geocoding.geo.census.gov/x/y');
  });

  it('does NOT stamp sessionStatus', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(BODY, { status: 200 }));
    const f = new CensusGeocoderFetcher({ fetch: mock, now: () => NOW });
    const e = await f.fetch(
      { kind: 'census-geocoder', params: { path: 'x', qs: 'y=1' } },
      { traceId: 'tr_0123456789abcdef' },
    );
    expect(e.sessionStatus).toBeUndefined();
    expect(e.sourceUpstream).toBe('census');
  });

  it('forwards X-Trace-Id', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(BODY, { status: 200 }));
    const f = new CensusGeocoderFetcher({ fetch: mock, now: () => NOW });
    await f.fetch(
      { kind: 'census-geocoder', params: { path: 'x', qs: '' } },
      { traceId: 'tr_deadbeefcafebabe' },
    );
    const h = new Headers((mock.mock.calls[0]![1] as RequestInit).headers);
    expect(h.get('X-Trace-Id')).toBe('tr_deadbeefcafebabe');
  });

  it('throws on upstream error', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    const f = new CensusGeocoderFetcher({ fetch: mock, now: () => NOW });
    await expect(f.fetch({ kind: 'census-geocoder', params: { path: 'x', qs: '' } }, { traceId: 'tr_0123456789abcdef' })).rejects.toThrow(/500/);
  });
});
