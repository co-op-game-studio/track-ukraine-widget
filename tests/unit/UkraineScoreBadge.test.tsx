/**
 * UkraineScoreBadge — red\u2192yellow\u2192green score presentation.
 * Traces to: FR-16, FR-23.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UkraineScoreBadge } from '../../src/components/UkraineScoreBadge';
import type { UkraineScore } from '../../src/services/ukraineScore';

function score(value: number | null, total = 10, contributing = 10, lowConfidence = false): UkraineScore {
  return { score: value, total, contributing, lowConfidence };
}

describe('UkraineScoreBadge', () => {
  it('renders a loading placeholder with \u2026 when loading=true', () => {
    const { container } = render(<UkraineScoreBadge score={null} loading />);
    expect(container.querySelector('.viw-score-loading')).not.toBeNull();
    expect(screen.getByText('\u2026')).toBeInTheDocument();
  });

  it('renders N/A with empty-state copy when score is null (not loading)', () => {
    render(<UkraineScoreBadge score={null} />);
    expect(screen.getByText('N/A')).toBeInTheDocument();
    expect(screen.getByText(/No curated Ukraine votes or sponsorships/i)).toBeInTheDocument();
  });

  it('renders N/A when score object carries value null', () => {
    render(<UkraineScoreBadge score={score(null, 0, 0)} />);
    expect(screen.getByText('N/A')).toBeInTheDocument();
  });

  describe('scoreLabel thresholds (FR-16)', () => {
    const cases: Array<[number, string, string]> = [
      [0.85, 'Strong supporter', '+0.85'],
      [0.5, 'Supporter', '+0.50'],
      [0.2, 'Leaning supportive', '+0.20'],
      [0.0, 'Mixed', '+0.00'],
      [-0.2, 'Leaning opposed', '-0.20'],
      [-0.5, 'Opposed', '-0.50'],
      [-0.85, 'Strongly opposed', '-0.85'],
    ];
    for (const [value, label, display] of cases) {
      it(`renders "${label}" at value=${value}`, () => {
        const { container } = render(<UkraineScoreBadge score={score(value)} />);
        // The label appears both in the <strong> context line AND in the
        // gradient-bar scale row. Match the <strong> specifically.
        const strong = container.querySelector('.viw-score-context strong');
        expect(strong?.textContent).toBe(label);
        expect(screen.getByText(display)).toBeInTheDocument();
      });
    }
  });

  it('low-confidence scores SHALL render "Limited record" variants regardless of magnitude', () => {
    const { rerender } = render(<UkraineScoreBadge score={score(0.95, 2, 2, true)} />);
    expect(screen.getByText(/Limited record \u2014 leans supportive/i)).toBeInTheDocument();

    rerender(<UkraineScoreBadge score={score(-0.9, 2, 2, true)} />);
    expect(screen.getByText(/Limited record \u2014 leans opposed/i)).toBeInTheDocument();

    rerender(<UkraineScoreBadge score={score(0.05, 2, 2, true)} />);
    expect(screen.getByText(/^Limited record$/i)).toBeInTheDocument();
  });

  it('renders the progressbar role with signed aria-valuenow in the [-100, +100] range', () => {
    render(<UkraineScoreBadge score={score(0.7, 12, 12)} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuemin')).toBe('-100');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(bar.getAttribute('aria-valuenow')).toBe('70');
  });

  it('FR-23: obstructionCount \u2265 2 surfaces the callout', () => {
    render(<UkraineScoreBadge score={score(0.3)} obstructionCount={3} />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(/obstruction event/i);
    expect(note).toHaveTextContent(/\b3\b/);
  });

  it('FR-23: obstructionCount < 2 hides the callout', () => {
    render(<UkraineScoreBadge score={score(0.3)} obstructionCount={1} />);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('FR-23 AC-23.5: primaryAbstentionCount below threshold (3) hides the callout', () => {
    render(<UkraineScoreBadge score={score(0.1)} primaryAbstentionCount={2} />);
    expect(screen.queryByText(/Abstained on/i)).toBeNull();
  });

  it('FR-23 AC-23.5: primaryAbstentionCount \u2265 3 surfaces the callout and pluralizes', () => {
    render(<UkraineScoreBadge score={score(0.1)} primaryAbstentionCount={3} />);
    expect(screen.getByText(/Abstained on/i)).toBeInTheDocument();
    expect(screen.getByText(/3/)).toBeInTheDocument();
    expect(screen.getByText(/primary-weight/i)).toBeInTheDocument();
  });

  it('renders the "excluded" count in context when total > contributing', () => {
    render(<UkraineScoreBadge score={score(0.5, 10, 7)} />);
    expect(screen.getByText(/Based on 7 counted actions/i)).toBeInTheDocument();
    expect(screen.getByText(/3 excluded/i)).toBeInTheDocument();
  });

  it('pluralizes "action" vs "actions" by contributing count', () => {
    const { rerender } = render(<UkraineScoreBadge score={score(0.5, 1, 1)} />);
    expect(screen.getByText(/1 counted action$/i)).toBeInTheDocument();
    rerender(<UkraineScoreBadge score={score(0.5, 2, 2)} />);
    expect(screen.getByText(/2 counted actions$/i)).toBeInTheDocument();
  });
});
