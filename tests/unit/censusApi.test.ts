/**
 * Census Geocoder API Service Tests
 * Traces to: FR-1, FR-2, design.md §4.1
 * Tests the Census geocoder integration — address → state + district
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { geocodeAddress } from '../../src/services/censusApi';

// Mock Census API responses based on real API output
const chicagoResponse = {
  result: {
    addressMatches: [
      {
        matchedAddress: '2000 S STATE ST, CHICAGO, IL, 60616',
        coordinates: { x: -87.627, y: 41.855 },
        addressComponents: { city: 'CHICAGO', state: 'IL', zip: '60616', streetName: 'STATE' },
        geographies: {
          'States': [{ STATE: '17', NAME: 'Illinois', GEOID: '17', BASENAME: 'Illinois', FUNCSTAT: 'A' }],
          '119th Congressional Districts': [
            {
              STATE: '17',
              CD119: '07',
              CDSESSN: '119',
              NAME: 'Congressional District 7',
              GEOID: '1707',
              BASENAME: '7',
              FUNCSTAT: 'N',
            },
          ],
        },
      },
    ],
  },
};

const wyomingResponse = {
  result: {
    addressMatches: [
      {
        matchedAddress: '200 W 24TH ST, CHEYENNE, WY, 82001',
        coordinates: { x: -104.82, y: 41.14 },
        addressComponents: { city: 'CHEYENNE', state: 'WY', zip: '82001', streetName: '24TH' },
        geographies: {
          'States': [{ STATE: '56', NAME: 'Wyoming', GEOID: '56', BASENAME: 'Wyoming', FUNCSTAT: 'A' }],
          '119th Congressional Districts': [
            {
              STATE: '56',
              CD119: '00',
              CDSESSN: '119',
              NAME: 'Congressional District (at Large)',
              GEOID: '5600',
              BASENAME: 'Congressional District (at Large)',
              FUNCSTAT: 'N',
            },
          ],
        },
      },
    ],
  },
};

const noMatchResponse = {
  result: {
    addressMatches: [],
  },
};

describe('geocodeAddress', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts state and district from a standard address', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(chicagoResponse), { status: 200 }),
    );

    const result = await geocodeAddress('2000 S State St, Chicago, IL 60616', '');
    expect(result.state).toBe('IL');
    expect(result.district).toBe(7);
    expect(result.matchedAddress).toBe('2000 S STATE ST, CHICAGO, IL, 60616');
  });

  it('handles at-large districts (CD119="00" → district 0)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(wyomingResponse), { status: 200 }),
    );

    const result = await geocodeAddress('200 W 24th St, Cheyenne, WY 82001', '');
    expect(result.state).toBe('WY');
    expect(result.district).toBe(0);
  });

  it('throws when address has no match', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(noMatchResponse), { status: 200 }),
    );

    await expect(
      geocodeAddress('Fake Address, Nowhere, XX 00000', ''),
    ).rejects.toThrow();
  });

  it('throws on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

    await expect(
      geocodeAddress('123 Main St, Springfield, IL 62701', ''),
    ).rejects.toThrow();
  });

  it('calls the correct Census geocoder URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(chicagoResponse), { status: 200 }),
    );

    await geocodeAddress('2000 S State St, Chicago, IL 60616', '/proxy');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toContain('/proxy/api/census/');
    expect(url).toContain('benchmark=Public_AR_Current');
    expect(url).toContain('vintage=Current_Current');
    expect(url).toContain('format=json');
  });
});
