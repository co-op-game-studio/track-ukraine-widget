/**
 * StatementsList — embed-side merged feed of social posts + quotes.
 *
 * Traces:
 *   AC-52.43 — embed reads weight + direction (NOT scoreAdjustment); chip
 *              displays the composed contribution = direction × weight.
 *   AC-53.2  — Statements tab merges posts + quotes chronologically.
 *   AC-53.6  — quote-vs-post visual treatment + source link.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatementsList } from '../../src/components/StatementsList';
import type { SocialPost } from '../../src/hooks/useRepStatements';
import type { RepQuote } from '../../src/hooks/useRepQuotes';

const POST_PRO: SocialPost = {
  id: 'p1',
  platform: 'x',
  url: 'https://x.com/SenatorDurbin/status/123',
  postedAt: '2026-04-28T12:00:00Z',
  bodyText: 'Stand with Ukraine.',
  weight: 2,
  direction: 1,
  comment: null,
  authorEmail: 'alice@example.com',
  createdAt: '2026-05-02T00:00:00Z',
};

const POST_ANTI: SocialPost = {
  id: 'p2',
  platform: 'youtube',
  url: 'https://youtube.com/watch?v=xyz',
  postedAt: '2026-04-29T12:00:00Z',
  bodyText: 'Why we should stop sending aid.',
  weight: 4,
  direction: -1,
  comment: 'Picked up from town hall livestream.',
  authorEmail: 'alice@example.com',
  createdAt: '2026-05-02T00:00:00Z',
};

const QUOTE_PRO: RepQuote = {
  id: 'q1',
  mediaKind: 'video',
  sourceUrl: 'https://www.c-span.org/video/?123',
  sourceLabel: 'C-SPAN floor speech, 2024-02-13',
  quotedAt: '2024-02-13T15:00:00Z',
  bodyText: 'I support Ukraine.',
  weight: 1,
  direction: 1,
  comment: null,
  authorEmail: 'alice@example.com',
  createdAt: '2026-05-02T00:00:00Z',
};

const QUOTE_NEUTRAL: RepQuote = {
  id: 'q2',
  mediaKind: 'text',
  sourceUrl: 'https://example.com/op-ed',
  sourceLabel: null,
  quotedAt: '2024-03-01T00:00:00Z',
  bodyText: 'I have not yet made a decision.',
  weight: 0,
  direction: 0,
  comment: null,
  authorEmail: 'alice@example.com',
  createdAt: '2026-05-02T00:00:00Z',
};

describe('StatementsList — empty + loading states', () => {
  it('renders loading message when posts + quotes empty AND loading flag set', () => {
    render(<StatementsList posts={[]} quotes={[]} loading />);
    expect(screen.getByText(/Loading statements/i)).toBeInTheDocument();
  });

  it('renders empty-state copy when no posts/quotes and not loading', () => {
    render(<StatementsList posts={[]} quotes={[]} />);
    expect(
      screen.getByText(/No researcher-curated statements for this member yet/i),
    ).toBeInTheDocument();
  });
});

describe('StatementsList — chronology + merge (AC-53.2)', () => {
  it('merges posts + quotes into one list, newest first', () => {
    render(<StatementsList posts={[POST_PRO]} quotes={[QUOTE_PRO]} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // The post (postedAt 2026-04-28) is newer than the quote (2024-02-13).
    // First item should be the post.
    expect(items[0]!.textContent).toMatch(/Stand with Ukraine/);
    expect(items[1]!.textContent).toMatch(/I support Ukraine/);
  });

  it('renders quotes in <blockquote>; posts in <div>', () => {
    render(<StatementsList posts={[POST_PRO]} quotes={[QUOTE_PRO]} />);
    expect(document.querySelector('blockquote')?.textContent).toMatch(/"I support Ukraine\."/);
    // Post body NOT inside a blockquote.
    expect(document.querySelectorAll('blockquote')).toHaveLength(1);
  });

  it('renders source link with sourceLabel when present', () => {
    render(<StatementsList posts={[]} quotes={[QUOTE_PRO]} />);
    const link = screen.getByRole('link', { name: /C-SPAN floor speech/i });
    expect(link).toHaveAttribute('href', 'https://www.c-span.org/video/?123');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
  });

  it('falls back to "View source" link text when no sourceLabel', () => {
    render(<StatementsList posts={[POST_PRO]} quotes={[]} />);
    expect(screen.getByRole('link', { name: /View source/i })).toBeInTheDocument();
  });
});

describe('StatementsList — contribution chip (AC-52.43 + AC-53.3)', () => {
  it('renders the contribution chip with the COMPOSED value (weight × direction)', () => {
    render(<StatementsList posts={[POST_PRO]} quotes={[]} />);
    // POST_PRO: weight 2, direction +1 → contribution +2
    // ScoreAdjustmentChip is the rendering target; we just assert "2" appears
    // in the meta row near the source.
    const item = screen.getByRole('listitem');
    expect(item.textContent).toMatch(/\+?2/);
  });

  it('shows negative contribution for anti-leaning posts', () => {
    render(<StatementsList posts={[POST_ANTI]} quotes={[]} />);
    const item = screen.getByRole('listitem');
    // POST_ANTI: weight 4, direction -1 → contribution -4
    expect(item.textContent).toMatch(/-4/);
  });

  it('OMITS the chip when contribution = 0 (no signal worth surfacing)', () => {
    // QUOTE_NEUTRAL: weight 0, direction 0 → contribution 0.
    render(<StatementsList posts={[]} quotes={[QUOTE_NEUTRAL]} />);
    const item = screen.getByRole('listitem');
    // The chip uses a specific class — assert no chip rendered.
    expect(item.querySelector('.viw-score-adj-chip')).toBeNull();
  });
});

describe('StatementsList — researcher note (AC-53.3)', () => {
  it('renders researcher comment block when set', () => {
    render(<StatementsList posts={[POST_ANTI]} quotes={[]} />);
    expect(screen.getByText(/Researcher note:/i)).toBeInTheDocument();
    expect(screen.getByText(/Picked up from town hall livestream/i)).toBeInTheDocument();
  });

  it('omits the researcher note block when comment is null', () => {
    render(<StatementsList posts={[POST_PRO]} quotes={[]} />);
    expect(screen.queryByText(/Researcher note:/i)).toBeNull();
  });
});
