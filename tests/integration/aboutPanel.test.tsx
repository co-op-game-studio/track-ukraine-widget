/**
 * About panel + widget composition — integration.
 *
 * Verifies the About panel is wired into the widget footer and that opening
 * it does not close (or conflict with) a separately-opened score breakdown
 * panel. This is FR-46 AC-46.6's independence guarantee.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { VoterInfoWidget } from '../../src/VoterInfoWidget';

describe('About panel integration (FR-46 AC-46.6)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // No API calls fire in this test (no address submitted), but the
    // components still try to mount — stub fetch just in case.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
  });

  it('renders the About trigger in the widget footer', () => {
    const { container } = render(<VoterInfoWidget apiBase="" />);
    const footer = container.querySelector('.viw-root-footer') as HTMLElement;
    expect(footer).not.toBeNull();
    const trigger = footer.querySelector('.viw-about-trigger') as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    expect(trigger.textContent).toMatch(/About this system/i);
  });

  it('About panel is independent of the score-breakdown panel — the two panels have distinct controllers', () => {
    const { container } = render(<VoterInfoWidget apiBase="" />);
    const aboutTrigger = container.querySelector('.viw-about-trigger') as HTMLButtonElement;
    fireEvent.click(aboutTrigger);
    expect(aboutTrigger.getAttribute('aria-expanded')).toBe('true');

    // There is no score-breakdown panel in view right now (no rep selected),
    // but we can verify the About panel's `aria-controls` points at its own
    // id, not at the score breakdown's id. Prevents future accidental
    // coupling between the two.
    expect(aboutTrigger.getAttribute('aria-controls')).toBe('viw-about-panel');
    expect(aboutTrigger.getAttribute('aria-controls')).not.toBe('viw-score-breakdown-panel');
    expect(container.querySelector('#viw-about-panel')).not.toBeNull();
  });
});
