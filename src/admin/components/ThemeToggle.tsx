/**
 * Theme toggle — cycles system → light → dark. AC-52.29 + AC-52.30.
 */
import { useTheme, type ThemeMode } from '../useTheme';

const LABELS: Record<ThemeMode, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

const ICONS: Record<ThemeMode, string> = {
  system: '◐',
  light: '☀',
  dark: '☾',
};

export function ThemeToggle() {
  const { mode, cycle } = useTheme();
  const next: ThemeMode = mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system';
  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={`Theme: ${LABELS[mode]} (click for ${LABELS[next]})`}
      style={{
        background: 'transparent',
        color: 'var(--tk-fg)',
        border: '2px solid var(--tk-border-soft)',
        borderRadius: 0,
        padding: '4px 10px',
        cursor: 'pointer',
        fontFamily: 'var(--tk-font)',
        fontSize: 'var(--tk-fs-sm)',
        fontWeight: 'var(--tk-fw-bold)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <span aria-hidden="true">{ICONS[mode]}</span>
      <span>{LABELS[mode]}</span>
    </button>
  );
}
