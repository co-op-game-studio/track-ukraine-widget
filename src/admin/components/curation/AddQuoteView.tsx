/**
 * Add Quote view — purpose-built form with affirmative scoring + tags + links.
 *
 * Scoring is a 3-button state machine (Pro / No score / Anti). Direction starts
 * unset (null) and the form refuses to save until the researcher picks one.
 * "No score" is a real published value (direction × weight = 0), not "I haven't
 * decided" — the explicit button distinguishes "reviewed but neutral" from
 * "untouched default."
 *
 * Tags come from the shared `tags` table (Settings ▸ Tags). Researchers pick
 * any number; they render as colored badges throughout the app.
 *
 * Ancillary links: optional list of {label, url} pairs for related coverage,
 * official statements, etc. Stored as JSON in `quotes.links_json`.
 *
 * Prefill: when the user clicks "Curate as Quote" on an Inbox card, the parent
 * passes a QuotePrefill via props; this view auto-fills the source fields and
 * marks the queue item curated when the quote saves.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, patch } from '../../fetcher';
import { MocPicker, partyStyle } from '../MocPicker';
import type { MocEntry } from '../MocPicker';
import type { QuotePrefill } from '../../App';
import type { QuoteRow, TagRow } from '../../types';
import { TagPicker } from '../Tag';

const SOURCE_TYPES: { value: string; label: string }[] = [
  { value: 'text',      label: 'Text / Written' },
  { value: 'news',      label: 'News article' },
  { value: 'social',    label: 'Social media post' },
  { value: 'video',     label: 'Video' },
  { value: 'audio',     label: 'Audio / Podcast' },
  { value: 'speech',    label: 'Floor speech / Hearing' },
  { value: 'press',     label: 'Press release' },
  { value: 'interview', label: 'Interview' },
  { value: 'image',     label: 'Image / Graphic' },
  { value: 'letter',    label: 'Letter / Op-ed' },
];

/** Affirmative scoring state. `null` blocks save; the others are real values. */
type ScoreIntent = null | 'pro' | 'none' | 'anti';

interface LinkEntry { label: string; url: string }

export function AddQuoteView({
  prefill,
  onPrefillConsumed,
}: {
  prefill?: QuotePrefill | null;
  onPrefillConsumed?: () => void;
}) {
  // Person
  const [selectedMoc, setSelectedMoc] = useState<MocEntry | null>(null);

  // Source
  const [sourceType, setSourceType] = useState('text');
  const [sourceName, setSourceName] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [quoteDate, setQuoteDate] = useState('');
  const [links, setLinks] = useState<LinkEntry[]>([]);

  // Content
  const [bodyText, setBodyText] = useState('');

  // Scoring (affirmative — null means "not chosen yet")
  const [scoreIntent, setScoreIntent] = useState<ScoreIntent>(null);
  const [weight, setWeight] = useState(3);
  const [comment, setComment] = useState('');

  // Tags
  const [allTags, setAllTags] = useState<TagRow[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);

  // State
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorTraceId, setErrorTraceId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [savedQuoteId, setSavedQuoteId] = useState<string | null>(null);

  // Originating queue item (when prefilled from Inbox).
  const [queueItemId, setQueueItemId] = useState<string | null>(null);

  // Bulk MoC metadata for the prefill auto-link.
  const [mocMap, setMocMap] = useState<Map<string, MocEntry>>(new Map());
  const mocFetchedRef = useRef(false);
  useEffect(() => {
    if (mocFetchedRef.current) return;
    mocFetchedRef.current = true;
    get<{ members: MocEntry[] }>('/api/admin/ingest/roster-meta')
      .then((r) => {
        const map = new Map<string, MocEntry>();
        for (const m of r.members) map.set(m.bioguideId, m);
        setMocMap(map);
      })
      .catch(() => {});
  }, []);

  // Load tags on mount.
  const loadTags = useCallback(() => {
    get<{ items: TagRow[] }>('/api/admin/tags')
      .then((r) => setAllTags(r.items))
      .catch(() => {});
  }, []);
  useEffect(() => { loadTags(); }, [loadTags]);

  // Apply prefill from Curation > Inbox "Curate as Quote".
  //
  // Split into two effects so the auto-link survives the mocMap race:
  //   1. Apply non-person fields ONCE per queueItemId (gated by ref).
  //   2. Resolve the person whenever mocMap fills in OR pendingBioguide is set.
  // This fixes the bug where opening Inbox → Curate before /roster-meta
  // resolved would leave Person empty even though the queue item had a
  // bioguide_id.
  const prefillApplied = useRef<string | null>(null);
  const [pendingBioguide, setPendingBioguide] = useState<string | null>(null);

  useEffect(() => {
    if (!prefill || prefillApplied.current === prefill.queueItemId) return;
    prefillApplied.current = prefill.queueItemId;
    setSourceType(prefill.mediaKind || 'social');
    setSourceName(prefill.sourceLabel || '');
    setSourceUrl(prefill.sourceUrl || '');
    setQuoteDate(prefill.quotedAt ? prefill.quotedAt.slice(0, 10) : '');
    setBodyText(prefill.bodyText || '');
    setQueueItemId(prefill.queueItemId);
    setSaved(false);
    setSavedQuoteId(null);
    setError(null);
    setScoreIntent(null);
    setWeight(3);
    setComment('');
    setSelectedTagIds([]);
    setLinks([]);
    setSelectedMoc(null);
    setPendingBioguide(prefill.bioguideId ?? null);
    onPrefillConsumed?.();
  }, [prefill, onPrefillConsumed]);

  // Auto-link the person once mocMap has loaded. Re-runs every time mocMap
  // changes — the resolve effect above only sets pendingBioguide, this one
  // performs the lookup. Clears pending once the entry is found so we don't
  // override a manual MoC change.
  useEffect(() => {
    if (!pendingBioguide) return;
    if (mocMap.size === 0) return; // /roster-meta hasn't returned yet
    const entry = mocMap.get(pendingBioguide);
    if (entry) {
      setSelectedMoc(entry);
      setPendingBioguide(null);
    }
  }, [pendingBioguide, mocMap]);

  function isValidUrl(s: string): boolean {
    try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
  }

  function pickIntent(intent: 'pro' | 'none' | 'anti') {
    setScoreIntent(intent);
    if (intent === 'none') setWeight(0);
    else if (weight === 0) setWeight(3);
  }

  function addLink() {
    setLinks([...links, { label: '', url: '' }]);
  }
  function updateLink(i: number, patch: Partial<LinkEntry>) {
    setLinks(links.map((l, idx) => idx === i ? { ...l, ...patch } : l));
  }
  function removeLink(i: number) {
    setLinks(links.filter((_, idx) => idx !== i));
  }

  async function saveQuote() {
    setError(null);
    setErrorTraceId(null);

    if (!selectedMoc) { setError('Select a person'); return; }
    if (!bodyText.trim()) { setError('Quote text is required'); return; }
    if (!sourceUrl.trim()) { setError('Source URL is required'); return; }
    if (!isValidUrl(sourceUrl.trim())) { setError('Source URL must be a valid https:// URL'); return; }
    if (scoreIntent === null) {
      setError('Pick a scoring intent: Pro, No score impact, or Anti.');
      return;
    }

    // Validate links: drop empty rows, require a URL on the rest.
    const cleanedLinks = links
      .map((l) => ({ label: l.label.trim(), url: l.url.trim() }))
      .filter((l) => l.label || l.url);
    for (const l of cleanedLinks) {
      if (!l.url || !isValidUrl(l.url)) {
        setError(`Link "${l.label || '(unnamed)'}" must have a valid URL`);
        return;
      }
    }

    const direction = scoreIntent === 'pro' ? 1 : scoreIntent === 'anti' ? -1 : 0;
    const effWeight = scoreIntent === 'none' ? 0 : weight;

    setSaving(true);
    try {
      const r = await post<{ row: QuoteRow }>('/api/admin/quotes', {
        bioguide_id: selectedMoc.bioguideId,
        media_kind: sourceType,
        source_url: sourceUrl.trim(),
        source_label: sourceName.trim() || null,
        quoted_at: quoteDate.trim() || null,
        body_text: bodyText.trim(),
        weight: effWeight,
        direction,
        comment: comment.trim() || null,
        links: cleanedLinks.length ? cleanedLinks : null,
        tag_ids: selectedTagIds,
      });
      setSaved(true);
      setSavedQuoteId(r.row?.id ?? null);
      if (queueItemId) {
        patch(`/api/admin/ingest/queue/${queueItemId}`, { status: 'curated' }).catch(() => {});
        setQueueItemId(null);
      }
    } catch (e) {
      setError(errorMsg(e));
      setErrorTraceId(errorTraceIdOf(e));
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setSelectedMoc(null);
    setSourceType('text');
    setSourceName('');
    setSourceUrl('');
    setQuoteDate('');
    setBodyText('');
    setWeight(3);
    setScoreIntent(null);
    setComment('');
    setSelectedTagIds([]);
    setLinks([]);
    setQueueItemId(null);
    setSaved(false);
    setSavedQuoteId(null);
    setError(null);
    setErrorTraceId(null);
  }

  function resetKeepPerson() {
    setSourceType('text');
    setSourceName('');
    setSourceUrl('');
    setQuoteDate('');
    setBodyText('');
    setWeight(3);
    setScoreIntent(null);
    setComment('');
    setSelectedTagIds([]);
    setLinks([]);
    setSaved(false);
    setSavedQuoteId(null);
    setError(null);
    setErrorTraceId(null);
  }

  const ps = selectedMoc ? partyStyle(selectedMoc.party) : null;

  // Save button label reflects the math.
  const saveLabel = (() => {
    if (scoreIntent === null) return 'Publish quote';
    if (scoreIntent === 'none') return 'Publish quote (no score impact)';
    const sign = scoreIntent === 'pro' ? '+' : '-';
    return `Publish quote (${sign}${weight.toFixed(2)})`;
  })();

  return (
    <div style={S.section}>
      {saved && (
        <div style={{ ...S.formBox, borderColor: '#22c55e', borderLeftWidth: 4, borderLeftColor: '#22c55e' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: '#22c55e', fontWeight: 700, fontSize: 16 }}>Saved</span>
            <span style={{ fontSize: 'var(--tk-fs-sm)', color: 'var(--tk-fg)' }}>
              Quote saved for <strong>{selectedMoc?.displayName}</strong>
              {scoreIntent === 'none'
                ? ' with no score impact'
                : ` with weight ${weight.toFixed(2)} (${scoreIntent === 'pro' ? 'pro' : 'anti'}-Ukraine)`}
            </span>
          </div>
          {savedQuoteId && (
            <span style={{ color: 'var(--tk-muted)', fontFamily: 'var(--tk-font-mono)', fontSize: 'var(--tk-fs-xs)' }}>
              ID: {savedQuoteId}
            </span>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button type="button" onClick={reset} style={S.actionBtn}>Add another</button>
            <button type="button" onClick={resetKeepPerson} style={{ ...S.actionBtn, background: 'var(--tk-surface)', color: 'var(--tk-fg)', border: '2px solid var(--tk-border-soft)' }}>
              Same person, new quote
            </button>
          </div>
        </div>
      )}

      {!saved && (
        <div style={{
          ...S.formBox,
          borderColor: ps ? ps.accent : 'var(--tk-border-soft)',
          borderLeftWidth: 4,
          borderLeftColor: ps ? ps.accent : 'var(--tk-border-soft)',
        }}>
          {/* Person */}
          <div style={S.groupHeader}>Person</div>
          <MocPicker value={selectedMoc} onChange={setSelectedMoc} placeholder="Search for a member of Congress..." />

          {/* Source */}
          <div style={S.groupHeader}>Source</div>
          <div style={S.row}>
            <Field label="Source type" style={{ minWidth: 160 }}>
              <select value={sourceType} onChange={(e) => setSourceType(e.target.value)} style={S.select}>
                {SOURCE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
            <Field label="Source name" style={{ flex: 1, minWidth: 200 }}>
              <input
                type="text"
                value={sourceName}
                onChange={(e) => setSourceName(e.target.value)}
                placeholder='e.g. "C-SPAN", "Reuters", "@RepJohnDoe"'
                style={S.input}
              />
            </Field>
          </div>
          <div style={S.row}>
            <Field label="Source URL (required)" style={{ flex: 1 }}>
              <input
                type="url"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://..."
                style={S.input}
              />
            </Field>
            <Field label="Date" style={{ minWidth: 180 }}>
              <input type="date" value={quoteDate} onChange={(e) => setQuoteDate(e.target.value)} style={S.input} />
            </Field>
          </div>

          {/* Ancillary links */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={S.fieldLabel}>Ancillary links (optional)</span>
            <button type="button" onClick={addLink} style={S.tinyBtn}>+ Add link</button>
          </div>
          {links.map((l, i) => (
            <div key={i} style={S.row}>
              <input
                type="text"
                value={l.label}
                onChange={(e) => updateLink(i, { label: e.target.value })}
                placeholder="Label (e.g. official statement)"
                style={{ ...S.input, minWidth: 200 }}
              />
              <input
                type="url"
                value={l.url}
                onChange={(e) => updateLink(i, { url: e.target.value })}
                placeholder="https://..."
                style={{ ...S.input, flex: 1 }}
              />
              <button type="button" onClick={() => removeLink(i)} style={S.tinyBtn}>×</button>
            </div>
          ))}

          {/* Quote text */}
          <div style={S.groupHeader}>Quote</div>
          <textarea
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            placeholder="Paste or type the quote text here..."
            rows={5}
            style={{ ...S.input, resize: 'vertical' as never, minHeight: 100 }}
          />

          {/* Scoring — affirmative state machine */}
          <div style={S.groupHeader}>
            Scoring
            <span style={S.helpInline} title="Required. Pick Pro/Anti to score, or No score impact for reviewed-but-neutral quotes (saves direction × weight = 0).">?</span>
          </div>
          <div style={S.row}>
            <ScoreButton
              label="Pro-Ukraine"
              color="#22c55e"
              active={scoreIntent === 'pro'}
              onClick={() => pickIntent('pro')}
            />
            <ScoreButton
              label="No score impact"
              color="#888"
              active={scoreIntent === 'none'}
              onClick={() => pickIntent('none')}
            />
            <ScoreButton
              label="Anti-Ukraine"
              color="#ef4444"
              active={scoreIntent === 'anti'}
              onClick={() => pickIntent('anti')}
            />
          </div>

          {scoreIntent !== null && scoreIntent !== 'none' && (
            <div style={S.row}>
              <span style={{ fontSize: 'var(--tk-fs-sm)', color: 'var(--tk-muted)', minWidth: 70 }}>Weight</span>
              <input
                type="range"
                min={0}
                max={5}
                step={0.25}
                value={weight}
                onChange={(e) => setWeight(Number(e.target.value))}
                style={{ flex: 1, accentColor: ps?.accent ?? 'var(--tk-accent)' }}
              />
              <span style={{
                fontFamily: 'var(--tk-font-mono)',
                fontSize: 'var(--tk-fs-sm)',
                fontWeight: 700,
                color: weight >= 4 ? '#ef4444' : weight >= 2.5 ? '#eab308' : 'var(--tk-fg)',
                minWidth: 40,
                textAlign: 'right',
              }}>
                {weight.toFixed(2)}
              </span>
              <span style={{ fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)' }}>
                {weight >= 4 ? 'CRITICAL' : weight >= 2.5 ? 'HIGH' : weight >= 1 ? 'MEDIUM' : 'LOW'}
              </span>
            </div>
          )}

          {/* Tags */}
          <div style={S.groupHeader}>Tags</div>
          <TagPicker
            available={allTags}
            selectedIds={selectedTagIds}
            onChange={setSelectedTagIds}
            onTagCreated={(t) => setAllTags((prev) => [...prev, t])}
          />

          {/* Researcher note */}
          <Field label="Researcher note (optional — visible in embed)">
            <input
              type="text"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Context or analysis for this quote..."
              style={S.input}
            />
          </Field>

          {error && (
            <div style={S.error}>
              {error}
              {errorTraceId && (
                <span style={{ marginLeft: 8, fontFamily: 'var(--tk-font-mono)', fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)' }}>
                  trace: {errorTraceId}
                </span>
              )}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 4 }}>
            <button
              type="button"
              onClick={reset}
              style={{ ...S.actionBtn, background: 'var(--tk-surface)', color: 'var(--tk-fg)', border: '2px solid var(--tk-border-soft)' }}
            >
              Clear
            </button>
            <button
              type="button"
              onClick={saveQuote}
              disabled={saving || !selectedMoc || scoreIntent === null}
              style={{
                ...S.actionBtn,
                background: scoreIntent === 'pro' ? '#22c55e' : scoreIntent === 'anti' ? '#ef4444' : scoreIntent === 'none' ? '#888' : 'var(--tk-accent)',
                borderColor: scoreIntent === 'pro' ? '#22c55e' : scoreIntent === 'anti' ? '#ef4444' : scoreIntent === 'none' ? '#888' : 'var(--tk-accent)',
                opacity: (!selectedMoc || saving || scoreIntent === null) ? 0.5 : 1,
              }}
            >
              {saving ? 'Saving...' : saveLabel}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- helpers ---------- */

function ScoreButton({ label, color, active, onClick }: { label: string; color: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...S.actionBtn,
        background: active ? color : 'var(--tk-surface)',
        color: active ? '#fff' : 'var(--tk-fg)',
        border: `2px solid ${active ? color : 'var(--tk-border-soft)'}`,
        padding: '6px 14px',
        fontSize: 'var(--tk-fs-sm)',
      }}
    >
      {label}
    </button>
  );
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

function errorTraceIdOf(e: unknown): string | null {
  if (typeof e === 'object' && e !== null) {
    const obj = e as Record<string, unknown>;
    if (typeof obj.traceId === 'string') return obj.traceId;
  }
  return null;
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
  section: { display: 'flex', flexDirection: 'column', gap: 10 },
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  input: INPUT_BASE,
  select: { ...INPUT_BASE, minWidth: 140 },
  fieldLabel: {
    fontSize: 'var(--tk-fs-xs)',
    color: 'var(--tk-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    fontWeight: 700,
  },
  groupHeader: {
    fontSize: 'var(--tk-fs-xs)',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: 'var(--tk-muted)',
    borderBottom: '1px solid var(--tk-border-soft)',
    paddingBottom: 4,
    marginTop: 4,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  helpInline: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 16,
    height: 16,
    borderRadius: '50%',
    border: '1px solid var(--tk-muted)',
    fontSize: 10,
    fontWeight: 700,
    cursor: 'help',
    color: 'var(--tk-muted)',
  },
  formBox: {
    padding: '12px 16px',
    border: '2px solid var(--tk-border-soft)',
    background: 'var(--tk-surface)',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  actionBtn: {
    ...INPUT_BASE,
    background: 'var(--tk-accent)',
    color: 'var(--tk-accent-fg)',
    border: '2px solid var(--tk-border)',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    padding: '6px 14px',
  },
  tinyBtn: {
    ...INPUT_BASE,
    background: 'var(--tk-surface)',
    color: 'var(--tk-fg)',
    border: '2px solid var(--tk-border-soft)',
    fontSize: 'var(--tk-fs-xs)',
    fontWeight: 700,
    textTransform: 'uppercase',
    cursor: 'pointer',
    padding: '2px 8px',
  },
  error: { color: 'var(--tk-danger)', fontSize: 'var(--tk-fs-sm)' },
};
