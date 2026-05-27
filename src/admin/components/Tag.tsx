/**
 * Tag badge — same visual treatment everywhere a tag is shown.
 *
 * Color comes from the tag row, never hard-coded. Use this anywhere a tag
 * appears: quote cards, profile, audit log, tag CRUD.
 *
 * `<TagPicker>` is the shared multi-select chip row, with built-in
 * "+ New tag" inline-create — so any consumer of the picker (Add Quote,
 * inline edit, future quote-bearing surfaces) gets on-the-fly tag creation
 * for free without re-implementing it.
 */
import { useState } from 'react';
import { post } from '../fetcher';
import type { TagRow } from '../types';

/** True if the perceived luminance of a hex color is high enough that
 *  black text reads better than white on it. Quick & dirty WCAG-ish check. */
function isLightColor(hex: string): boolean {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = Number.parseInt(m[1]!, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  // Standard relative-luminance approximation.
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.6;
}

export function Tag({
  tag,
  onRemove,
  size = 'sm',
}: {
  tag: TagRow;
  /** When provided, renders an "x" the user can click to remove this tag. */
  onRemove?: () => void;
  size?: 'sm' | 'xs';
}): React.ReactElement {
  const fg = isLightColor(tag.color) ? '#000' : '#fff';
  const padding = size === 'xs' ? '1px 6px' : '2px 8px';
  const fontSize = size === 'xs' ? 'var(--tk-fs-xs)' : 'var(--tk-fs-sm)';
  return (
    <span
      title={tag.description ?? tag.label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding,
        background: tag.color,
        color: fg,
        fontFamily: 'var(--tk-font)',
        fontSize,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        borderRadius: 0,
        border: '1px solid rgba(0,0,0,0.2)',
        whiteSpace: 'nowrap',
      }}
    >
      {tag.label}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          aria-label={`Remove ${tag.label}`}
          style={{
            background: 'none',
            border: 'none',
            color: fg,
            fontWeight: 700,
            cursor: 'pointer',
            padding: '0 2px',
            fontSize: 'inherit',
            lineHeight: 1,
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}

/** Default color swatches offered by the inline-create form. Same palette
 *  as Settings ▸ Tags so the two surfaces feel consistent. */
const QUICK_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#64748b'];

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
}

/**
 * Multi-select picker for tags with built-in "+ New tag" inline-create.
 *
 * - Click a chip to toggle inclusion
 * - Click `+ New tag` to expand a small inline form (name + color)
 * - On submit, POSTs to `/api/admin/tags`, auto-applies the new tag, and
 *   bubbles the new TagRow up via `onTagCreated` so the parent can update
 *   its own `available` cache without a refetch
 *
 * The full Settings ▸ Tags page remains the canonical CRUD; this just
 * keeps researchers in flow when they need a new tag *right now* without
 * leaving Add Quote / inline edit / wherever they are.
 */
export function TagPicker({
  available,
  selectedIds,
  onChange,
  onTagCreated,
  allowInlineCreate = true,
}: {
  available: TagRow[];
  selectedIds: string[];
  onChange: (next: string[]) => void;
  /** Called after a successful inline-create with the new tag row.
   *  Parent should append it to its own `available` list. If omitted,
   *  inline-create is implicitly disabled (no point creating tags the
   *  parent can't see). */
  onTagCreated?: (t: TagRow) => void;
  /** Set false to render a read-only picker without the create affordance. */
  allowInlineCreate?: boolean;
}): React.ReactElement {
  const selectedSet = new Set(selectedIds);
  function toggle(id: string) {
    const next = new Set(selectedSet);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange([...next]);
  }

  const [creating, setCreating] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newColor, setNewColor] = useState<string>(QUICK_COLORS[0]!);
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function createTag() {
    setCreateError(null);
    const label = newLabel.trim();
    if (!label) { setCreateError('Name required'); return; }
    const slug = slugify(label);
    if (!slug) { setCreateError('Name must contain a letter or digit'); return; }
    setSubmitting(true);
    try {
      const r = await post<{ tag: TagRow }>('/api/admin/tags', {
        slug,
        label,
        color: newColor,
        description: null,
      });
      onTagCreated?.(r.tag);
      // Auto-apply the new tag to the current selection.
      onChange([...selectedIds, r.tag.id]);
      setNewLabel('');
      setNewColor(QUICK_COLORS[0]!);
      setCreating(false);
    } catch (e) {
      setCreateError(errorMsgOf(e));
    } finally {
      setSubmitting(false);
    }
  }

  const canCreate = allowInlineCreate && Boolean(onTagCreated);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {available.map((t) => {
          const isOn = selectedSet.has(t.id);
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => toggle(t.id)}
              title={t.description ?? t.label}
              style={{
                padding: '2px 8px',
                background: isOn ? t.color : 'transparent',
                color: isOn ? (isLightColor(t.color) ? '#000' : '#fff') : 'var(--tk-fg)',
                fontFamily: 'var(--tk-font)',
                fontSize: 'var(--tk-fs-sm)',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                border: `1px solid ${t.color}`,
                borderRadius: 0,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {t.label}
            </button>
          );
        })}
        {available.length === 0 && !creating && (
          <span style={{ color: 'var(--tk-muted)', fontSize: 'var(--tk-fs-xs)' }}>
            No tags yet.
          </span>
        )}
        {canCreate && !creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            title="Create a new tag and apply it"
            style={{
              padding: '2px 10px',
              background: 'transparent',
              color: 'var(--tk-fg)',
              border: '1px dashed var(--tk-border-soft)',
              fontFamily: 'var(--tk-font)',
              fontSize: 'var(--tk-fs-xs)',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              cursor: 'pointer',
              borderRadius: 0,
            }}
          >
            + New tag
          </button>
        )}
      </div>

      {creating && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          padding: 8,
          background: 'var(--tk-bg)',
          border: `2px solid ${newColor}`,
        }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="text"
              autoFocus
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createTag(); if (e.key === 'Escape') setCreating(false); }}
              placeholder="New tag name..."
              style={{
                background: 'var(--tk-bg)',
                color: 'var(--tk-fg)',
                border: '2px solid var(--tk-border-soft)',
                borderRadius: 0,
                padding: '6px 10px',
                fontFamily: 'var(--tk-font)',
                fontSize: 'var(--tk-fs-sm)',
                flex: 1,
                minWidth: 140,
              }}
            />
            {/* Live preview chip */}
            <span style={{
              padding: '2px 8px',
              background: newColor,
              color: isLightColor(newColor) ? '#000' : '#fff',
              fontSize: 'var(--tk-fs-xs)',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              border: '1px solid rgba(0,0,0,0.2)',
            }}>
              {newLabel.trim() || 'preview'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{
              fontSize: 'var(--tk-fs-xs)',
              color: 'var(--tk-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              fontWeight: 700,
              marginRight: 4,
            }}>
              Color
            </span>
            {QUICK_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setNewColor(c)}
                aria-label={`Pick color ${c}`}
                style={{
                  width: 22,
                  height: 22,
                  background: c,
                  border: newColor === c ? '3px solid var(--tk-fg)' : '1px solid var(--tk-border-soft)',
                  cursor: 'pointer',
                  padding: 0,
                  borderRadius: 0,
                }}
              />
            ))}
            <input
              type="text"
              value={newColor}
              onChange={(e) => setNewColor(e.target.value)}
              style={{
                background: 'var(--tk-bg)',
                color: 'var(--tk-fg)',
                border: '2px solid var(--tk-border-soft)',
                borderRadius: 0,
                padding: '6px 10px',
                fontFamily: 'var(--tk-font-mono)',
                fontSize: 'var(--tk-fs-sm)',
                width: 90,
              }}
              placeholder="#000000"
            />
          </div>
          {createError && (
            <div style={{ color: 'var(--tk-danger)', fontSize: 'var(--tk-fs-sm)' }}>{createError}</div>
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              onClick={createTag}
              disabled={submitting || !newLabel.trim()}
              style={{
                background: 'var(--tk-accent)',
                color: 'var(--tk-accent-fg)',
                border: '2px solid var(--tk-border)',
                borderRadius: 0,
                padding: '6px 14px',
                fontFamily: 'var(--tk-font)',
                fontSize: 'var(--tk-fs-sm)',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                cursor: 'pointer',
                opacity: (submitting || !newLabel.trim()) ? 0.5 : 1,
              }}
            >
              {submitting ? 'Creating…' : 'Create + apply'}
            </button>
            <button
              type="button"
              onClick={() => { setCreating(false); setNewLabel(''); setCreateError(null); }}
              style={{
                background: 'var(--tk-bg)',
                color: 'var(--tk-fg)',
                border: '2px solid var(--tk-border-soft)',
                borderRadius: 0,
                padding: '6px 14px',
                fontFamily: 'var(--tk-font)',
                fontSize: 'var(--tk-fs-xs)',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function errorMsgOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null) {
    const obj = e as Record<string, unknown>;
    if (typeof obj.detail === 'string') return obj.detail;
    if (typeof obj.error === 'string') return obj.error;
  }
  return String(e);
}
