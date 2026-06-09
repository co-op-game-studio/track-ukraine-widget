/**
 * Tests for src/components/CommentExpand.tsx.
 *
 * Presentational; covers:
 *   - empty array → renders nothing
 *   - collapsed by default; click toggles open / closed
 *   - count + plural noun (1 vs N)
 *   - relative date formatter (just now / Nm / Nh / Nd / fallback)
 *   - ScoreAdjustmentChip pos/neg sign + label
 *   - chip omitted when direction === 0 OR weight === 0
 *
 * Traces to FR-53 AC-53.1, AC-53.3, AC-52.43.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommentExpand, ScoreAdjustmentChip } from '../../src/components/CommentExpand';
import type { ResearcherComment } from '../../src/hooks/useRepComments';

function comment(overrides: Partial<ResearcherComment> = {}): ResearcherComment {
  return {
    id: overrides.id ?? 'c1',
    bodyMarkdown: overrides.bodyMarkdown ?? 'comment body',
    weight: overrides.weight ?? 0.5,
    direction: overrides.direction ?? 1,
    attachedToRollCallId: overrides.attachedToRollCallId ?? null,
    authorEmail: overrides.authorEmail ?? 'alice@example.com',
    createdAt: overrides.createdAt ?? new Date(Date.now() - 5 * 60_000).toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  };
}

describe('CommentExpand', () => {
  it('renders nothing when comments is empty', () => {
    const { container } = render(<CommentExpand comments={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders collapsed by default with singular noun for count=1', () => {
    render(<CommentExpand comments={[comment()]} />);
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn.textContent).toContain('▸ Show');
    expect(btn.textContent).toContain('1 detail');
    expect(btn.textContent).not.toContain('details');
  });

  it('uses plural noun for count > 1', () => {
    render(<CommentExpand comments={[comment(), comment({ id: 'c2' })]} />);
    expect(screen.getByRole('button').textContent).toContain('2 details');
  });

  it('clicking the toggle expands and collapses the list', () => {
    render(<CommentExpand comments={[comment({ bodyMarkdown: 'first body' })]} />);
    const btn = screen.getByRole('button');
    expect(screen.queryByRole('list')).toBeNull();
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(btn.textContent).toContain('▾ Hide');
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getByText('first body')).toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('renders the local-part of authorEmail (not the full address)', () => {
    render(<CommentExpand comments={[comment({ authorEmail: 'bob@coop.example' })]} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.queryByText('bob@coop.example')).toBeNull();
  });

  it('omits ScoreAdjustmentChip when direction === 0', () => {
    render(<CommentExpand comments={[comment({ direction: 0, weight: 1 })]} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByTitle(/Researcher score adjustment/)).toBeNull();
  });

  it('omits ScoreAdjustmentChip when weight === 0', () => {
    render(<CommentExpand comments={[comment({ direction: 1, weight: 0 })]} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByTitle(/Researcher score adjustment/)).toBeNull();
  });

  it('renders ScoreAdjustmentChip when direction × weight is non-zero', () => {
    render(<CommentExpand comments={[comment({ direction: 1, weight: 0.5 })]} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTitle(/Researcher score adjustment: \+0.50/)).toBeInTheDocument();
  });

  describe('relative-date formatting', () => {
    it('"just now" when < 1 minute', () => {
      render(<CommentExpand comments={[comment({ createdAt: new Date().toISOString() })]} />);
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText('just now')).toBeInTheDocument();
    });

    it('Nm ago when < 1 hour', () => {
      const iso = new Date(Date.now() - 12 * 60_000).toISOString();
      render(<CommentExpand comments={[comment({ createdAt: iso })]} />);
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText('12m ago')).toBeInTheDocument();
    });

    it('Nh ago when < 24 hours', () => {
      const iso = new Date(Date.now() - 5 * 60 * 60_000).toISOString();
      render(<CommentExpand comments={[comment({ createdAt: iso })]} />);
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText('5h ago')).toBeInTheDocument();
    });

    it('Nd ago when < 7 days', () => {
      const iso = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
      render(<CommentExpand comments={[comment({ createdAt: iso })]} />);
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText('3d ago')).toBeInTheDocument();
    });

    it('falls back to YYYY-MM-DD when ≥ 7 days', () => {
      const iso = '2025-01-15T12:00:00.000Z';
      render(<CommentExpand comments={[comment({ createdAt: iso })]} />);
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText('2025-01-15')).toBeInTheDocument();
    });

    it('returns the raw input on unparseable date', () => {
      const iso = 'not-a-real-date';
      render(<CommentExpand comments={[comment({ createdAt: iso })]} />);
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText('not-a-real-date')).toBeInTheDocument();
    });
  });
});

describe('ScoreAdjustmentChip', () => {
  it('renders a positive value with leading + and 2 decimals', () => {
    render(<ScoreAdjustmentChip value={0.5} />);
    expect(screen.getByText('+0.50')).toBeInTheDocument();
    expect(screen.getByTitle('Researcher score adjustment: +0.50')).toBeInTheDocument();
  });

  it('renders a negative value with leading - and 2 decimals', () => {
    render(<ScoreAdjustmentChip value={-1.25} />);
    expect(screen.getByText('-1.25')).toBeInTheDocument();
  });

  it('uses the pos class for positive values', () => {
    const { container } = render(<ScoreAdjustmentChip value={1} />);
    expect(container.firstElementChild?.className).toContain('viw-score-adj-pos');
  });

  it('uses the neg class for negative values', () => {
    const { container } = render(<ScoreAdjustmentChip value={-1} />);
    expect(container.firstElementChild?.className).toContain('viw-score-adj-neg');
  });

  it('treats zero as negative class (off the positive branch)', () => {
    const { container } = render(<ScoreAdjustmentChip value={0} />);
    // value > 0 is false → neg class
    expect(container.firstElementChild?.className).toContain('viw-score-adj-neg');
    expect(screen.getByText('0.00')).toBeInTheDocument();
  });
});
