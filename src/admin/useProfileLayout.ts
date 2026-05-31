/**
 * useProfileLayout — persists the person-profile two-column layout prefs
 * (preview width %, collapsed) to localStorage. Mirrors useTheme.ts.
 *
 * Traces to: FR-60 AC-60.17 / AC-60.18.
 */
import { useEffect, useState } from 'react';

const STORAGE_KEY = 'tk-admin-profile-layout';
export const MIN_PREVIEW_PCT = 30;
export const MAX_PREVIEW_PCT = 75;
const DEFAULT: ProfileLayout = { previewPct: 60, previewCollapsed: false };

export interface ProfileLayout {
  /** Preview pane width as a % of the row (clamped 30–75). */
  previewPct: number;
  previewCollapsed: boolean;
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT.previewPct;
  return Math.min(MAX_PREVIEW_PCT, Math.max(MIN_PREVIEW_PCT, Math.round(n)));
}

export function readStoredLayout(): ProfileLayout {
  if (typeof window === 'undefined') return { ...DEFAULT };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT };
    const parsed = JSON.parse(raw) as Partial<ProfileLayout>;
    return {
      previewPct: clampPct(typeof parsed.previewPct === 'number' ? parsed.previewPct : DEFAULT.previewPct),
      previewCollapsed: parsed.previewCollapsed === true,
    };
  } catch {
    return { ...DEFAULT };
  }
}

export interface UseProfileLayoutResult {
  layout: ProfileLayout;
  setPreviewPct: (pct: number) => void;
  toggleCollapsed: () => void;
}

export function useProfileLayout(): UseProfileLayoutResult {
  const [layout, setLayout] = useState<ProfileLayout>(() => readStoredLayout());

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // best-effort persistence
    }
  }, [layout]);

  return {
    layout,
    setPreviewPct: (pct) => setLayout((l) => ({ ...l, previewPct: clampPct(pct) })),
    toggleCollapsed: () => setLayout((l) => ({ ...l, previewCollapsed: !l.previewCollapsed })),
  };
}
