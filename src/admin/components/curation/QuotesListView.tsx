/**
 * Quotes list view — card-based browse/edit (replaces the old "All Quotes"
 * ResourceTab). Same visual treatment as Inbox cards so the funnel is obvious:
 * a card you saw in Inbox keeps the same shape after curation, just with a
 * score and tags layered on.
 *
 * Filtering: by person (typeahead), by direction, by tag.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, patch as patchApi, del as delApi } from '../../fetcher';
import { MocPicker, partyStyle } from '../MocPicker';
import type { MocEntry } from '../MocPicker';
import type { QuoteRow, TagRow } from '../../types';
import { Tag, TagPicker } from '../Tag';

export function QuotesListView({
  onNavigateToPerson,
}: {
  onNavigateToPerson: (bioguideId: string) => void;
}) {
  const [items, setItems] = useState<QuoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterPerson, setFilterPerson] = useState<MocEntry | null>(null);
  const [filterDirection, setFilterDirection] = useState<'all' | 'pro' | 'none' | 'anti'>('all');
  const [reload, setReload] = useState(0);

  // Bulk MoC metadata so we can render display names on each card.
  const [mocMap, setMocMap] = useState<Map<string, MocEntry>>(new Map());
  const mocFetchedRef = useRef(false);
  useEffect(() => {
    if (mocFetchedRef.current) return;
    mocFetchedRef.current = true;
    get<{ members: MocEntry[] }>('/api/admin/ingest/roster-meta')
      .then((r) => setMocMap(new Map(r.members.map((m) => [m.bioguideId, m]))))
      .catch(() => {});
  }, []);

  const loadQuotes = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filterPerson) params.set('bioguideId', filterPerson.bioguideId);
    params.set('limit', '100');
    get<{ items: QuoteRow[] }>(`/api/admin/quotes?${params}`)
      .then((r) => setItems(r.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [filterPerson]);

  useEffect(() => { loadQuotes(); }, [loadQuotes, reload]);

  const filtered = items.filter((q) => {
    if (filterDirection === 'pro' && q.direction !== 1) return false;
    if (filterDirection === 'anti' && q.direction !== -1) return false;
    if (filterDirection === 'none' && q.direction !== 0) return false;
    return true;
  });

  async function deleteQuote(id: string) {
    const reason = prompt('Why are you deleting this quote? (required — flows into audit log)');
    if (!reason || !reason.trim()) return;
    try {
      await delApi(`/api/admin/quotes/${id}?reason=${encodeURIComponent(reason.trim())}`);
      setReload((n) => n + 1);
    } catch (e) {
      alert(`Delete failed: ${errorMsg(e)}`);
    }
  }

  return (
    <div style={S.root}>
      {/* Filters */}
      <div style={S.toolRow}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <MocPicker
            value={filterPerson}
            onChange={setFilterPerson}
            placeholder="Filter by person (or leave blank for all)..."
          />
        </div>
        <select
          value={filterDirection}
          onChange={(e) => setFilterDirection(e.target.value as 'all' | 'pro' | 'none' | 'anti')}
          style={S.select}
        >
          <option value="all">All directions</option>
          <option value="pro">Pro-Ukraine only</option>
          <option value="none">No score impact</option>
          <option value="anti">Anti-Ukraine only</option>
        </select>
        <button type="button" onClick={() => setReload((n) => n + 1)} style={S.tinyBtn}>↻ Refresh</button>
      </div>

      {loading && <div style={S.muted}>Loading…</div>}
      <div style={S.muted}>{filtered.length} quote{filtered.length === 1 ? '' : 's'}</div>

      {filtered.map((q) => {
        const moc = mocMap.get(q.bioguide_id);
        const ps = moc ? partyStyle(moc.party) : null;
        return (
          <QuoteCard
            key={q.id}
            quote={q}
            moc={moc}
            partyAccent={ps?.accent ?? 'var(--tk-border-soft)'}
            onOpenPerson={() => onNavigateToPerson(q.bioguide_id)}
            onChanged={() => setReload((n) => n + 1)}
            onDelete={() => deleteQuote(q.id)}
          />
        );
      })}
    </div>
  );
}

/* ---------- card ---------- */

function QuoteCard({
  quote,
  moc,
  partyAccent,
  onOpenPerson,
  onChanged,
  onDelete,
}: {
  quote: QuoteRow;
  moc: MocEntry | undefined;
  partyAccent: string;
  onOpenPerson: () => void;
  onChanged: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div style={{ ...S.card, borderLeftColor: partyAccent }}>
      <div style={S.cardHeader}>
        {moc ? (
          <a
            href={`#/people/${quote.bioguide_id}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => { if (!(e.metaKey || e.ctrlKey || e.shiftKey)) { e.preventDefault(); onOpenPerson(); } }}
            style={{ ...S.personLink, color: partyAccent }}
          >
            {moc.displayName}
          </a>
        ) : (
          <span style={{ fontFamily: 'var(--tk-font-mono)', fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)' }}>
            {quote.bioguide_id}
          </span>
        )}
        <span style={S.kindBadge}>{quote.media_kind}</span>
        <ScoreBadge direction={quote.direction} weight={quote.weight} />
        {quote.quoted_at && <span style={S.date}>{quote.quoted_at}</span>}
        <span style={{ flex: 1 }} />
        <a href={quote.source_url} target="_blank" rel="noopener noreferrer" style={S.link}>view source ↗</a>
        <button type="button" onClick={() => setEditing(!editing)} style={S.tinyBtn}>{editing ? 'Cancel' : 'Edit'}</button>
        <button type="button" onClick={onDelete} style={{ ...S.tinyBtn, color: 'var(--tk-danger)' }}>Delete</button>
      </div>
      <div style={S.body}>
        {quote.body_text.length > 300 ? quote.body_text.slice(0, 300) + '…' : quote.body_text}
      </div>
      {quote.tags && quote.tags.length > 0 && (
        <div style={S.tagRow}>
          {quote.tags.map((t) => <Tag key={t.id} tag={t} size="xs" />)}
        </div>
      )}
      {quote.source_label && (
        <div style={{ fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)', fontStyle: 'italic' }}>
          {quote.source_label}
        </div>
      )}
      {editing && <InlineEditor quote={quote} onSaved={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} />}
    </div>
  );
}

function ScoreBadge({ direction, weight }: { direction: number; weight: number }) {
  const color = direction === 1 ? '#22c55e' : direction === -1 ? '#ef4444' : '#888';
  const label = direction === 0
    ? 'no score'
    : `${direction === 1 ? '+' : '-'}${Number(weight).toFixed(2)}`;
  return (
    <span style={{
      fontFamily: 'var(--tk-font-mono)',
      fontSize: 'var(--tk-fs-xs)',
      fontWeight: 700,
      padding: '2px 6px',
      background: color,
      color: '#fff',
    }}>
      {label}
    </span>
  );
}

type ScoreIntent = 'pro' | 'none' | 'anti';

function intentFromQuote(q: QuoteRow): ScoreIntent {
  if (q.direction === 1) return 'pro';
  if (q.direction === -1) return 'anti';
  return 'none';
}

function InlineEditor({ quote, onSaved, onCancel }: { quote: QuoteRow; onSaved: () => void; onCancel: () => void }) {
  const [allTags, setAllTags] = useState<TagRow[]>([]);
  const [tagIds, setTagIds] = useState<string[]>(quote.tags?.map((t) => t.id) ?? []);
  const [bodyText, setBodyText] = useState(quote.body_text);
  const [comment, setComment] = useState(quote.comment ?? '');
  // Affirmative scoring — same 3-button state machine as the Add Quote form.
  // "No score impact" pins weight to 0; pro/anti use the slider.
  const [scoreIntent, setScoreIntent] = useState<ScoreIntent>(intentFromQuote(quote));
  const [weight, setWeight] = useState<number>(quote.weight);
  // Reason flows into audit_log.reason — backend rejects PATCH/DELETE without it.
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<{ items: TagRow[] }>('/api/admin/tags').then((r) => setAllTags(r.items)).catch(() => {});
  }, []);

  function pickIntent(intent: ScoreIntent) {
    setScoreIntent(intent);
    if (intent === 'none') setWeight(0);
    else if (weight === 0) setWeight(3);
  }

  async function save() {
    if (!reason.trim()) {
      setError('Edit reason is required (flows into audit log).');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const direction = scoreIntent === 'pro' ? 1 : scoreIntent === 'anti' ? -1 : 0;
      const effWeight = scoreIntent === 'none' ? 0 : weight;
      await patchApi(`/api/admin/quotes/${quote.id}`, {
        body_text: bodyText,
        comment: comment || null,
        tag_ids: tagIds,
        direction,
        weight: effWeight,
        _reason: reason.trim(),
      });
      onSaved();
    } catch (e) {
      setError(errorMsg(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={S.editor}>
      <textarea value={bodyText} onChange={(e) => setBodyText(e.target.value)} rows={4} style={{ ...S.input, resize: 'vertical' as never }} />
      <input type="text" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Researcher note..." style={S.input} />

      {/* Scoring */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 700 }}>Score</span>
        {([
          ['pro', 'Pro-Ukraine', '#22c55e'],
          ['none', 'No score', '#888'],
          ['anti', 'Anti-Ukraine', '#ef4444'],
        ] as [ScoreIntent, string, string][]).map(([val, label, color]) => {
          const on = scoreIntent === val;
          return (
            <button
              key={val}
              type="button"
              onClick={() => pickIntent(val)}
              style={{
                padding: '4px 10px',
                background: on ? color : 'transparent',
                color: on ? '#fff' : 'var(--tk-fg)',
                border: `2px solid ${on ? color : 'var(--tk-border-soft)'}`,
                fontSize: 'var(--tk-fs-xs)',
                fontWeight: 700,
                textTransform: 'uppercase',
                cursor: 'pointer',
                borderRadius: 0,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {scoreIntent !== 'none' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 700, minWidth: 50 }}>Weight</span>
          <input
            type="range"
            min={0}
            max={5}
            step={0.25}
            value={weight}
            onChange={(e) => setWeight(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <span style={{
            fontFamily: 'var(--tk-font-mono)',
            fontSize: 'var(--tk-fs-sm)',
            fontWeight: 700,
            minWidth: 40,
            textAlign: 'right',
            color: weight >= 4 ? '#ef4444' : weight >= 2.5 ? '#eab308' : 'var(--tk-fg)',
          }}>
            {weight.toFixed(2)}
          </span>
        </div>
      )}

      {/* Tags — shared picker carries the inline-create UX */}
      <TagPicker
        available={allTags}
        selectedIds={tagIds}
        onChange={setTagIds}
        onTagCreated={(t) => setAllTags((prev) => [...prev, t])}
      />


      {/* Audit reason — required by backend on every update */}
      <input
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why are you editing this? (required — flows into audit log)"
        style={{ ...S.input, borderColor: reason.trim() ? 'var(--tk-border-soft)' : 'var(--tk-danger)' }}
      />

      {error && <div style={{ color: 'var(--tk-danger)', fontSize: 'var(--tk-fs-sm)' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={save} disabled={saving || !reason.trim()} style={{ ...S.actionBtn, opacity: (!reason.trim() || saving) ? 0.5 : 1 }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} style={{ ...S.tinyBtn, padding: '6px 14px' }}>Cancel</button>
      </div>
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

/* ---------- styles ---------- */

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
  toolRow: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  input: INPUT_BASE,
  select: { ...INPUT_BASE, minWidth: 160 },
  muted: { color: 'var(--tk-muted)', fontSize: 'var(--tk-fs-xs)' },
  card: {
    border: '2px solid var(--tk-border-soft)',
    borderLeftWidth: 4,
    background: 'var(--tk-surface)',
    padding: '10px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  cardHeader: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  personLink: { fontWeight: 700, fontSize: 'var(--tk-fs-sm)', textDecoration: 'underline', cursor: 'pointer' },
  kindBadge: {
    fontSize: 'var(--tk-fs-xs)',
    padding: '1px 6px',
    background: 'var(--tk-bg)',
    border: '1px solid var(--tk-border-soft)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    fontWeight: 700,
  },
  date: { fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)' },
  body: {
    fontSize: 'var(--tk-fs-sm)',
    color: 'var(--tk-fg)',
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  tagRow: { display: 'flex', flexWrap: 'wrap', gap: 4 },
  link: {
    color: 'var(--tk-accent)',
    textDecoration: 'underline',
    fontSize: 'var(--tk-fs-xs)',
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
  editor: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '8px',
    background: 'var(--tk-bg)',
    border: '1px solid var(--tk-border-soft)',
  },
};
