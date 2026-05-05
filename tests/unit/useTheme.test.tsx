/**
 * useTheme + ThemeToggle — AC-52.29 dark-mode toggle persistence.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ThemeToggle } from '../../src/admin/components/ThemeToggle';
import { readStoredMode } from '../../src/admin/useTheme';

interface FakeMql {
  matches: boolean;
  listeners: Array<(e: MediaQueryListEvent) => void>;
  addEventListener(type: 'change', l: (e: MediaQueryListEvent) => void): void;
  removeEventListener(type: 'change', l: (e: MediaQueryListEvent) => void): void;
  fire(matches: boolean): void;
}

function installMatchMedia(initialMatches: boolean): FakeMql {
  const fake: FakeMql = {
    matches: initialMatches,
    listeners: [],
    addEventListener(_t, l) { this.listeners.push(l); },
    removeEventListener(_t, l) { this.listeners = this.listeners.filter((x) => x !== l); },
    fire(matches) {
      this.matches = matches;
      this.listeners.forEach((l) =>
        l({ matches } as MediaQueryListEvent),
      );
    },
  };
  vi.stubGlobal('matchMedia', () => fake as unknown as MediaQueryList);
  // Also patch window.matchMedia (jsdom) since useTheme uses window.matchMedia.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => fake as unknown as MediaQueryList,
  });
  return fake;
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('ThemeToggle (AC-52.29)', () => {
  it('AC-52.29(a): cycles system → light → dark → system', () => {
    installMatchMedia(false);
    render(<ThemeToggle />);
    const btn = screen.getByRole('button');
    // Initial: system
    expect(btn.textContent).toMatch(/System/);
    fireEvent.click(btn);
    expect(btn.textContent).toMatch(/Light/);
    fireEvent.click(btn);
    expect(btn.textContent).toMatch(/Dark/);
    fireEvent.click(btn);
    expect(btn.textContent).toMatch(/System/);
  });

  it('AC-52.29(b): choice persists to localStorage', () => {
    installMatchMedia(false);
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button')); // → light
    expect(window.localStorage.getItem('tk-admin-theme')).toBe('light');
    fireEvent.click(screen.getByRole('button')); // → dark
    expect(window.localStorage.getItem('tk-admin-theme')).toBe('dark');
  });

  it('AC-52.29(c): system mode reacts to matchMedia change events', () => {
    const mql = installMatchMedia(false); // system says light
    render(<ThemeToggle />);
    // Mode starts at system → resolved theme = light
    expect(document.documentElement.dataset.theme).toBe('light');
    // OS flips to dark.
    act(() => mql.fire(true));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('AC-52.29(c): non-system modes do NOT react to matchMedia changes', () => {
    const mql = installMatchMedia(false);
    render(<ThemeToggle />);
    // Cycle to light explicitly.
    fireEvent.click(screen.getByRole('button'));
    expect(document.documentElement.dataset.theme).toBe('light');
    // OS flips to dark — explicit `light` should hold.
    act(() => mql.fire(true));
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('AC-52.29(d): initial render reflects stored preference', () => {
    window.localStorage.setItem('tk-admin-theme', 'dark');
    installMatchMedia(false);
    render(<ThemeToggle />);
    expect(screen.getByRole('button').textContent).toMatch(/Dark/);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('readStoredMode tolerates corrupt values', () => {
    window.localStorage.setItem('tk-admin-theme', 'banana');
    expect(readStoredMode()).toBe('system');
  });
});
