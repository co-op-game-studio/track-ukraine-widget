/**
 * Generic list-detail editor used by every CRUD tab in the admin SPA.
 * Each instance is configured with:
 *   - resource path segment (e.g. "bills")
 *   - list-row label fn
 *   - field schema for the editor form
 *
 * Optimistic update + revert + toast pattern per FR-52 AC-52.4.
 *
 * Traces to FR-52.
 */
import { useEffect, useMemo, useState } from 'react';
import { get, post, patch, del, type FetchError } from '../fetcher';
import { sanitizeUrl } from '../../utils/sanitizeUrl';

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'slider'
  | 'select'
  | 'checkbox'
  | 'url';

/** AC-52.15 + AC-52.31 — width hints for grouped layout.
 *  - short ≈ 8ch — numeric IDs (congress, session, roll-call#, score)
 *  - medium ≈ 24ch — type code, date, single-token labels
 *  - long → max 60ch — free prose (title, label, rationale, body)
 *  - full → 100% — explicit override (kept for AC-52.20 latest_action) */
export type FieldWidth = 'short' | 'medium' | 'long' | 'full';

export interface FieldSchema<T> {
  /** Property key on the row object. */
  key: keyof T & string;
  /** Display label. */
  label: string;
  kind: FieldKind;
  /** For 'select' / 'slider' — the choices / numeric range. */
  options?: Array<{ value: string | number; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  help?: string;
  /** Optional placeholder hint inside the input. Use this instead of `help`
   *  when the hint is short enough to live inside the field and would otherwise
   *  bloat the row with a separate slug. */
  placeholder?: string;
  /**
   * AC-52.15 — semantic group name. Adjacent fields with the same group
   * render in a single <fieldset> with this string as the legend. Schema
   * authors declare related fields adjacent in the array; the renderer
   * splits at group-value boundaries.
   */
  group?: string;
  /** AC-52.15 — `short ≈ 120px`, `medium ≈ 240px`, `full = 100%`. Default: `full`. */
  width?: FieldWidth;
}

export interface ResourceTabProps<T extends { id: string }> {
  resource: string;
  listLabel: (row: T) => string;
  schema: FieldSchema<T>[];
  /** A function that returns a blank row for "New". */
  blank: () => Partial<T>;
  /** Optional list query suffix (e.g. ?billId=…). */
  listQuery?: string;
  /**
   * Optional pure transform applied to the editing row before render and
   * before save. Used for deterministic derived fields (e.g. bill_id =
   * `${congress}-${type.toUpperCase()}-${number}`). The function returns a
   * partial row whose keys override the current draft.
   *
   * Traces to FR-52 AC-52.12.
   */
  derive?: (row: Partial<T>) => Partial<T>;
  /**
   * Optional predicate marking certain field keys as read-only. Read-only
   * inputs render with the `readOnly` attribute and a visual cue; their
   * value comes from `derive` (or the underlying row) rather than user edit.
   *
   * Second arg `isNew` lets callers vary the predicate per flow — e.g. AC-52.32
   * makes congress / type / number read-only on existing rows but editable on
   * the create form.
   */
  isReadOnly?: (key: keyof T & string, isNew: boolean) => boolean;
  /**
   * AC-52.16 — optional render callback that injects content beneath the
   * field groups, above the change-notes textarea + action buttons. Used
   * by BillsTab to render inline votes / comments sections scoped to the
   * currently-edited bill.
   */
  renderBelow?: (editingRow: Partial<T>) => React.ReactNode;

  /**
   * AC-52.46 — optional override for the "+ New" click. When set, the
   * default empty-row create flow is replaced. Returns either an `id` (ULID,
   * the row's primary key) or a domain key like `bill_id` plus a matcher.
   * The simpler shape: the override returns the `bill_id` (or equivalent
   * unique business key) and we look it up in the freshly-reloaded list.
   * Used by BillsTab to mount BillImportPanel instead of an empty bill editor.
   */
  onNewClick?: () => Promise<string | null>;
  /** Optional matcher: given a freshly-imported business key (returned by
   *  `onNewClick`), find the row in the list and return its primary `id`. */
  matchBusinessKey?: (row: T, key: string) => boolean;
}

/** AC-52.15 — split a flat schema into adjacent-group runs.
 *  Schema authors declare related fields adjacent in the array; we walk
 *  the array and start a new group every time the `group` value changes. */
export function groupSchemaByGroup<T>(
  schema: FieldSchema<T>[],
): { name: string | undefined; fields: FieldSchema<T>[] }[] {
  const out: { name: string | undefined; fields: FieldSchema<T>[] }[] = [];
  for (const f of schema) {
    const last = out[out.length - 1];
    if (last && last.name === f.group) {
      last.fields.push(f);
    } else {
      out.push({ name: f.group, fields: [f] });
    }
  }
  return out;
}

interface ListResponse<T> {
  items: T[];
}

interface CreateResponse<T> {
  row: T;
}

interface UpdateResponse<T> {
  row: T;
}

interface Toast {
  kind: 'error' | 'success';
  message: string;
  detail?: string;
  traceId?: string;
}

export function ResourceTab<T extends { id: string }>({
  resource,
  listLabel,
  schema,
  blank,
  listQuery = '',
  derive,
  isReadOnly,
  renderBelow,
  onNewClick,
  matchBusinessKey,
}: ResourceTabProps<T>) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<T> | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  // Optional change-notes the researcher attaches to a write — flows into
  // audit_log.reason. Cleared on every save / cancel.
  const [reason, setReason] = useState<string>('');

  const reload = async () => {
    setLoading(true);
    try {
      const r = await get<ListResponse<T>>(`/api/admin/${resource}${listQuery}`);
      setItems(r.items ?? []);
    } catch (e) {
      const fe = e as FetchError;
      setToast({ kind: 'error', message: fe.error, detail: fe.detail, traceId: fe.traceId });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource, listQuery]);

  const selected = useMemo(
    () => items.find((r) => r.id === selectedId) ?? null,
    [items, selectedId],
  );

  const handleSelect = (id: string) => {
    setSelectedId(id);
    setDraft(null);
  };

  const handleNew = async () => {
    if (onNewClick) {
      const businessKey = await onNewClick();
      if (businessKey) {
        // Re-fetch list so the imported row appears, then resolve to its id.
        const r = await get<ListResponse<T>>(`/api/admin/${resource}${listQuery}`);
        const items = r.items ?? [];
        setItems(items);
        const found = matchBusinessKey
          ? items.find((row) => matchBusinessKey(row, businessKey))
          : items.find((row) => row.id === businessKey);
        if (found) {
          setSelectedId(found.id);
          setDraft(null);
        }
      }
      return;
    }
    setSelectedId(null);
    setDraft(blank());
  };

  /** Wrap the body with `_reason` so the audit_log row picks up change notes. */
  const withReason = (body: Partial<T>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...body };
    if (reason.trim().length > 0) out._reason = reason.trim();
    return out;
  };

  const handleSave = async () => {
    if (!draft) return;
    // AC-52.12 — submit the derived view, not the raw draft, so any
    // computed fields (e.g. bill_id) reach the Worker.
    const submitBody: Partial<T> = derive
      ? { ...draft, ...derive(draft) }
      : draft;
    try {
      if (selected) {
        const r = await patch<UpdateResponse<T>>(
          `/api/admin/${resource}/${encodeURIComponent(selected.id)}`,
          withReason(submitBody),
        );
        setItems((xs) => xs.map((x) => (x.id === r.row.id ? r.row : x)));
        setToast({ kind: 'success', message: 'Updated' });
        setDraft(null);
        setReason('');
      } else {
        const r = await post<CreateResponse<T>>(
          `/api/admin/${resource}`,
          withReason(submitBody),
        );
        setItems((xs) => [r.row, ...xs]);
        setSelectedId(r.row.id);
        setDraft(null);
        setReason('');
        setToast({ kind: 'success', message: 'Created' });
      }
    } catch (e) {
      const fe = e as FetchError;
      setToast({ kind: 'error', message: fe.error, detail: fe.detail, traceId: fe.traceId });
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    if (!confirm(`Delete ${listLabel(selected)}?`)) return;
    const before = items;
    setItems((xs) => xs.filter((x) => x.id !== selected.id));
    setSelectedId(null);
    try {
      // DELETE bodies are non-standard but D1 admin route handlers accept
      // the reason via a query param so the audit_log captures it without
      // requiring a body on DELETE.
      const q = reason.trim().length > 0
        ? `?reason=${encodeURIComponent(reason.trim())}`
        : '';
      await del(`/api/admin/${resource}/${encodeURIComponent(selected.id)}${q}`);
      setToast({ kind: 'success', message: 'Deleted' });
      setReason('');
    } catch (e) {
      // Optimistic revert.
      setItems(before);
      const fe = e as FetchError;
      setToast({ kind: 'error', message: fe.error, detail: fe.detail, traceId: fe.traceId });
    }
  };

  const handleField = (key: keyof T & string, value: unknown) => {
    setDraft((d) => ({ ...(d ?? selected ?? blank()), [key]: value }));
  };

  // AC-52.12 — apply `derive` to surface deterministic fields (e.g. bill_id)
  // both in the rendered editor AND in the body sent on save. This is a pure
  // overlay: caller owns the rule, we just thread it through.
  const rawEditing = draft ?? selected;
  const editing = rawEditing
    ? derive
      ? ({ ...(rawEditing as Partial<T>), ...derive(rawEditing as Partial<T>) } as Partial<T>)
      : (rawEditing as Partial<T>)
    : null;

  // AC-52.18 — Save gate: change-notes are required on update flows.
  const reasonValid = reason.trim().length > 0;
  const saveDisabled = selected !== null && !reasonValid;

  return (
    <div style={styles.root}>
      <aside style={styles.list}>
        <div style={styles.listHeader}>
          <span>{loading ? 'Loading…' : `${items.length} ${resource}`}</span>
          <button type="button" style={styles.newBtn} onClick={handleNew}>
            + New
          </button>
        </div>
        <ul style={styles.ul}>
          {items.map((row) => {
            const label = listLabel(row);
            return (
              <li
                key={row.id}
                onClick={() => handleSelect(row.id)}
                title={label}
                style={{
                  ...styles.li,
                  ...(row.id === selectedId ? styles.liSelected : {}),
                  // AC-52.14 — long bill titles ellipsize rather than wrap.
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {label}
              </li>
            );
          })}
        </ul>
      </aside>
      <section style={styles.editor}>
        {editing ? (
          <>
            <div style={styles.editorHeader}>
              {selected ? `Editing ${listLabel(selected)}` : `New ${resource.replace(/s$/, '')}`}
            </div>
            <div style={styles.fields}>
              {/* AC-52.15 — schema split into groups by `group` value runs. */}
              {groupSchemaByGroup(schema).map((grp, gi) => (
                <fieldset key={gi} style={styles.fieldset}>
                  {grp.name && <legend style={styles.legend}>{grp.name}</legend>}
                  <div style={styles.fieldGrid}>
                    {grp.fields.map((f) => (
                      <div
                        key={f.key}
                        style={{
                          ...styles.gridSlot,
                          ...(f.width === 'short'
                            ? { flex: '0 1 110px', minWidth: 90 }
                            : f.width === 'medium'
                              ? { flex: '0 1 200px', minWidth: 160 }
                              : f.width === 'long'
                                ? { flex: '1 1 360px', minWidth: 240, maxWidth: '60ch' }
                                : { flex: '1 1 100%', minWidth: '100%' }),
                        }}
                      >
                        <Field
                          schema={f}
                          value={(editing as Record<string, unknown>)[f.key]}
                          onChange={(v) => handleField(f.key, v)}
                          readOnly={isReadOnly?.(f.key, selected === null) ?? false}
                        />
                      </div>
                    ))}
                  </div>
                </fieldset>
              ))}
              {/* AC-52.16 — inline bill-attached sections (rendered by the
                  parent tab via renderBelow). */}
              {renderBelow?.(editing as Partial<T>)}
              {/* Change notes (audit_log.reason). AC-52.18 — required on
                  update, optional on create. */}
              <label style={styles.field}>
                <span style={styles.fieldLabel}>
                  Change notes{' '}
                  {selected ? (
                    <span
                      style={{
                        color: reasonValid ? 'var(--muted)' : 'var(--danger)',
                        fontWeight: reasonValid ? 'normal' : 600,
                      }}
                    >
                      {reasonValid ? '(audit trail)' : 'Required for updates'}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--muted)' }}>(audit trail)</span>
                  )}
                </span>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  style={{
                    ...styles.input,
                    minHeight: 60,
                    ...(selected && !reasonValid
                      ? { border: '1px solid var(--danger)' }
                      : {}),
                  }}
                  placeholder={
                    selected
                      ? 'Why this edit? Required when updating an existing row.'
                      : 'Optional context for this new row.'
                  }
                />
                <span style={styles.help}>
                  {selected
                    ? 'Required. Stamped onto audit_log.reason for this update.'
                    : 'Optional. Visible in the authenticated audit feed.'}
                </span>
              </label>
            </div>
            <div style={styles.actions}>
              <button
                type="button"
                style={{
                  ...styles.saveBtn,
                  ...(saveDisabled ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
                }}
                onClick={handleSave}
                disabled={saveDisabled}
              >
                {selected ? 'Save' : 'Create'}
              </button>
              {selected && (
                <button type="button" style={styles.deleteBtn} onClick={handleDelete}>
                  Delete
                </button>
              )}
              <button
                type="button"
                style={styles.cancelBtn}
                onClick={() => {
                  // Close the editor entirely on Cancel — no selection, no
                  // draft. Researcher returns to the list with no row in focus.
                  setDraft(null);
                  setReason('');
                  setSelectedId(null);
                }}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div style={styles.placeholder}>Select a row or click + New.</div>
        )}
      </section>
      {toast && (
        <div
          style={{
            ...styles.toast,
            ...(toast.kind === 'error' ? styles.toastError : styles.toastSuccess),
          }}
          onClick={() => setToast(null)}
        >
          <strong>{toast.message}</strong>
          {toast.detail && <div style={{ fontSize: 12 }}>{toast.detail}</div>}
          {toast.traceId && (
            <div style={{ fontSize: 11, color: '#aaa' }}>
              trace: <code>{toast.traceId}</code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface FieldProps<T> {
  schema: FieldSchema<T>;
  value: unknown;
  onChange: (v: unknown) => void;
  /** AC-52.12 — when true, renders the input as readOnly + visually muted. */
  readOnly?: boolean;
}

function Field<T>({ schema, value, onChange, readOnly = false }: FieldProps<T>) {
  const v = value as string | number | boolean | null | undefined;
  const inputStyle = readOnly
    ? { ...styles.input, opacity: 0.65, cursor: 'not-allowed' }
    : styles.input;
  // AC-52.19 — short fields surface help as a hover tooltip; medium / full
  // continue to show inline help text. `short` columns are too narrow for
  // multi-line wrapping help text without crowding the layout.
  const helpAsTooltip = schema.width === 'short';
  const titleAttr = helpAsTooltip ? schema.help : undefined;
  const showInlineHelp = schema.help && !helpAsTooltip;
  return (
    <label style={styles.field}>
      <span style={styles.fieldLabel}>
        {schema.label}
        {schema.required && <span style={{ color: 'var(--danger)' }}> *</span>}
        {/* "(auto)" marker reserved for fields with a `derive` rule. Static-
            from-API fields are silently read-only (visually muted via input
            opacity); they're not derived, so labelling them "auto" misleads. */}
      </span>
      {schema.kind === 'text' && (
        <input
          type="text"
          value={(v as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          readOnly={readOnly}
          title={titleAttr}
          placeholder={schema.placeholder}
          style={inputStyle}
        />
      )}
      {schema.kind === 'url' && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
          <input
            type="url"
            value={(v as string) ?? ''}
            onChange={(e) => onChange(e.target.value)}
            readOnly={readOnly}
            style={{ ...inputStyle, flex: 1 }}
          />
          {(() => {
            const safe = sanitizeUrl((v as string) ?? '');
            return safe ? (
              <a
                href={safe}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '0 10px',
                  border: '1px solid var(--border)',
                  borderRadius: 3,
                  color: 'var(--accent)',
                  textDecoration: 'none',
                  fontSize: 12,
                  whiteSpace: 'nowrap',
                }}
                onClick={(e) => e.stopPropagation()}
              >
                ↗ Open
              </a>
            ) : null;
          })()}
        </div>
      )}
      {schema.kind === 'textarea' && (
        <textarea
          value={(v as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={schema.placeholder}
          readOnly={readOnly}
          style={{ ...inputStyle, minHeight: 96, fontFamily: 'monospace' }}
        />
      )}
      {schema.kind === 'number' && (
        <input
          type="number"
          value={(v as number) ?? 0}
          onChange={(e) => onChange(Number(e.target.value))}
          readOnly={readOnly}
          title={titleAttr}
          // AC-52.41 — forward range/step constraints from the schema so
          // browser-native validation kicks in (Weight 0..5 step 0.05).
          {...(schema.min !== undefined ? { min: schema.min } : {})}
          {...(schema.max !== undefined ? { max: schema.max } : {})}
          {...(schema.step !== undefined ? { step: schema.step } : {})}
          style={inputStyle}
        />
      )}
      {schema.kind === 'slider' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="range"
            min={schema.min ?? 0}
            max={schema.max ?? 1}
            step={schema.step ?? 0.05}
            value={Number(v ?? 0)}
            onChange={(e) => onChange(Number(e.target.value))}
            disabled={readOnly}
            style={{ flex: 1 }}
          />
          <output style={{ minWidth: 50, textAlign: 'right' }}>
            {Number(v ?? 0).toFixed(2)}
          </output>
        </div>
      )}
      {schema.kind === 'select' && (
        <select
          value={String(v ?? '')}
          onChange={(e) => {
            const opt = schema.options?.find((o) => String(o.value) === e.target.value);
            onChange(opt?.value ?? e.target.value);
          }}
          disabled={readOnly}
          style={inputStyle}
        >
          {schema.options?.map((opt) => (
            <option key={String(opt.value)} value={String(opt.value)}>
              {opt.label}
            </option>
          ))}
        </select>
      )}
      {schema.kind === 'checkbox' && (
        <input
          type="checkbox"
          checked={Boolean(v)}
          onChange={(e) => onChange(e.target.checked)}
          disabled={readOnly}
        />
      )}
      {showInlineHelp && <span style={styles.help}>{schema.help}</span>}
    </label>
  );
}

/* AC-52.28..30 — token-driven, flat (radius 0), 2px borders, uppercase CTAs. */
const BTN_BASE: React.CSSProperties = {
  borderRadius: 0,
  padding: '6px 14px',
  cursor: 'pointer',
  fontFamily: 'var(--tk-font)',
  fontSize: 'var(--tk-fs-sm)',
  fontWeight: 'var(--tk-fw-bold)' as unknown as number,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'grid',
    gridTemplateColumns: '320px 1fr',
    gap: 16,
    height: '100%',
    position: 'relative',
  },
  list: {
    background: 'var(--tk-surface)',
    border: '2px solid var(--tk-border-soft)',
    borderRadius: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  listHeader: {
    padding: '8px 12px',
    borderBottom: '2px solid var(--tk-border-soft)',
    color: 'var(--tk-muted)',
    fontSize: 'var(--tk-fs-xs)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  newBtn: {
    ...BTN_BASE,
    background: 'var(--tk-accent)',
    color: 'var(--tk-accent-fg)',
    border: '2px solid var(--tk-border)',
    padding: '4px 10px',
  },
  ul: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    overflow: 'auto',
  },
  li: {
    padding: '8px 12px',
    borderBottom: '1px solid var(--tk-border-soft)',
    cursor: 'pointer',
    fontSize: 'var(--tk-fs-base)',
  },
  liSelected: {
    background: 'var(--tk-bg)',
    borderLeft: '3px solid var(--tk-accent)',
  },
  editor: {
    background: 'var(--tk-surface)',
    border: '2px solid var(--tk-border-soft)',
    borderRadius: 0,
    padding: 16,
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  editorHeader: {
    fontSize: 'var(--tk-fs-md)',
    fontWeight: 'var(--tk-fw-bold)' as unknown as number,
    borderBottom: '2px solid var(--tk-border-soft)',
    paddingBottom: 8,
  },
  fields: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  fieldset: {
    border: '2px solid var(--tk-border-soft)',
    borderRadius: 0,
    padding: '8px 12px 12px 12px',
    margin: 0,
  },
  legend: {
    padding: '0 6px',
    fontSize: 'var(--tk-fs-xs)',
    color: 'var(--tk-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  fieldGrid: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 12,
    // Align tops so a `help` slug under one field doesn't push siblings down.
    alignItems: 'flex-start',
  },
  gridSlot: {
    display: 'flex',
    flexDirection: 'column',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  fieldLabel: {
    fontSize: 'var(--tk-fs-xs)',
    color: 'var(--tk-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  input: {
    background: 'var(--tk-bg)',
    color: 'var(--tk-fg)',
    border: '2px solid var(--tk-border-soft)',
    borderRadius: 0,
    padding: '4px 6px',
    fontFamily: 'var(--tk-font)',
    fontSize: 'var(--tk-fs-sm)',
  },
  help: {
    fontSize: 'var(--tk-fs-xs)',
    color: 'var(--tk-muted)',
    fontStyle: 'italic',
  },
  actions: {
    display: 'flex',
    gap: 8,
    paddingTop: 8,
    borderTop: '2px solid var(--tk-border-soft)',
  },
  saveBtn: {
    ...BTN_BASE,
    background: 'var(--tk-accent)',
    color: 'var(--tk-accent-fg)',
    border: '2px solid var(--tk-border)',
  },
  cancelBtn: {
    ...BTN_BASE,
    background: 'transparent',
    color: 'var(--tk-fg)',
    border: '2px solid var(--tk-border-soft)',
  },
  deleteBtn: {
    ...BTN_BASE,
    background: 'transparent',
    color: 'var(--tk-danger)',
    border: '2px solid var(--tk-danger)',
    marginLeft: 'auto',
  },
  placeholder: {
    color: 'var(--tk-muted)',
    fontStyle: 'italic',
    padding: 24,
    textAlign: 'center',
  },
  toast: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    padding: '12px 16px',
    borderRadius: 0,
    border: '2px solid var(--tk-border)',
    minWidth: 240,
    cursor: 'pointer',
    fontSize: 'var(--tk-fs-sm)',
    fontFamily: 'var(--tk-font)',
  },
  toastSuccess: {
    background: 'var(--tk-success)',
    color: 'var(--tk-bg)',
  },
  toastError: {
    background: 'var(--tk-danger)',
    color: 'var(--tk-danger-fg)',
  },
};
