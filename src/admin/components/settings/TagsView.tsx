/**
 * Tags CRUD — Settings ▸ Tags.
 *
 * Tags are a shared categorization primitive (see CLAUDE.md). Quotes are the
 * first consumer; future resources will use the same `tags` + `*_tags` join
 * pattern. Each tag has a slug, label, color, optional description.
 *
 * Audit trail: all writes log via the existing audit_log infrastructure
 * (admin.tag.* events, see proxy/routes/api-admin.ts).
 */
import { useCallback, useEffect, useState } from 'react';
import { get, post, patch as patchApi, del as delApi } from '../../fetcher';
import type { TagRow } from '../../types';
import { Tag } from '../Tag';

const DEFAULT_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
  '#64748b', '#0ea5e9',
];

export function TagsView() {
  const [tags, setTags] = useState<TagRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    get<{ items: TagRow[] }>('/api/admin/tags')
      .then((r) => setTags(r.items))
      .catch(() => setTags([]))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div style={S.root}>
      <div style={S.toolRow}>
        <h2 style={S.heading}>Tags</h2>
        <span style={S.muted}>
          Color-coded labels applied to quotes. Used in Curation, Activity, and Profile views.
        </span>
        <span style={{ flex: 1 }} />
        {!creating && (
          <button type="button" onClick={() => setCreating(true)} style={S.actionBtn}>+ New tag</button>
        )}
      </div>

      {creating && (
        <TagForm
          mode="create"
          onSave={() => { setCreating(false); load(); }}
          onCancel={() => setCreating(false)}
        />
      )}

      {loading && <div style={S.muted}>Loading…</div>}

      {tags.map((t) => (
        editing === t.id ? (
          <TagForm
            key={t.id}
            mode="edit"
            existing={t}
            onSave={() => { setEditing(null); load(); }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div key={t.id} style={S.row}>
            <Tag tag={t} />
            <span style={S.slug}>/{t.slug}</span>
            {t.description && <span style={{ color: 'var(--tk-muted)', fontSize: 'var(--tk-fs-sm)' }}>{t.description}</span>}
            <span style={{ flex: 1 }} />
            <button type="button" onClick={() => setEditing(t.id)} style={S.tinyBtn}>Edit</button>
            <button
              type="button"
              onClick={async () => {
                if (!confirm(`Delete tag "${t.label}"? This will remove it from all quotes.`)) return;
                try {
                  await delApi(`/api/admin/tags/${t.id}`);
                  load();
                } catch (e) {
                  alert(`Delete failed: ${errorMsg(e)}`);
                }
              }}
              style={{ ...S.tinyBtn, color: 'var(--tk-danger)' }}
            >
              Delete
            </button>
          </div>
        )
      ))}
    </div>
  );
}

function TagForm({
  mode,
  existing,
  onSave,
  onCancel,
}: {
  mode: 'create' | 'edit';
  existing?: TagRow;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [slug, setSlug] = useState(existing?.slug ?? '');
  const [label, setLabel] = useState(existing?.label ?? '');
  const [color, setColor] = useState(existing?.color ?? DEFAULT_COLORS[0]!);
  const [description, setDescription] = useState(existing?.description ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Derive slug from label as user types (only when creating + slug untouched).
  function onLabelChange(v: string) {
    setLabel(v);
    if (mode === 'create' && (slug === '' || slug === slugify(label))) {
      setSlug(slugify(v));
    }
  }

  async function save() {
    setError(null);
    if (!label.trim()) { setError('Label is required'); return; }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) { setError('Slug must be lowercase kebab-case'); return; }
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) { setError('Color must be a 6-digit hex (#rrggbb)'); return; }
    setSaving(true);
    try {
      if (mode === 'create') {
        await post('/api/admin/tags', { slug, label, color, description: description || null });
      } else if (existing) {
        await patchApi(`/api/admin/tags/${existing.id}`, { slug, label, color, description: description || null });
      }
      onSave();
    } catch (e) {
      setError(errorMsg(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={S.formBox}>
      <div style={S.row}>
        <Tag tag={{ id: 'preview', slug, label: label || 'Preview', color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#888', description: null, created_at: '', created_by: null, updated_at: '', updated_by: null }} />
        <span style={S.muted}>preview</span>
      </div>
      <div style={S.row}>
        <Field label="Label" style={{ flex: 2, minWidth: 200 }}>
          <input value={label} onChange={(e) => onLabelChange(e.target.value)} style={S.input} placeholder="On floor" />
        </Field>
        <Field label="Slug" style={{ flex: 1, minWidth: 160 }}>
          <input value={slug} onChange={(e) => setSlug(e.target.value)} style={S.input} placeholder="on-floor" />
        </Field>
      </div>
      <Field label="Description (optional)">
        <input value={description} onChange={(e) => setDescription(e.target.value)} style={S.input} />
      </Field>
      <Field label="Color">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {DEFAULT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              aria-label={`Pick color ${c}`}
              style={{
                width: 24,
                height: 24,
                background: c,
                border: color === c ? '3px solid var(--tk-fg)' : '2px solid var(--tk-border-soft)',
                cursor: 'pointer',
                padding: 0,
                borderRadius: 0,
              }}
            />
          ))}
          <input
            type="text"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            style={{ ...S.input, width: 100, fontFamily: 'var(--tk-font-mono)' }}
            placeholder="#000000"
          />
        </div>
      </Field>
      {error && <div style={{ color: 'var(--tk-danger)', fontSize: 'var(--tk-fs-sm)' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={save} disabled={saving} style={S.actionBtn}>{saving ? 'Saving…' : mode === 'create' ? 'Create tag' : 'Save changes'}</button>
        <button type="button" onClick={onCancel} style={{ ...S.tinyBtn, padding: '6px 14px' }}>Cancel</button>
      </div>
    </div>
  );
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
}

function Field({ label, children, style }: { label: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, ...style }}>
      <span style={S.fieldLabel}>{label}</span>
      {children}
    </div>
  );
}

function errorMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null) {
    const obj = e as Record<string, unknown>;
    if (typeof obj.detail === 'string') return obj.detail;
    if (typeof obj.error === 'string') return obj.error;
  }
  return String(e);
}

const INPUT_BASE: React.CSSProperties = {
  background: 'var(--tk-bg)',
  color: 'var(--tk-fg)',
  border: '2px solid var(--tk-border-soft)',
  borderRadius: 0,
  padding: '6px 10px',
  fontFamily: 'var(--tk-font)',
  fontSize: 'var(--tk-fs-sm)',
  minWidth: 0,
};

const S: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 10 },
  toolRow: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  row: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', border: '1px solid var(--tk-border-soft)', background: 'var(--tk-surface)' },
  heading: { fontSize: 'var(--tk-fs-md)', fontWeight: 800, margin: 0 },
  muted: { color: 'var(--tk-muted)', fontSize: 'var(--tk-fs-sm)' },
  slug: { fontFamily: 'var(--tk-font-mono)', fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)' },
  input: INPUT_BASE,
  fieldLabel: { fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 700 },
  formBox: {
    padding: '12px 16px',
    border: '2px solid var(--tk-accent)',
    background: 'var(--tk-surface)',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  tinyBtn: {
    ...INPUT_BASE,
    background: 'var(--tk-bg)',
    color: 'var(--tk-fg)',
    fontSize: 'var(--tk-fs-xs)',
    fontWeight: 700,
    textTransform: 'uppercase',
    cursor: 'pointer',
    padding: '2px 8px',
  },
  actionBtn: {
    ...INPUT_BASE,
    background: 'var(--tk-accent)',
    color: 'var(--tk-accent-fg)',
    border: '2px solid var(--tk-border)',
    fontWeight: 700,
    textTransform: 'uppercase',
    cursor: 'pointer',
    padding: '6px 14px',
  },
};
