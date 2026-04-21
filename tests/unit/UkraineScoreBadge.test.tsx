/**
 * UkraineScoreBadge — red→yellow→green score presentation.
 * Traces to: FR-16, FR-23, FR-43.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UkraineScoreBadge } from '../../src/components/UkraineScoreBadge';
import type { UkraineScore } from '../../src/services/ukraineScore';
import type { VotingRecordData, MemberVoteRow } from '../../src/hooks/useVotingRecord';
import type { SponsoredBillsData, UkraineBill } from '../../src/hooks/useSponsoredBills';

function score(value: number | null, total = 10, contributing = 10, lowConfidence = false): UkraineScore {
  const confidence = Math.min(1, contributing / 8);
  const confidenceTier: UkraineScore['confidenceTier'] =
    contributing < 3 ? 'low' : contributing < 8 ? 'moderate' : 'full';
  return { score: value, total, contributing, lowConfidence, confidence, confidenceTier };
}

describe('UkraineScoreBadge', () => {
  it('renders a visibly-live loading state when loading=true (FR-43 UAT: skeleton + label)', () => {
    const { container } = render(<UkraineScoreBadge score={null} loading />);
    const root = container.querySelector('.viw-score-loading') as HTMLElement;
    expect(root).not.toBeNull();
    // Unambiguously "working": aria-busy, visible "Loading…" label,
    // animated skeleton block + shimmer bar. Replaces the old static "…".
    expect(root.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('.viw-score-loading-label')?.textContent).toMatch(/Loading/i);
    expect(container.querySelector('.viw-score-value-skeleton')).not.toBeNull();
    expect(container.querySelector('.viw-score-bar-track-loading')).not.toBeNull();
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
        // The label now lives in its own span, stacked above the justification.
        const labelEl = container.querySelector('.viw-score-label');
        expect(labelEl?.textContent).toBe(label);
        expect(screen.getByText(display)).toBeInTheDocument();
      });
    }
  });

  it('low-confidence scores SHALL render "Limited record" variants regardless of magnitude', () => {
    const { container, rerender } = render(<UkraineScoreBadge score={score(0.95, 2, 2, true)} />);
    expect(container.querySelector('.viw-score-label')?.textContent)
      .toMatch(/Limited record — leans supportive/i);

    rerender(<UkraineScoreBadge score={score(-0.9, 2, 2, true)} />);
    expect(container.querySelector('.viw-score-label')?.textContent)
      .toMatch(/Limited record — leans opposed/i);

    rerender(<UkraineScoreBadge score={score(0.05, 2, 2, true)} />);
    expect(container.querySelector('.viw-score-label')?.textContent).toBe('Limited record');
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
    const { container } = render(<UkraineScoreBadge score={score(0.5, 10, 7)} />);
    const full = container.querySelector('.viw-justification-full')!;
    expect(full.textContent).toMatch(/Based on 7 counted actions/i);
    expect(full.textContent).toMatch(/3 excluded/i);
  });

  it('pluralizes "action" vs "actions" by contributing count', () => {
    const { container, rerender } = render(<UkraineScoreBadge score={score(0.5, 1, 1)} />);
    expect(container.querySelector('.viw-justification-full')!.textContent)
      .toMatch(/1 counted action(?!s)/i);
    rerender(<UkraineScoreBadge score={score(0.5, 2, 2)} />);
    expect(container.querySelector('.viw-justification-full')!.textContent)
      .toMatch(/2 counted actions/i);
  });

  // FR-43: data-surety visual treatment.
  describe('FR-43 data-surety visual treatment', () => {
    it('AC-43.3: applies filter: saturate(1.0) at confidence=1.0 (tier=full)', () => {
      const { container } = render(<UkraineScoreBadge score={score(0.5, 20, 20)} />);
      const value = container.querySelector('.viw-score-value') as HTMLElement;
      const filter = value.style.filter;
      expect(filter).toMatch(/saturate\(1\b/);
    });

    it('AC-43.3: applies filter: saturate(0.6) at confidence=0.5 (tier=moderate)', () => {
      const { container } = render(<UkraineScoreBadge score={score(0.5, 4, 4)} />);
      const value = container.querySelector('.viw-score-value') as HTMLElement;
      // 0.2 + 0.8 * 0.5 = 0.6
      expect(value.style.filter).toMatch(/saturate\(0\.6\b/);
    });

    it('AC-43.3: applies filter: saturate(~0.3) at low-confidence 1 action', () => {
      const { container } = render(<UkraineScoreBadge score={score(0.5, 1, 1, true)} />);
      const value = container.querySelector('.viw-score-value') as HTMLElement;
      // 0.2 + 0.8 * 0.125 = 0.3
      expect(value.style.filter).toMatch(/saturate\(0\.3\b/);
    });

    it('AC-43.3: N/A rendering does NOT apply a saturation filter (no color to modulate)', () => {
      const { container } = render(<UkraineScoreBadge score={null} />);
      const value = container.querySelector('.viw-score-value') as HTMLElement;
      expect(value?.style.filter ?? '').toBe('');
    });

    it('AC-43.4 (revised UAT): header is a single row with title · label/justification · value', () => {
      const { container } = render(<UkraineScoreBadge score={score(0.5, 15, 15)} />);
      const row = container.querySelector('.viw-score-header-row') as HTMLElement;
      expect(row).not.toBeNull();
      const title = row.querySelector('.viw-score-title');
      const stack = row.querySelector('.viw-score-context-stack');
      const value = row.querySelector('.viw-score-value');
      expect(title).not.toBeNull();
      expect(stack).not.toBeNull();
      expect(value).not.toBeNull();
      // DOM order: title → stack → value.
      expect(title!.compareDocumentPosition(stack!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(stack!.compareDocumentPosition(value!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // Stack holds label + justification as siblings.
      expect(stack!.querySelector('.viw-score-label')).not.toBeNull();
      expect(stack!.querySelector('.viw-score-justification')).not.toBeNull();
    });

    it('AC-43.5: title carries the enlarged-size class viw-score-title-lg', () => {
      const { container } = render(<UkraineScoreBadge score={score(0.5, 15, 15)} />);
      const title = container.querySelector('.viw-score-title') as HTMLElement;
      expect(title?.classList.contains('viw-score-title-lg')).toBe(true);
    });

    it('AC-43.7: "Limited record" copy still shows at tier=low (moderate+ uses normal labels)', () => {
      const { rerender, container } = render(<UkraineScoreBadge score={score(0.9, 2, 2, true)} />);
      expect(container.querySelector('.viw-score-label')?.textContent)
        .toMatch(/Limited record/);
      // 4 contributing → moderate tier → normal label again.
      rerender(<UkraineScoreBadge score={score(0.5, 4, 4)} />);
      expect(container.querySelector('.viw-score-label')?.textContent).toBe('Supporter');
    });
  });

  // FR-43 UAT additions: click-to-expand breakdown panel.
  describe('FR-43 UAT: breakdown panel', () => {
    function makeVoting(flat: MemberVoteRow[]): VotingRecordData {
      return {
        clusters: [],
        flat,
        voteScore: score(0.5),
        obstructionCount: 0,
        primaryAbstentionCount: 0,
      };
    }
    function makeVoteRow(valence: MemberVoteRow['valence'], weight: number, memberVote: MemberVoteRow['memberVote'], label: string): MemberVoteRow {
      return {
        bill: { congress: 118, type: 'HR', number: '815', featured: true, label, title: label, latestAction: null, latestActionDate: null, becameLaw: true, congressGovUrl: 'x', direction: 'pro-ukraine', directionReason: '', summary: null, votes: [] } as MemberVoteRow['bill'],
        vote: { chamber: 'Senate', congress: 118, session: 2, rollCall: 1, date: '2024-02-13', url: 'x', action: 'passage', actionDate: '2024-02-13', weight, directionMultiplier: 1, kind: 'passage' } as MemberVoteRow['vote'],
        memberVote,
        valence,
        isObstruction: false,
      };
    }
    function makeBill(valence: UkraineBill['valence'], relationship: 'sponsored' | 'cosponsored', number: string): UkraineBill {
      return {
        number, title: 'Test bill', dateIntroduced: '2024-01-01', latestAction: '',
        congressGovUrl: '', relationship, featured: false,
        direction: 'pro-ukraine', valence,
        summary: null,
        curated: {} as UkraineBill['curated'],
      };
    }

    it('is collapsed by default; clicking the title header expands it', () => {
      const { container } = render(<UkraineScoreBadge score={score(0.5, 10, 10)} />);
      const toggle = container.querySelector('.viw-score-header-toggle') as HTMLButtonElement;
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(container.querySelector('#viw-score-breakdown-panel')).toBeNull();
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(container.querySelector('#viw-score-breakdown-panel')).not.toBeNull();
    });

    it('the bar+obstruction region is ALSO a toggle (AC-43.11)', () => {
      const { container } = render(<UkraineScoreBadge score={score(0.5, 10, 10)} />);
      const bar = container.querySelector('.viw-score-bar-toggle') as HTMLButtonElement;
      expect(bar).not.toBeNull();
      expect(bar.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(bar);
      expect(bar.getAttribute('aria-expanded')).toBe('true');
      expect(container.querySelector('#viw-score-breakdown-panel')).not.toBeNull();
    });

    it('breakdown renders one row per contributing action with sign · amp×weight · contribution', () => {
      const voting = makeVoting([
        makeVoteRow('voted-pro', 1.0, 'Aye', 'HR 815 passage'),
        makeVoteRow('voted-anti', 0.45, 'Nay', 'Cloture on pro-UA bill'),
      ]);
      const bills: SponsoredBillsData = {
        sponsored: [makeBill('sponsor-pro', 'sponsored', 'S. 1')],
        cosponsored: [],
      };
      const { container } = render(
        <UkraineScoreBadge score={score(0.4, 3, 3)} voting={voting} bills={bills} />,
      );
      fireEvent.click(container.querySelector('.viw-score-header-toggle')!);
      const rows = container.querySelectorAll('.viw-score-breakdown-table tbody tr');
      expect(rows.length).toBe(3);
      // Sponsored first (rowsFromBills comes before rowsFromVoting).
      expect(rows[0]!.querySelector('.viw-score-row-bill-slug')?.textContent).toBe('S. 1');
      expect(rows[0]!.classList.contains('viw-valence-sponsor-pro')).toBe(true);
      expect(rows[1]!.classList.contains('viw-valence-voted-pro')).toBe(true);
      expect(rows[2]!.classList.contains('viw-valence-voted-anti')).toBe(true);
    });

    it('breakdown marks skipped rows (unstated/procedural) with viw-score-row-skipped (AC-43.12)', () => {
      const voting = makeVoting([
        makeVoteRow('unstated', 1.0, 'Not Voting', 'Skipped vote'),
        makeVoteRow('voted-pro', 0, 'Aye', 'Ambiguous procedural'),
      ]);
      const { container } = render(
        <UkraineScoreBadge score={score(null, 2, 0)} voting={voting} bills={null} />,
      );
      fireEvent.click(container.querySelector('.viw-score-header-toggle')!);
      const skipped = container.querySelectorAll('.viw-score-row-skipped');
      expect(skipped.length).toBe(2);
    });

    it('breakdown footer shows Σ and final score matching the badge value', () => {
      const voting = makeVoting([
        makeVoteRow('voted-pro', 1.0, 'Aye', 'A'),
        makeVoteRow('voted-pro', 0.5, 'Aye', 'B'),
      ]);
      const { container } = render(
        <UkraineScoreBadge score={score(1.0, 2, 2)} voting={voting} bills={null} />,
      );
      fireEvent.click(container.querySelector('.viw-score-header-toggle')!);
      const foot = container.querySelector('.viw-score-breakdown-table tfoot')!;
      expect(foot.textContent).toMatch(/1\.50/); // Σ mag = 1.0 + 0.5
      expect(foot.textContent).toMatch(/\+1\.00/); // final score
    });

    // AC-43.15 — clicking anywhere on the grey score band (or the white
    // breakdown panel whitespace) toggles the panel. Interactive children
    // — header button, bar toggle, per-row expand — keep their own clicks.
    it('AC-43.15 — clicking grey background toggles the breakdown; clicks on descendants do not', () => {
      const voting = makeVoting([
        makeVoteRow('voted-pro', 1.0, 'Aye', 'A'),
      ]);
      const { container } = render(
        <UkraineScoreBadge score={score(1.0, 1, 1)} voting={voting} bills={null} />,
      );
      const header = container.querySelector('.viw-score-header-toggle') as HTMLButtonElement;
      const scoreBand = container.querySelector('.viw-score') as HTMLDivElement;

      // 1. Starts collapsed; clicking the grey band directly (target ===
      //    scoreBand) SHALL open it.
      expect(header.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(scoreBand);
      expect(header.getAttribute('aria-expanded')).toBe('true');

      // 2. While expanded, clicking inside the white panel's whitespace
      //    (non-interactive child) SHALL close it.
      const intro = container.querySelector('.viw-score-breakdown-intro') as HTMLElement;
      fireEvent.click(intro);
      expect(header.getAttribute('aria-expanded')).toBe('false');

      // 3. Re-open via header button; clicking a <tfoot> non-interactive
      //    child SHALL close the panel.
      fireEvent.click(header);
      expect(header.getAttribute('aria-expanded')).toBe('true');
      const tfoot = container.querySelector('.viw-score-breakdown-table tfoot') as HTMLElement;
      fireEvent.click(tfoot);
      expect(header.getAttribute('aria-expanded')).toBe('false');
    });
  });

  // FR-43 UAT (post-feedback): structured Bill · Action cell + truncate-on-click.
  describe('FR-43 UAT: structured bill cell + row-level expand', () => {
    function makeVoting(flat: MemberVoteRow[]): VotingRecordData {
      return {
        clusters: [],
        flat,
        voteScore: score(0.5),
        obstructionCount: 0,
        primaryAbstentionCount: 0,
      };
    }
    function makeLongVoteRow(): MemberVoteRow {
      return {
        bill: {
          congress: 118, type: 'HR', number: '815',
          featured: true, label: 'A descriptive bill label that does not itself exceed the cap',
          title: 'T', latestAction: null, latestActionDate: null, becameLaw: true,
          congressGovUrl: '', direction: 'pro-ukraine', directionReason: '',
          summary: null, votes: [],
        } as MemberVoteRow['bill'],
        vote: {
          chamber: 'Senate', congress: 118, session: 2, rollCall: 1,
          date: '2024-02-13', url: '',
          // Long clerk-action text so the row has expandable detail.
          action: 'Senate agreed to the House amendment to the Senate amendment to H.R. 815 by Yea-Nay Vote. 79 - 18. Record Vote Number: 154. A very long sentence that easily exceeds the truncate cap of the expand toggle.',
          actionDate: '2024-02-13',
          weight: 1.0, directionMultiplier: 1, kind: 'cloture',
        } as MemberVoteRow['vote'],
        memberVote: 'Aye',
        valence: 'voted-pro',
        isObstruction: false,
      };
    }

    it('renders the structured slug · description · action caption', () => {
      const voting = makeVoting([makeLongVoteRow()]);
      const { container } = render(
        <UkraineScoreBadge score={score(1, 1, 1)} voting={voting} bills={null} />,
      );
      fireEvent.click(container.querySelector('.viw-score-header-toggle')!);
      const row = container.querySelector('.viw-score-breakdown-table tbody tr')!;
      expect(row.querySelector('.viw-score-row-bill-slug')?.textContent).toBe('HR 815');
      expect(row.querySelector('.viw-score-row-bill-desc')?.textContent)
        .toMatch(/A descriptive bill label/);
      // Vote kind 'cloture' → "Cloture — Voted Aye" caption.
      expect(row.querySelector('.viw-score-row-bill-action')?.textContent)
        .toBe('Cloture — Voted Aye');
    });

    it('AC-43.14 — rows with long action detail render as a toggle button, collapsed by default', () => {
      const voting = makeVoting([makeLongVoteRow()]);
      const { container } = render(
        <UkraineScoreBadge score={score(1, 1, 1)} voting={voting} bills={null} />,
      );
      fireEvent.click(container.querySelector('.viw-score-header-toggle')!);
      const row = container.querySelector('.viw-score-breakdown-table tbody tr')!;
      const toggle = row.querySelector('.viw-score-row-bill-toggle') as HTMLButtonElement;
      expect(toggle).not.toBeNull();
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      // Action detail hidden until expand.
      expect(row.querySelector('.viw-score-row-bill-detail')).toBeNull();

      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      const detail = row.querySelector('.viw-score-row-bill-detail');
      expect(detail).not.toBeNull();
      expect(detail!.textContent).toMatch(/Record Vote Number: 154/);
    });

    it('AC-43.14 — short-description, short-detail rows render as a static cell (no toggle button)', () => {
      const bills: SponsoredBillsData = {
        sponsored: [{
          number: 'S. 99', title: 'Short bill', dateIntroduced: '2024-01-01',
          latestAction: '', congressGovUrl: '', relationship: 'sponsored',
          featured: false, direction: 'pro-ukraine', valence: 'sponsor-pro',
          summary: null, curated: {} as UkraineBill['curated'],
        }],
        cosponsored: [],
      };
      const { container } = render(
        <UkraineScoreBadge score={score(1, 1, 1)} voting={null} bills={bills} />,
      );
      fireEvent.click(container.querySelector('.viw-score-header-toggle')!);
      const row = container.querySelector('.viw-score-breakdown-table tbody tr')!;
      // No toggle button: the slug/desc/action render directly.
      expect(row.querySelector('.viw-score-row-bill-toggle')).toBeNull();
      expect(row.querySelector('.viw-score-row-bill-slug')?.textContent).toBe('S. 99');
    });
  });

  // FR-43 UAT: short/full text variants for narrow viewports.
  describe('FR-43 UAT: responsive text variants', () => {
    it('renders both the full and the short justification spans (CSS swaps them)', () => {
      const { container } = render(<UkraineScoreBadge score={score(0.5, 16, 16)} />);
      const full = container.querySelector('.viw-justification-full');
      const short = container.querySelector('.viw-justification-short');
      expect(full?.textContent).toMatch(/Based on 16 counted actions/i);
      expect(short?.textContent).toMatch(/^16 actions/);
    });

    it('renders both the full and the short title spans', () => {
      const { container } = render(<UkraineScoreBadge score={score(0.5, 10, 10)} />);
      expect(container.querySelector('.viw-title-full')?.textContent).toBe('Ukraine Support Score');
      expect(container.querySelector('.viw-title-short')?.textContent).toBe('Score');
    });
  });
});
