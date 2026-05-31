/**
 * Widget direct-to-member deep link — FR-60 AC-60.3, AC-60.4, AC-60.5.
 *
 * When VoterInfoWidget mounts with a shape-valid `initialBioguide`, it fetches
 * `/api/members/{id}`, builds a Representative, and renders that member's
 * RepDetail open on load — with no `/api/name-search` request and no
 * NameSearchResultsPanel. An unknown bioguide (404) degrades to the normal
 * entry screen without throwing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { VoterInfoWidget } from '../../src/VoterInfoWidget';

/** Minimal /api/members/{id} record — the real route returns this shape
 *  (proxy/routes/api-members.ts buildProfileFromUpstream). */
const DURBIN = {
  bioguideId: 'D000563',
  first: 'Richard',
  last: 'Durbin',
  officialName: 'Richard J. Durbin',
  // The real /api/members/{id} route returns the FULL Congress.gov state name,
  // not the two-letter code — useMemberById must normalize it (FR-60 AC-60.3)
  // so the Senate roster match (keyed by two-letter state) works.
  state: 'Illinois',
  district: null,
  chamber: 'Senate',
  party: 'D',
  photoUrl: 'https://www.congress.gov/img/member/d000563.jpg',
  website: 'https://www.durbin.senate.gov',
  yearEntered: 1997,
  sponsored: [],
  cosponsored: [],
  partyPrior: null,
  generatedAt: '2026-05-30T00:00:00Z',
  schemaVersion: 1,
};

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    return handler(url);
  });
  return calls;
}

describe('Widget deep link (FR-60 AC-60.3)', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('fetches /api/members/{id} and renders RepDetail open, with no name-search', async () => {
    const calls = mockFetch((url) => {
      if (url.includes('/api/members/D000563')) {
        return new Response(JSON.stringify(DURBIN), { status: 200 });
      }
      // votes / bills / quotes / statements ancillary fetches degrade to empty
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const { container } = render(<VoterInfoWidget apiBase="" initialBioguide="D000563" />);

    await waitFor(() => {
      expect(container.querySelector('.viw-detail')).not.toBeNull();
    });
    // The member's RepDetail header carries the name "Durbin, Richard".
    const nameEl = container.querySelector('.viw-detail-name');
    expect(nameEl?.textContent ?? '').toMatch(/Durbin/);
    // No name-search request was issued for the deep-link path.
    expect(calls.some((u) => u.includes('/api/name-search'))).toBe(false);
    // The name-search results panel is not rendered.
    expect(container.querySelector('[aria-label="Name search matches"]')).toBeNull();
    // AC-60.8 — the address + name-search entry controls are hidden in
    // single-member deep-link mode.
    expect(container.querySelector('.viw-address-form')).toBeNull();
    expect(container.querySelector('.viw-name-search-form')).toBeNull();
  });

  it('degrades to the entry screen (no detail) when the member 404s — AC-60.5', async () => {
    mockFetch((url) => {
      if (url.includes('/api/members/')) {
        return new Response(JSON.stringify({ error: 'member_not_found' }), { status: 404 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const { container } = render(<VoterInfoWidget apiBase="" initialBioguide="Z999999" />);

    // Address input is present (normal entry screen) and no detail opens.
    await waitFor(() => {
      expect(container.querySelector('.viw-root')).not.toBeNull();
    });
    // Give the rejected fetch a tick to settle, then assert no detail.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('.viw-detail')).toBeNull();
    // AC-60.5/AC-60.8 — unknown bioguide falls back to the full entry screen,
    // so the entry controls ARE rendered.
    await waitFor(() => {
      expect(container.querySelector('.viw-address-form')).not.toBeNull();
    });
    expect(container.querySelector('.viw-name-search-form')).not.toBeNull();
  });

  it('renders the unchanged entry screen when no initialBioguide is given — AC-60.7', async () => {
    mockFetch(() => new Response(JSON.stringify({}), { status: 200 }));
    const { container } = render(<VoterInfoWidget apiBase="" />);
    expect(container.querySelector('.viw-detail')).toBeNull();
    expect(container.querySelector('.viw-root')).not.toBeNull();
  });
});
