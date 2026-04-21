/**
 * AboutSystemPanel — static info surface explaining the scoring system.
 * Traces to: FR-46.
 */
import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { AboutSystemPanel } from '../../src/components/AboutSystemPanel';

describe('AboutSystemPanel (FR-46)', () => {
  it('AC-46.2 — renders a trigger button and is collapsed by default', () => {
    const { container } = render(<AboutSystemPanel />);
    const trigger = container.querySelector('.viw-about-trigger') as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    expect(trigger.textContent).toMatch(/About this system/i);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('#viw-about-panel')).toBeNull();
  });

  it('AC-46.2 — clicking the trigger opens the panel', () => {
    const { container } = render(<AboutSystemPanel />);
    const trigger = container.querySelector('.viw-about-trigger') as HTMLButtonElement;
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const panel = container.querySelector('#viw-about-panel') as HTMLDivElement;
    expect(panel).not.toBeNull();
    expect(panel.getAttribute('role')).toBe('region');
    expect(panel.getAttribute('aria-label')).toBe('About this system');
  });

  it('AC-46.5 — valence table renders all five valences in canonical order', () => {
    const { container } = render(<AboutSystemPanel />);
    fireEvent.click(container.querySelector('.viw-about-trigger')!);
    const rows = Array.from(
      container.querySelectorAll('.viw-about-table:nth-of-type(1) tbody tr'),
    );
    expect(rows.length).toBe(5);
    const expectedClasses = [
      'viw-valence-sponsor-pro',
      'viw-valence-voted-pro',
      'viw-valence-unstated',
      'viw-valence-voted-anti',
      'viw-valence-sponsor-anti',
    ];
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i]!.classList.contains(expectedClasses[i]!)).toBe(true);
    }
  });

  it('AC-46.5 — weight table calls out passage=1.00, cloture=0.45, one 0.30 row, excluded (0.00) rows', () => {
    const { container } = render(<AboutSystemPanel />);
    fireEvent.click(container.querySelector('.viw-about-trigger')!);
    // Second .viw-about-table is weights.
    const weightTable = container.querySelectorAll('.viw-about-table')[1]!;
    const bodyText = weightTable.textContent ?? '';
    expect(bodyText).toMatch(/Final passage[\s\S]*1\.00/);
    expect(bodyText).toMatch(/Cloture[\s\S]*0\.45/);
    expect(bodyText).toMatch(/0\.30/);
    const excluded = weightTable.querySelectorAll('tbody tr.viw-about-weight-excluded');
    expect(excluded.length).toBeGreaterThanOrEqual(2); // motion-to-table, motion-to-reconsider
  });

  it('AC-46.3 — bills browser renders tabs for each non-empty direction and a bills table', () => {
    const { container } = render(<AboutSystemPanel />);
    fireEvent.click(container.querySelector('.viw-about-trigger')!);
    const tabs = container.querySelectorAll('.viw-about-tab');
    // At least the Pro-Ukraine tab must be present (the curated set has pro bills).
    expect(tabs.length).toBeGreaterThanOrEqual(1);
    const tabLabels = Array.from(tabs).map((t) => t.textContent);
    expect(tabLabels.some((l) => l?.match(/Pro-Ukraine/i))).toBe(true);
    // The bills table renders in the active tab panel.
    expect(container.querySelector('.viw-about-bills-table')).not.toBeNull();
  });

  it('AC-46.6 — clicking a bill row reveals a nested votes table or "no votes" message', () => {
    const { container } = render(<AboutSystemPanel />);
    fireEvent.click(container.querySelector('.viw-about-trigger')!);
    const firstBillToggle = container.querySelector('.viw-about-bill-toggle') as HTMLButtonElement;
    expect(firstBillToggle).not.toBeNull();
    expect(firstBillToggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(firstBillToggle);
    expect(firstBillToggle.getAttribute('aria-expanded')).toBe('true');
    // Either a nested votes table or a "no votes" note SHALL render.
    const hasVotesTable = !!container.querySelector('.viw-about-votes-table');
    const hasNoVotes = !!container.querySelector('.viw-about-no-votes');
    expect(hasVotesTable || hasNoVotes).toBe(true);
  });

  it('AC-46.7 — panel text does not contain forbidden technical / security terms', () => {
    const { container } = render(<AboutSystemPanel />);
    fireEvent.click(container.querySelector('.viw-about-trigger')!);
    const panel = container.querySelector('#viw-about-panel') as HTMLDivElement;
    const text = (panel.textContent ?? '').toLowerCase();
    // Forbidden per AC-46.7 — no infrastructure or security content in user-facing copy.
    for (const forbidden of ['cors', 'proxy', 'rate limit', 'cloudflare', 'kv', 'observability']) {
      expect(text).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });

  it('AC-46.4 — Escape key closes the panel when focus is inside', () => {
    const { container } = render(<AboutSystemPanel />);
    fireEvent.click(container.querySelector('.viw-about-trigger')!);
    const panel = container.querySelector('#viw-about-panel') as HTMLDivElement;
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(container.querySelector('#viw-about-panel')).toBeNull();
  });

  it('AC-46.4 — clicking the trigger a second time closes the panel; clicking a nested control does not', () => {
    const { container } = render(<AboutSystemPanel />);
    const trigger = container.querySelector('.viw-about-trigger') as HTMLButtonElement;
    fireEvent.click(trigger);
    expect(container.querySelector('#viw-about-panel')).not.toBeNull();
    // A nested control (bill toggle, tab) SHALL NOT close the panel.
    const firstBillToggle = container.querySelector('.viw-about-bill-toggle') as HTMLButtonElement;
    if (firstBillToggle) fireEvent.click(firstBillToggle);
    expect(container.querySelector('#viw-about-panel')).not.toBeNull();
    // Clicking the trigger again SHALL close.
    fireEvent.click(trigger);
    expect(container.querySelector('#viw-about-panel')).toBeNull();
  });

  it('AC-46.1 — valence amplifiers + signs shown match services/valence.ts constants', async () => {
    const { VALENCE_AMPLIFIER, VALENCE_SIGN } = await import('../../src/services/valence');
    const { container } = render(<AboutSystemPanel />);
    fireEvent.click(container.querySelector('.viw-about-trigger')!);
    const rows = Array.from(
      container.querySelectorAll('.viw-about-table:nth-of-type(1) tbody tr'),
    );
    // sponsor-pro row: sign +1, amp 1.5×.
    const sponsorPro = rows.find((r) => r.classList.contains('viw-valence-sponsor-pro'))!;
    const sponsorProCells = sponsorPro.querySelectorAll('td');
    expect(sponsorProCells[0]!.textContent).toBe(VALENCE_SIGN['sponsor-pro'] > 0 ? '+1' : '—');
    expect(sponsorProCells[1]!.textContent).toBe(`${VALENCE_AMPLIFIER['sponsor-pro'].toFixed(1)}×`);
    // voted-anti row: sign −1, amp 1.0×.
    const votedAnti = rows.find((r) => r.classList.contains('viw-valence-voted-anti'))!;
    const votedAntiCells = votedAnti.querySelectorAll('td');
    expect(votedAntiCells[0]!.textContent).toBe('−1');
    expect(votedAntiCells[1]!.textContent).toBe(`${VALENCE_AMPLIFIER['voted-anti'].toFixed(1)}×`);
  });
});
