/**
 * FR-34 — Mobile Layout Adaptations.
 *
 * Three flanks:
 *   1. JSX: vote-list and bill-list <td> elements carry `data-label`
 *      attributes per AC-34.3/4 (so the CSS ::before rule can render the
 *      column label above each stacked cell).
 *   2. CSS: the stylesheet contains the @media (max-width: 640px) block
 *      with the required declarations per AC-34.3/4/5/6.
 *   3. Address-form CSS: the @media (max-width: 520px) block exists per
 *      AC-34.1/2, and the input's font-size is 16px (iOS no-zoom guard).
 *
 * Full layout/overflow validation lives in manual preview verification;
 * this file pins the structural invariants.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { VoteList } from '../../src/components/VoteList';
import { BillList } from '../../src/components/BillList';
import type { ClusteredMemberVoteWithValence } from '../../src/hooks/useVotingRecord';
import type { UkraineBill } from '../../src/hooks/useSponsoredBills';

const CSS_PATH = resolve(__dirname, '..', '..', 'src', 'styles', 'widget.css');
const css = readFileSync(CSS_PATH, 'utf8');

describe('AC-34.3 — VoteList cells carry data-label for stacked-card layout', () => {
  const row: ClusteredMemberVoteWithValence = {
    primary: {
      bill: {
        congress: 118,
        type: 'HR',
        number: '815',
        direction: 'pro-ukraine',
        featured: true,
        title: '$95B National Security Supplemental',
        label: '$95B National Security Supplemental',
        becameLaw: true,
        congressGovUrl: 'https://congress.gov/bill/118/hr/815',
        summary: null,
      },
      vote: {
        chamber: 'Senate',
        congress: 118,
        session: 2,
        rollCall: 154,
        date: '2024-02-13T11:37:05Z',
        action: 'Passed Senate',
        weight: 1,
        directionMultiplier: 1,
      },
      memberVote: 'Aye',
      valence: 'voted-pro',
      isObstruction: false,
    },
    procedural: [],
  };

  it('each <td> has a data-label attribute (except the bill-cell heading)', () => {
    render(<VoteList clusters={[row]} />);
    // Leading cell is semantically the header; spec says its data-label is
    // present on the element but hidden via CSS ::before. The other three
    // must carry a visible label.
    const dateCell = screen.getByText(/Feb 13, 2024/).closest('td');
    expect(dateCell?.getAttribute('data-label')).toBe('Date');

    const positionCell = screen.getByText('Aye').closest('td');
    expect(positionCell?.getAttribute('data-label')).toBe('Position');

    const outcomeCell = screen.getByText(/Became law/).closest('td');
    expect(outcomeCell?.getAttribute('data-label')).toBe('Outcome');
  });

  it('leading bill-cell carries data-label="Bill & Vote" (hidden by CSS, but present in DOM)', () => {
    const { container } = render(<VoteList clusters={[row]} />);
    const billCell = container.querySelector('.viw-votelist-bill');
    expect(billCell?.getAttribute('data-label')).toBe('Bill & Vote');
  });
});

describe('AC-34.4 — BillList cells carry data-label for stacked-card layout', () => {
  const bill: UkraineBill = {
    number: 'H.R. 7691',
    title: 'Additional Ukraine Supplemental Appropriations Act, 2022',
    dateIntroduced: '2022-05-10',
    latestAction: 'Became Public Law No: 117-128.',
    congressGovUrl: 'https://congress.gov/bill/117/hr/7691',
    relationship: 'sponsored',
    featured: true,
    direction: 'pro-ukraine',
    valence: 'sponsor-pro',
    summary: null,
    curated: {
      congress: 117,
      type: 'HR',
      number: '7691',
      direction: 'pro-ukraine',
      featured: true,
      title: 'Additional Ukraine Supplemental Appropriations Act, 2022',
      label: 'Ukraine supplemental',
      becameLaw: true,
      congressGovUrl: 'https://congress.gov/bill/117/hr/7691',
      summary: null,
    },
  };

  it('each <td> has a data-label attribute', () => {
    const { container } = render(<BillList sponsored={[bill]} cosponsored={[]} />);
    const cells = container.querySelectorAll('tbody tr:first-child td');
    // Expect four cells, each with a data-label.
    expect(cells).toHaveLength(4);
    expect(cells[0]?.getAttribute('data-label')).toBe('Bill');
    expect(cells[1]?.getAttribute('data-label')).toBe('Title');
    expect(cells[2]?.getAttribute('data-label')).toBe('Introduced');
    expect(cells[3]?.getAttribute('data-label')).toBe('Latest Action');
  });
});

describe('AC-34.3/4/5/6 — CSS contains the 640px-and-below stacked-card block', () => {
  it('includes @media (max-width: 640px)', () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*640px\)/);
  });

  it('hides <thead> on narrow viewports (AC-34.3/4)', () => {
    // Rough grep — the full CSS parser is overkill for this invariant.
    expect(css).toMatch(/\.viw-votelist\s+thead[\s\S]*?display:\s*none/);
  });

  it('renders ::before labels from data-label attributes (AC-34.3/4)', () => {
    expect(css).toMatch(/td\[data-label\]::before\s*\{[\s\S]*?content:\s*attr\(data-label\)/);
  });

  it('uses top-only borders for stacked rows (AC-34.5, no nested card look)', () => {
    // The @media block's tr rule should set `border-top` (not the full
    // `border: 2px solid`). Grab the @media block and grep within it.
    const mobileBlock = css.match(
      /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\n\}/,
    )?.[0];
    expect(mobileBlock).toBeDefined();
    expect(mobileBlock).toMatch(/\btr[\s\S]*?border-top:\s*2px/);
    // And must NOT set a full border on rows in the mobile block.
    expect(mobileBlock).not.toMatch(/\btr\s*\{[\s\S]*?\bborder:\s*2px\s+solid/);
  });

  it('disables the horizontal-scroll gutter on mobile (AC-34.6)', () => {
    const mobileBlock = css.match(
      /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\n\}/,
    )?.[0];
    expect(mobileBlock).toMatch(/\.viw-votelist-scroll\s*\{\s*overflow-x:\s*visible/);
  });
});

describe('AC-34.1/2 — address form mobile block (520px breakpoint)', () => {
  it('includes @media (max-width: 520px)', () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*520px\)/);
  });

  it('stacks input and button full-width on narrow viewport', () => {
    // Grab the 520px block.
    const mobileBlock = css.match(
      /@media\s*\(max-width:\s*520px\)\s*\{[\s\S]*?\n\}/,
    )?.[0];
    expect(mobileBlock).toBeDefined();
    expect(mobileBlock).toMatch(/\.viw-address-input[\s\S]*?flex-basis:\s*100%/);
    expect(mobileBlock).toMatch(/\.viw-address-submit[\s\S]*?flex-basis:\s*100%/);
    expect(mobileBlock).toMatch(/\.viw-address-submit[\s\S]*?border-top-width:\s*0/);
  });

  it('pins input font-size to 16px at all viewports (iOS no-zoom guard, AC-34.1)', () => {
    // The base rule (outside the @media block) must already set 16px, so an
    // iOS user on a 500px viewport hitting the stacked layout is NOT
    // auto-zoomed on focus.
    expect(css).toMatch(/\.viw-address-input\s*\{[\s\S]*?font-size:\s*16px/);
  });

  it('blocks the label hint on narrow viewports (AC-34.2)', () => {
    const mobileBlock = css.match(
      /@media\s*\(max-width:\s*520px\)\s*\{[\s\S]*?\n\}/,
    )?.[0];
    expect(mobileBlock).toMatch(
      /\.viw-address-label-hint[\s\S]*?display:\s*block/,
    );
  });
});
