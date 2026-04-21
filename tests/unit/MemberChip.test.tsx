/**
 * MemberChip — compact circle-photo + name chip used in the overview grid.
 * Traces to: US-7 (revised v2.2.0) AC-7.1.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemberChip } from '../../src/components/MemberChip';
import type { Representative } from '../../src/types/domain';

const senator: Representative = {
  bioguideId: 'D000563',
  name: 'Durbin, Richard J.',
  party: 'Democratic',
  partyAbbreviation: 'D',
  state: 'IL',
  district: null,
  chamber: 'senate',
  photoUrl: 'https://example.com/d.jpg',
  isNonVoting: false,
  officialWebsiteUrl: null,
};

describe('MemberChip', () => {
  it('renders photo, name, and a party tag', () => {
    render(<MemberChip representative={senator} selected={false} onClick={() => {}} />);
    expect(screen.getByAltText(/Durbin/)).toBeInTheDocument();
    expect(screen.getByText(/Durbin/i)).toBeInTheDocument();
    expect(screen.getByText(/DEMOCRATIC/i)).toBeInTheDocument();
  });

  it('fires onClick with the member bioguideId when clicked', () => {
    const onClick = vi.fn();
    render(<MemberChip representative={senator} selected={false} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('shows selected state when selected=true', () => {
    const { rerender } = render(
      <MemberChip representative={senator} selected={false} onClick={() => {}} />,
    );
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('false');
    rerender(<MemberChip representative={senator} selected={true} onClick={() => {}} />);
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true');
  });

  it('renders a placeholder when no photoUrl', () => {
    const noPhoto = { ...senator, photoUrl: null };
    const { container } = render(
      <MemberChip representative={noPhoto} selected={false} onClick={() => {}} />,
    );
    expect(container.querySelector('.viw-chip-photo-placeholder')).not.toBeNull();
  });

  it('renders "District N" subtitle for house reps, "U.S. Senator" for senators', () => {
    render(<MemberChip representative={senator} selected={false} onClick={() => {}} />);
    expect(screen.getByText(/U\.S\. Senator/i)).toBeInTheDocument();

    const houseRep: Representative = { ...senator, chamber: 'house', district: 7 };
    const { rerender } = render(<MemberChip representative={houseRep} selected={false} onClick={() => {}} />);
    rerender(<MemberChip representative={houseRep} selected={false} onClick={() => {}} />);
    expect(screen.getByText(/District 7/)).toBeInTheDocument();
  });

  // AC-31.4 (REVISED v2.5.2) — when a House rep has null district (e.g., a
  // name-search result constructed from a shard that predates the district
  // field, or any edge case where district is unknown), the chip SHALL
  // render "U.S. Representative" — NEVER "District null".
  it('AC-31.4 — renders "U.S. Representative" for house rep with null district (no "District null" literal)', () => {
    const houseNoDistrict: Representative = {
      ...senator,
      chamber: 'house',
      district: null,
    };
    const { container } = render(
      <MemberChip representative={houseNoDistrict} selected={false} onClick={() => {}} />,
    );
    expect(screen.getByText(/U\.S\. Representative/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/District\s+null/i);
    expect(container.textContent).not.toMatch(/District\s+undefined/i);
  });

  // AC-31.4 — non-voting delegates (e.g., DC, PR, territories) render their
  // own subtitle, independent of district.
  it('AC-31.4 — renders "Delegate (non-voting)" for isNonVoting house rep', () => {
    const delegate: Representative = {
      ...senator,
      chamber: 'house',
      district: 0,
      isNonVoting: true,
    };
    render(<MemberChip representative={delegate} selected={false} onClick={() => {}} />);
    expect(screen.getByText(/Delegate \(non-voting\)/)).toBeInTheDocument();
  });

  // AC-7.8 (NEW UAT): every chip surfaces the member's full state name on
  // its own line so senator chips aren't state-ambiguous in search results.
  it('AC-7.8 — chip renders the full state name on its own line', () => {
    const { container } = render(
      <MemberChip representative={senator} selected={false} onClick={() => {}} />,
    );
    const stateLine = container.querySelector('.viw-chip-state');
    expect(stateLine).not.toBeNull();
    expect(stateLine?.textContent).toMatch(/Illinois/i);
  });

  it('AC-7.8 — falls back to the 2-letter code when state name is unknown', () => {
    const bogus: Representative = { ...senator, state: 'ZZ' };
    const { container } = render(
      <MemberChip representative={bogus} selected={false} onClick={() => {}} />,
    );
    expect(container.querySelector('.viw-chip-state')?.textContent).toBe('ZZ');
  });

  // Year-entered office — shown on its own row (.viw-chip-since), not
  // appended to the subtitle. Cleaner layout when the chip is narrow.
  it('UAT — chip renders "Since YYYY" on its own row when yearEntered is set', () => {
    const withYear: Representative = { ...senator, yearEntered: 2011 };
    const { container } = render(
      <MemberChip representative={withYear} selected={false} onClick={() => {}} />,
    );
    // Subtitle stays bare — no inline "since" suffix.
    expect(container.querySelector('.viw-chip-subtitle')?.textContent).toBe('U.S. Senator');
    // Dedicated "since YYYY" row.
    expect(container.querySelector('.viw-chip-since')?.textContent).toMatch(/Since 2011/);
  });

  it('UAT — house rep chip shows district in subtitle and since-year in its own row', () => {
    const rep: Representative = { ...senator, chamber: 'house', district: 3, yearEntered: 2023 };
    const { container } = render(<MemberChip representative={rep} selected={false} onClick={() => {}} />);
    expect(container.querySelector('.viw-chip-subtitle')?.textContent).toBe('District 3');
    expect(container.querySelector('.viw-chip-since')?.textContent).toMatch(/Since 2023/);
  });

  it('UAT — omits the since-row entirely when yearEntered is undefined (older KV records)', () => {
    const { container } = render(
      <MemberChip representative={senator} selected={false} onClick={() => {}} />,
    );
    expect(container.querySelector('.viw-chip-subtitle')?.textContent).toBe('U.S. Senator');
    expect(container.querySelector('.viw-chip-since')).toBeNull();
  });
});
