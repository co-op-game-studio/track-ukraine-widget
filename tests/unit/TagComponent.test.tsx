/**
 * Tag — presentational badge for the shared `tags` system primitive.
 *
 * Per CLAUDE.md "Tags are a system primitive": when adding categorization to
 * any resource, prefer the shared `tags` table (color-coded, audited, single
 * CRUD UI under Settings ▸ Tags) over per-resource enum columns. This Tag
 * component is the single visual treatment used everywhere a tag is shown
 * (quote cards, profile, audit log, tag CRUD) — see the source JSDoc on
 * `src/admin/components/Tag.tsx`. Color comes from the tag row, never
 * hard-coded; foreground flips to black or white via a luminance check so the
 * label stays readable on any background.
 *
 * Traceability: TagRow shape originates with Migration 0008 (see
 * `src/admin/types.ts`). The chip is the reusable atom that the shared
 * <CurationCard> and Settings ▸ Tags both render.
 *
 * These tests cover the `Tag` chip in isolation:
 *   - Label + title (description fallback to label)
 *   - Foreground color flip on light vs dark backgrounds
 *   - Size variants ('sm' default vs 'xs')
 *   - Optional remove button: presence, click handler, aria-label,
 *     and stopPropagation on click
 *
 * `vi.mock` is intentionally NOT used (per house convention).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Tag } from '../../src/admin/components/Tag';
import type { TagRow } from '../../src/admin/types';

function makeTag(overrides: Partial<TagRow> = {}): TagRow {
  return {
    id: 'tag-1',
    slug: 'pro-ukraine',
    label: 'Pro-Ukraine',
    color: '#22c55e', // a mid-light green
    description: 'Supports Ukraine aid',
    created_at: '2026-01-01T00:00:00Z',
    created_by: 'kody@example.com',
    updated_at: '2026-01-01T00:00:00Z',
    updated_by: 'kody@example.com',
    ...overrides,
  };
}

describe('Tag', () => {
  describe('label rendering', () => {
    it('renders the tag label', () => {
      render(<Tag tag={makeTag()} />);
      expect(screen.getByText('Pro-Ukraine')).toBeInTheDocument();
    });

    it('uses description as the title attribute when present', () => {
      const { container } = render(<Tag tag={makeTag({ description: 'Supports Ukraine aid' })} />);
      const span = container.querySelector('span');
      expect(span?.getAttribute('title')).toBe('Supports Ukraine aid');
    });

    it('falls back to label as the title when description is null', () => {
      const { container } = render(<Tag tag={makeTag({ description: null, label: 'Anti-War' })} />);
      const span = container.querySelector('span');
      expect(span?.getAttribute('title')).toBe('Anti-War');
    });
  });

  describe('foreground color flip (luminance)', () => {
    // The component computes: luma = (0.299r + 0.587g + 0.114b) / 255.
    // luma > 0.6 → black text; otherwise white.

    it('uses black foreground on a clearly light hex (#ffffff)', () => {
      const { container } = render(<Tag tag={makeTag({ color: '#ffffff' })} />);
      const span = container.querySelector('span') as HTMLSpanElement;
      expect(span.style.color).toBe('rgb(0, 0, 0)');
    });

    it('uses white foreground on a clearly dark hex (#000000)', () => {
      const { container } = render(<Tag tag={makeTag({ color: '#000000' })} />);
      const span = container.querySelector('span') as HTMLSpanElement;
      expect(span.style.color).toBe('rgb(255, 255, 255)');
    });

    it('uses white foreground on a mid-tone red (#ef4444)', () => {
      // luma ≈ (0.299*239 + 0.587*68 + 0.114*68)/255 ≈ 0.45 → not light → white
      const { container } = render(<Tag tag={makeTag({ color: '#ef4444' })} />);
      const span = container.querySelector('span') as HTMLSpanElement;
      expect(span.style.color).toBe('rgb(255, 255, 255)');
    });

    it('uses black foreground on a bright yellow (#eab308)', () => {
      // luma ≈ (0.299*234 + 0.587*179 + 0.114*8)/255 ≈ 0.69 → light → black
      const { container } = render(<Tag tag={makeTag({ color: '#eab308' })} />);
      const span = container.querySelector('span') as HTMLSpanElement;
      expect(span.style.color).toBe('rgb(0, 0, 0)');
    });

    it('falls back to white foreground when color is not a valid 6-digit hex', () => {
      // Non-matching hex → isLightColor returns false → white text.
      const { container } = render(<Tag tag={makeTag({ color: 'not-a-color' })} />);
      const span = container.querySelector('span') as HTMLSpanElement;
      expect(span.style.color).toBe('rgb(255, 255, 255)');
    });

    it('applies the tag color as the background', () => {
      const { container } = render(<Tag tag={makeTag({ color: '#3b82f6' })} />);
      const span = container.querySelector('span') as HTMLSpanElement;
      // jsdom normalizes to rgb(...) — assert via inline style cssText.
      expect(span.style.background).toMatch(/#3b82f6|rgb\(59,\s*130,\s*246\)/);
    });
  });

  describe('size variants', () => {
    it('defaults to size "sm" — 2px 8px padding and var(--tk-fs-sm) font-size', () => {
      const { container } = render(<Tag tag={makeTag()} />);
      const span = container.querySelector('span') as HTMLSpanElement;
      expect(span.style.padding).toBe('2px 8px');
      expect(span.style.fontSize).toBe('var(--tk-fs-sm)');
    });

    it('respects size="sm" explicitly', () => {
      const { container } = render(<Tag tag={makeTag()} size="sm" />);
      const span = container.querySelector('span') as HTMLSpanElement;
      expect(span.style.padding).toBe('2px 8px');
      expect(span.style.fontSize).toBe('var(--tk-fs-sm)');
    });

    it('renders size="xs" with tighter padding (1px 6px) and the xs font token', () => {
      const { container } = render(<Tag tag={makeTag()} size="xs" />);
      const span = container.querySelector('span') as HTMLSpanElement;
      expect(span.style.padding).toBe('1px 6px');
      expect(span.style.fontSize).toBe('var(--tk-fs-xs)');
    });
  });

  describe('remove button (onRemove)', () => {
    it('does NOT render a button when onRemove is omitted', () => {
      render(<Tag tag={makeTag()} />);
      expect(screen.queryByRole('button')).toBeNull();
    });

    it('renders a button labelled "Remove <label>" when onRemove is provided', () => {
      render(<Tag tag={makeTag({ label: 'Pro-Ukraine' })} onRemove={() => {}} />);
      const btn = screen.getByRole('button', { name: 'Remove Pro-Ukraine' });
      expect(btn).toBeInTheDocument();
      expect(btn.textContent).toBe('×');
      expect(btn.getAttribute('type')).toBe('button');
    });

    it('invokes onRemove when the remove button is clicked', () => {
      const onRemove = vi.fn();
      render(<Tag tag={makeTag()} onRemove={onRemove} />);
      fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
      expect(onRemove).toHaveBeenCalledTimes(1);
    });

    it('stops click propagation so a parent onClick does not also fire', () => {
      const parentClick = vi.fn();
      const onRemove = vi.fn();
      render(
        <div onClick={parentClick}>
          <Tag tag={makeTag()} onRemove={onRemove} />
        </div>,
      );
      fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
      expect(onRemove).toHaveBeenCalledTimes(1);
      expect(parentClick).not.toHaveBeenCalled();
    });

    it('mirrors the chip foreground color on the remove button (light bg → black ×)', () => {
      render(<Tag tag={makeTag({ color: '#ffffff' })} onRemove={() => {}} />);
      const btn = screen.getByRole('button', { name: /Remove/ }) as HTMLButtonElement;
      expect(btn.style.color).toBe('rgb(0, 0, 0)');
    });

    it('mirrors the chip foreground color on the remove button (dark bg → white ×)', () => {
      render(<Tag tag={makeTag({ color: '#000000' })} onRemove={() => {}} />);
      const btn = screen.getByRole('button', { name: /Remove/ }) as HTMLButtonElement;
      expect(btn.style.color).toBe('rgb(255, 255, 255)');
    });
  });

  describe('static visual contract', () => {
    it('always renders inline-flex, uppercase, weight-700 with no border-radius', () => {
      const { container } = render(<Tag tag={makeTag()} />);
      const span = container.querySelector('span') as HTMLSpanElement;
      expect(span.style.display).toBe('inline-flex');
      expect(span.style.textTransform).toBe('uppercase');
      expect(span.style.fontWeight).toBe('700');
      expect(span.style.borderRadius).toBe('0');
      expect(span.style.whiteSpace).toBe('nowrap');
    });
  });
});
