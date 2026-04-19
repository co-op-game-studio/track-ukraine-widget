/**
 * sanitizeUrlBoundary — audit that `sanitizeUrl` is applied at the render
 * boundary (not just at fetch time). A compromised upstream that lands a
 * `javascript:` / `data:` / `vbscript:` / `file://` URL in Representative or
 * UkraineBill state MUST NOT produce a live dangerous href/src in the DOM.
 *
 * Traces: FR-44 AC-44.18 (T-094), AC-31.1.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemberChip } from '../../src/components/MemberChip';
import { BillList } from '../../src/components/BillList';
import type { Representative } from '../../src/types/domain';
import type { UkraineBill } from '../../src/hooks/useSponsoredBills';

// Stub RepDetail's data hooks so the component renders deterministically
// with only the header (photo + official-website link) under test.
vi.mock('../../src/hooks/useVotingRecord', () => ({
  useVotingRecord: () => ({
    status: 'success',
    data: {
      clusters: [],
      flat: [],
      voteScore: { score: 0, contributing: 0, total: 0, lowConfidence: false },
      obstructionCount: 0,
      primaryAbstentionCount: 0,
    },
    error: null,
    load: vi.fn(),
    reset: vi.fn(),
  }),
}));
vi.mock('../../src/hooks/useSponsoredBills', () => ({
  useSponsoredBills: () => ({
    status: 'success',
    data: { sponsored: [], cosponsored: [] },
    error: null,
    load: vi.fn(),
    reset: vi.fn(),
  }),
}));
vi.mock('../../src/hooks/useUkraineScore', () => ({
  useUkraineScore: () => ({ score: 0, contributing: 0, total: 0, lowConfidence: false }),
}));

// RepDetail calls fetch(`/api/members/{id}`) in useEffect. Stub to a
// no-op rejection so `enriched` stays equal to the passed-in representative
// — that's the attack scenario we exercise at the render boundary.
globalThis.fetch = vi.fn(async () => {
  throw new Error('network disabled in test');
}) as unknown as typeof fetch;

import { RepDetail } from '../../src/components/RepDetail';

const DANGEROUS_SCHEMES = /^(javascript|data|vbscript|file):/i;

function makeRep(overrides: Partial<Representative> = {}): Representative {
  return {
    bioguideId: 'T000001',
    name: 'Test Member',
    party: 'Democratic',
    partyAbbreviation: 'D',
    state: 'IL',
    district: null,
    chamber: 'senate',
    photoUrl: null,
    isNonVoting: false,
    officialWebsiteUrl: null,
    ...overrides,
  };
}

function makeBill(overrides: Partial<UkraineBill> = {}): UkraineBill {
  return {
    number: 'H.R. 7691',
    title: 'Test Bill',
    dateIntroduced: '2022-05-10',
    latestAction: 'Became Public Law',
    congressGovUrl: '',
    relationship: 'sponsored',
    featured: false,
    direction: 'pro-ukraine',
    valence: 'sponsor-pro',
    summary: null,
    curated: {
      congress: 117, type: 'HR', number: '7691',
      featured: false, label: '', title: null,
      latestAction: null, latestActionDate: null,
      becameLaw: true, congressGovUrl: '',
      direction: 'pro-ukraine', directionReason: 'manual',
      summary: null, votes: [],
    },
    ...overrides,
  };
}

function assertNoDangerousSrc(container: HTMLElement): void {
  container.querySelectorAll('img').forEach((img) => {
    expect(img.getAttribute('src') ?? '').not.toMatch(DANGEROUS_SCHEMES);
  });
}

function assertNoDangerousHref(container: HTMLElement): void {
  container.querySelectorAll('a[href]').forEach((a) => {
    expect(a.getAttribute('href') ?? '').not.toMatch(DANGEROUS_SCHEMES);
  });
}

describe('sanitizeUrl render-boundary audit (AC-44.18, AC-31.1)', () => {
  it('MemberChip: malicious photoUrl values never reach img[src]', () => {
    const attacks = [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:MsgBox(1)',
      '   javascript:alert(1)',
    ];
    for (const photoUrl of attacks) {
      const { container, unmount } = render(
        <MemberChip
          representative={makeRep({ photoUrl })}
          selected={false}
          onClick={() => {}}
        />,
      );
      assertNoDangerousSrc(container);
      // The component degrades to a placeholder when sanitizeUrl returns null.
      expect(container.querySelector('.viw-chip-photo-placeholder')).not.toBeNull();
      unmount();
    }
  });

  it('BillList: malicious congressGovUrl values never reach a[href]', () => {
    const attacks = [
      'javascript:void(0)',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
    ];
    for (const congressGovUrl of attacks) {
      const bill = makeBill({ congressGovUrl });
      const { container, unmount } = render(
        <BillList sponsored={[bill]} cosponsored={[]} />,
      );
      assertNoDangerousHref(container);
      // Sanitized links fall back to href="#" — verify the dangerous value
      // isn't even present as a raw attribute string.
      const billLink = container.querySelector('a.viw-billlist-link');
      expect(billLink).not.toBeNull();
      expect(billLink?.getAttribute('href')).toBe('#');
      unmount();
    }
  });

  it('RepDetail: malicious photoUrl and officialWebsiteUrl never reach DOM attrs', () => {
    const attacks = [
      { photoUrl: 'javascript:alert(1)', officialWebsiteUrl: 'javascript:alert(2)' },
      { photoUrl: 'vbscript:MsgBox(1)', officialWebsiteUrl: 'file:///etc/passwd' },
      { photoUrl: 'data:text/html,<script>alert(1)</script>', officialWebsiteUrl: '   javascript:alert(1)' },
    ];
    for (const patch of attacks) {
      const { container, unmount } = render(
        <RepDetail
          representative={makeRep(patch)}
          apiBase="https://example.test"
          onClose={() => {}}
        />,
      );
      assertNoDangerousSrc(container);
      assertNoDangerousHref(container);
      // Photo slot must degrade to a placeholder rather than render img with no/bad src.
      expect(container.querySelector('.viw-detail-photo-placeholder')).not.toBeNull();
      // Official-website link is rendered only when the sanitizer returns a value,
      // so a rejected URL should produce no anchor with class 'viw-detail-link'.
      expect(container.querySelector('a.viw-detail-link')).toBeNull();
      unmount();
    }
  });

  it('valid https:// URLs pass through unchanged (guards against over-sanitization)', () => {
    const SITE = 'https://www.durbin.senate.gov';
    const PHOTO = 'https://www.congress.gov/img/durbin.jpg';
    const BILL_URL = 'https://www.congress.gov/bill/118/hr/1234';

    const chip = render(
      <MemberChip
        representative={makeRep({ photoUrl: PHOTO })}
        selected={false}
        onClick={() => {}}
      />,
    );
    const img = chip.container.querySelector('img');
    expect(img?.getAttribute('src')).toBe(PHOTO);
    chip.unmount();

    const bills = render(
      <BillList sponsored={[makeBill({ congressGovUrl: BILL_URL })]} cosponsored={[]} />,
    );
    const billLink = bills.container.querySelector('a.viw-billlist-link');
    expect(billLink?.getAttribute('href')).toBe(BILL_URL);
    bills.unmount();

    const detail = render(
      <RepDetail
        representative={makeRep({ photoUrl: PHOTO, officialWebsiteUrl: SITE })}
        apiBase="https://example.test"
        onClose={() => {}}
      />,
    );
    const detailImg = detail.container.querySelector('img.viw-detail-photo');
    expect(detailImg?.getAttribute('src')).toBe(PHOTO);
    const detailLink = detail.container.querySelector('a.viw-detail-link');
    expect(detailLink?.getAttribute('href')).toBe(SITE);
    detail.unmount();
  });
});
