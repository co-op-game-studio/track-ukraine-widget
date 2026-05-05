/**
 * Score Breakdown Panel — Integration
 *
 * Exercises the full hook → component chain for the UAT breakdown panel:
 * `useVotingRecord` + `useSponsoredBills` + `useUkraineScore` +
 * `UkraineScoreBadge`, wired through `RepDetail` against mocked /api/*
 * responses. Where the unit test fakes `VotingRecordData` / `SponsoredBillsData`
 * directly, this test drives them via the real fetch path so the per-action
 * contribution math + valence classes + final-score reconciliation are
 * verified against what the services actually emit.
 *
 * Traces to: FR-43 AC-43.9, AC-43.10, AC-43.11, AC-43.12, AC-43.13,
 * US-7 AC-7.8. Also incidentally covers FR-16 score composition and
 * FR-21 obstruction surfacing because those are on the same path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { RepDetail } from '../../src/components/RepDetail';
import { MemberChip } from '../../src/components/MemberChip';
import type { Representative } from '../../src/types/domain';

/** A real curated House roll-call we can key mocks off of. */
const HR2471_RC65 = { congress: 117, session: 2, rollCall: 65 }; // weight 0.9

const houseRep: Representative = {
  bioguideId: 'D000096',
  name: 'Davis, Danny',
  party: 'Democratic',
  partyAbbreviation: 'D',
  state: 'IL',
  district: 7,
  chamber: 'house',
  photoUrl: null,
  isNonVoting: false,
  officialWebsiteUrl: null,
};

/** Empty member profile — no sponsored/cosponsored bills. */
function emptyProfile(bioguideId: string) {
  return {
    bioguideId,
    first: 'Danny', last: 'Davis', officialName: 'Danny Davis',
    state: 'IL', district: 7, chamber: 'House', party: 'D',
    photoUrl: null, website: null, searchKey: 'davis,danny',
    sponsored: [],
    cosponsored: [],
    generatedAt: '2026-04-19T02:00:00Z',
    schemaVersion: 1,
  };
}

/** A member profile with ONE cosponsored pro-Ukraine bill (HR 7691). */
function profileWithCosponsor(bioguideId: string) {
  return {
    ...emptyProfile(bioguideId),
    cosponsored: [
      {
        congress: 117,
        type: 'HR',
        number: '7691',
        title: '$40B Ukraine Supplemental',
        introducedDate: '2022-05-10',
        latestAction: { text: 'Became law' },
      },
    ],
  };
}

/** A member profile with TWO cosponsored pro-Ukraine bills — needed under
 *  FR-55 to clear NEW_REP_THRESHOLD=2 so a numeric score is rendered. */
function profileWithTwoCosponsorships(bioguideId: string) {
  return {
    ...emptyProfile(bioguideId),
    cosponsored: [
      {
        congress: 117,
        type: 'HR',
        number: '7691',
        title: '$40B Ukraine Supplemental',
        introducedDate: '2022-05-10',
        latestAction: { text: 'Became law' },
      },
      {
        congress: 118,
        type: 'HR',
        number: '815',
        title: 'Israel Security Supplemental Appropriations Act, 2024',
        introducedDate: '2024-02-13',
        latestAction: { text: 'Became law' },
      },
    ],
  };
}

/** House roster payload for a given roll-call; target bioguide gets `cast`,
 *  everyone else gets an irrelevant vote. */
function houseRoster(rc: { congress: number; session: number; rollCall: number },
                     bioguideId: string, cast: string) {
  const casts: Record<string, string> = { [bioguideId]: cast };
  for (let i = 0; i < 50; i++) casts[`F${i}`] = 'Yea';
  return {
    rollCallId: `house:${rc.congress}:${rc.session}:${rc.rollCall}`,
    chamber: 'house',
    ...rc,
    casts,
    generatedAt: '2026-04-19T02:00:00Z',
    schemaVersion: 1,
  };
}

type Route = { match: RegExp | ((u: string) => boolean); body: unknown; status?: number };

function installFetch(routes: Route[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    for (const r of routes) {
      const hit = typeof r.match === 'function' ? r.match(url) : r.match.test(url);
      if (hit) return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }
    // Default: empty roster so unmatched curated votes are treated as
    // Did Not Serve and drop out of the flat list.
    if (url.includes('/api/roll-call-rosters/')) {
      const m = url.match(/\/roll-call-rosters\/(house|senate)\/(\d+)\/(\d+)\/(\d+)/);
      if (m) {
        const chamber = m[1]!;
        const body = chamber === 'house'
          ? { rollCallId: 'x', chamber, congress: +m[2]!, session: +m[3]!, rollCall: +m[4]!, casts: {}, generatedAt: '', schemaVersion: 1 }
          : { rollCallId: 'x', chamber, congress: +m[2]!, session: +m[3]!, rollCall: +m[4]!, casts: [], generatedAt: '', schemaVersion: 1 };
        return new Response(JSON.stringify(body), { status: 200 });
      }
    }
    return new Response(`No mock for ${url}`, { status: 500 });
  });
}

describe('Score breakdown panel (integration)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('AC-43.9 — header is a toggle button that expands/collapses the breakdown panel', async () => {
    installFetch([
      { match: /\/api\/members\/D000096/, body: emptyProfile('D000096') },
    ]);
    const { container } = render(<RepDetail representative={houseRep} apiBase="" onClose={() => {}} />);

    // Wait for hooks to settle so the score has been computed (or null).
    await waitFor(() => {
      expect(container.querySelector('.viw-score-header-toggle')).not.toBeNull();
    });
    const header = container.querySelector('.viw-score-header-toggle') as HTMLButtonElement;
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('#viw-score-breakdown-panel')).toBeNull();

    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('#viw-score-breakdown-panel')).not.toBeNull();

    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('#viw-score-breakdown-panel')).toBeNull();
  });

  it('AC-43.10 — per-action table reconciles Σ/Σ with the badge value for HR 2471 Aye + HR 7691 cosponsor', async () => {
    // Under FR-55 NEW_REP_THRESHOLD=2 we need at least two contributing
    // actions for the badge to render a number; combining a vote with a
    // cosponsorship gets us there while still exercising the AC-43.10
    // sign/amp/weight reconciliation contract.
    installFetch([
      { match: /\/api\/members\/D000096/, body: profileWithCosponsor('D000096') },
      {
        match: /\/roll-call-rosters\/house\/117\/2\/65\b/,
        body: houseRoster(HR2471_RC65, 'D000096', 'Yea'),
      },
    ]);
    const { container } = render(<RepDetail representative={houseRep} apiBase="" onClose={() => {}} />);

    // Wait for the hook to produce both rows in the flat list. With
    // 1 vote (sign=+1, amp=1.0, w=0.9 → +0.9) + 1 cosponsorship
    // (sign=+1, amp=1.5, w=1.0 → +1.5), Σ signed = +2.4, Σ mag = 2.4,
    // score = +1.00.
    await waitFor(() => {
      const badge = container.querySelector('.viw-score-value');
      expect(badge?.textContent?.trim()).toBe('+1.00');
    });

    fireEvent.click(container.querySelector('.viw-score-header-toggle')!);

    const table = container.querySelector('.viw-score-breakdown-table')!;
    const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
    expect(bodyRows.length).toBe(2);
    // Sponsorships render first; the voted row should be the second.
    const voteRow = bodyRows[1]!;
    expect(voteRow.classList.contains('viw-valence-voted-pro')).toBe(true);
    const billCell = voteRow.querySelector('.viw-score-row-bill')!;
    expect(billCell.querySelector('.viw-score-row-bill-slug')?.textContent).toBe('HR 2471');
    expect(billCell.querySelector('.viw-score-row-bill-desc')?.textContent)
      .toMatch(/FY22 Consolidated Appropriations/);
    expect(billCell.querySelector('.viw-score-row-bill-action')?.textContent)
      .toMatch(/Voted Aye/);
    const tds = voteRow.querySelectorAll('td');
    expect(tds[0]!.textContent).toBe('+1');
    expect(tds[1]!.textContent).toMatch(/1\.0 × 0\.90/);
    expect(tds[2]!.textContent).toBe('+0.90');

    const foot = table.querySelector('tfoot')!;
    // Σ mag = 1.5 + 0.9 = 2.40; Σ signed = +2.40; score = +1.00.
    expect(foot.textContent).toMatch(/2\.40/);
    expect(foot.textContent).toMatch(/\+1\.00/);
  });

  it('AC-43.10/43.12 — cosponsorship renders a sponsor-pro row with 1.5× amplifier contribution', async () => {
    // FR-55 NEW_REP_THRESHOLD=2 — use two cosponsorships so the badge shows
    // a number rather than "Insufficient record".
    installFetch([
      { match: /\/api\/members\/D000096/, body: profileWithTwoCosponsorships('D000096') },
    ]);
    const { container } = render(<RepDetail representative={houseRep} apiBase="" onClose={() => {}} />);

    await waitFor(() => {
      const v = container.querySelector('.viw-score-value');
      expect(v?.textContent?.trim()).toBe('+1.00');
    });

    fireEvent.click(container.querySelector('.viw-score-header-toggle')!);

    const table = container.querySelector('.viw-score-breakdown-table')!;
    const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
    // Both cosponsorships render with sponsor-pro valence + 1.5× amplifier.
    const sponsorRow = bodyRows[0]!;
    expect(sponsorRow.classList.contains('viw-valence-sponsor-pro')).toBe(true);
    expect(sponsorRow.querySelector('.viw-score-row-bill-action')?.textContent).toBe('Cosponsored');
    const tds = sponsorRow.querySelectorAll('td');
    expect(tds[0]!.textContent).toBe('+1');
    expect(tds[1]!.textContent).toMatch(/1\.5 × 1\.00/);
    expect(tds[2]!.textContent).toBe('+1.50');
  });

  it('AC-43.11 — the bar+obstruction region is a second toggle that opens the same panel', async () => {
    // FR-55 — combine the vote with a cosponsorship so the bar (which only
    // renders for a non-null displayed score) is visible.
    installFetch([
      { match: /\/api\/members\/D000096/, body: profileWithCosponsor('D000096') },
      {
        match: /\/roll-call-rosters\/house\/117\/2\/65\b/,
        body: houseRoster(HR2471_RC65, 'D000096', 'Yea'),
      },
    ]);
    const { container } = render(<RepDetail representative={houseRep} apiBase="" onClose={() => {}} />);

    await waitFor(() => {
      expect(container.querySelector('.viw-score-bar-toggle')).not.toBeNull();
    });
    const barToggle = container.querySelector('.viw-score-bar-toggle') as HTMLButtonElement;
    expect(barToggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('#viw-score-breakdown-panel')).toBeNull();

    fireEvent.click(barToggle);
    expect(barToggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('#viw-score-breakdown-panel')).not.toBeNull();

    // The header toggle and bar toggle share state — clicking the header
    // now should collapse it.
    fireEvent.click(container.querySelector('.viw-score-header-toggle')!);
    expect(barToggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('#viw-score-breakdown-panel')).toBeNull();
  });

  it('AC-43.13 — bar + obstruction note render ABOVE the breakdown panel when expanded', async () => {
    installFetch([
      { match: /\/api\/members\/D000096/, body: profileWithCosponsor('D000096') },
      {
        match: /\/roll-call-rosters\/house\/117\/2\/65\b/,
        body: houseRoster(HR2471_RC65, 'D000096', 'Yea'),
      },
    ]);
    const { container } = render(<RepDetail representative={houseRep} apiBase="" onClose={() => {}} />);
    await waitFor(() => {
      expect(container.querySelector('.viw-score-value')?.textContent?.trim()).toBe('+1.00');
    });
    fireEvent.click(container.querySelector('.viw-score-header-toggle')!);
    const bar = container.querySelector('.viw-score-bar')!;
    const panel = container.querySelector('#viw-score-breakdown-panel')!;
    expect(bar.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // US-7 AC-7.8 — MemberChip integration: the state line rolls through to
  // real Representative objects (not a hand-made senator fixture).
  it('US-7 AC-7.8 — chip renders the state name for a senator Representative object', () => {
    const senator: Representative = {
      ...houseRep,
      bioguideId: 'D000563',
      name: 'Durbin, Richard J.',
      chamber: 'senate',
      district: null,
      state: 'IL',
    };
    const { container } = render(
      <MemberChip representative={senator} selected={false} onClick={() => {}} />,
    );
    expect(container.querySelector('.viw-chip-state')?.textContent).toMatch(/Illinois/i);
  });
});
