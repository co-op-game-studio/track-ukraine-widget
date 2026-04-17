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
});
