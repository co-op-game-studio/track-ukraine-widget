/**
 * DraggableDivider — a vertical splitter the user drags to resize the preview
 * pane. Reports the preview width as a % from the right edge of the container.
 * Keyboard-accessible (ArrowLeft/Right nudge). No external lib.
 *
 * Traces to: FR-60 AC-60.17.
 */
import { useRef, type CSSProperties } from 'react';
import { MIN_PREVIEW_PCT, MAX_PREVIEW_PCT } from '../useProfileLayout';

export interface DraggableDividerProps {
  /** The container whose width the percentage is measured against. */
  containerRef: React.RefObject<HTMLElement | null>;
  previewPct: number;
  onChange: (pct: number) => void;
}

export function DraggableDivider({ containerRef, previewPct, onChange }: DraggableDividerProps) {
  const draggingRef = useRef(false);

  function commitFromClientX(clientX: number) {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    // Preview is the RIGHT pane → its width is measured from the right edge.
    onChange(((rect.right - clientX) / rect.width) * 100);
  }

  const style: CSSProperties = {
    gridArea: 'divider',
    cursor: 'col-resize',
    background: 'var(--tk-border-soft)',
    touchAction: 'none',
    alignSelf: 'stretch',
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize preview pane"
      aria-valuenow={Math.round(previewPct)}
      aria-valuemin={MIN_PREVIEW_PCT}
      aria-valuemax={MAX_PREVIEW_PCT}
      tabIndex={0}
      style={style}
      onPointerDown={(e) => {
        draggingRef.current = true;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (draggingRef.current) commitFromClientX(e.clientX);
      }}
      onPointerUp={(e) => {
        draggingRef.current = false;
        try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') { onChange(previewPct - 2); e.preventDefault(); }
        else if (e.key === 'ArrowRight') { onChange(previewPct + 2); e.preventDefault(); }
      }}
    />
  );
}
