/**
 * Theme resolution hook for the admin SPA. AC-52.29.
 *
 * Three modes: `system` (follow `prefers-color-scheme`), `light`, `dark`.
 * Persists to `localStorage["tk-admin-theme"]`. Writes the resolved value to
 * `document.documentElement.dataset.theme` so token-block CSS can react.
 *
 * Pre-mount FOUC prevention runs in `index.html` before React boots; this
 * hook is for the live toggle + system-preference change subscription.
 */
import { useEffect, useState } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'tk-admin-theme';

function resolveSystem(): 'light' | 'dark' {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  const resolved = mode === 'system' ? resolveSystem() : mode;
  document.documentElement.dataset.theme = resolved;
}

export function readStoredMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // localStorage unavailable (private mode, etc) — fall through.
  }
  return 'system';
}

export function useTheme(): {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  cycle: () => void;
} {
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredMode());

  // Apply on mount and on every change.
  useEffect(() => {
    applyTheme(mode);
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Best-effort persistence.
    }
  }, [mode]);

  // When in `system` mode, react live to OS preference changes.
  useEffect(() => {
    if (
      mode !== 'system' ||
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function'
    ) {
      return;
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [mode]);

  const setMode = (m: ThemeMode) => setModeState(m);
  const cycle = () => {
    setModeState((m) => (m === 'system' ? 'light' : m === 'light' ? 'dark' : 'system'));
  };

  return { mode, setMode, cycle };
}
