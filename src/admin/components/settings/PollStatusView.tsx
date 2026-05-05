/**
 * Settings ▸ Poll status — system-wide health for the social poll loop.
 *
 * Read-only view of the per-handle status persisted by the poll endpoint and
 * cron worker. Filterable by status (errors only / all). Each row shows the
 * trace ID for the last attempt — copyable and ready to send to engineering.
 */
import { useCallback, useEffect, useState } from 'react';
import { get } from '../../fetcher';
import type { HandleStatusRow } from '../../types';

type Filter = 'all' | 'error' | 'ok';

export function PollStatusView() {
  const [items, setItems] = useState<HandleStatusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('error');

  const load = useCallback(() => {
    setLoading(true);
    const params = filter === 'all' ? '' : `?status=${filter}`;
    get<{ items: HandleStatusRow[] }>(`/api/admin/ingest/handle-status${params}`)
      .then((r) => setItems(r.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={S.root}>
      <div style={S.toolRow}>
        <h2 style={S.heading}>Poll status</h2>
        <span style={S.muted}>
          Per-handle health. Failures persist across cron ticks. Trace IDs let engineering find the exact failed attempt in logs.
        </span>
        <span style={{ flex: 1 }} />
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} style={S.select}>
          <option value="error">Failures only</option>
          <option value="ok">Healthy only</option>
          <option value="all">All handles</option>
        </select>
        <button type="button" onClick={load} style={S.tinyBtn}>↻ Refresh</button>
      </div>

      {loading && <div style={S.muted}>Loading…</div>}
      {!loading && items.length === 0 && filter === 'error' && (
        <div style={S.muted}>No failing handles 🎉</div>
      )}

      {items.map((h) => (
        <StatusRow key={h.handle_id} item={h} />
      ))}
    </div>
  );
}

function StatusRow({ item }: { item: HandleStatusRow }) {
  const status = item.last_poll_status;
  const isError = status === 'error';
  const isOk = status === 'ok';
  const accent = isError ? 'var(--tk-danger)' : isOk ? '#22c55e' : 'var(--tk-muted)';
  return (
    <div style={{ ...S.card, borderLeftColor: accent }}>
      <div style={S.cardHeader}>
        <span style={{ ...S.statusBadge, background: accent, color: '#fff' }}>
          {status ?? 'never tried'}
        </span>
        <span style={S.platform}>{item.platform}</span>
        <span style={S.handle}>@{item.handle}</span>
        {item.bioguide_id && (
          <a
            href={`#/people/${item.bioguide_id}`}
            target="_blank"
            rel="noopener noreferrer"
            style={S.bioguide}
          >
            {item.bioguide_id} ↗
          </a>
        )}
        <span style={{ flex: 1 }} />
        <span style={S.timeMeta}>
          last attempted: {relTime(item.last_poll_attempted_at)}
        </span>
        <span style={S.timeMeta}>
          last success: {item.last_polled_at ? relTime(item.last_polled_at) : 'never'}
        </span>
      </div>
      {isError && item.last_poll_error && (
        <div style={S.errorBox}>
          <div style={{ color: 'var(--tk-danger)', fontSize: 'var(--tk-fs-sm)' }}>
            {item.last_poll_error}
          </div>
          {item.last_poll_trace_id && (
            <CopyableTraceId traceId={item.last_poll_trace_id} />
          )}
        </div>
      )}
    </div>
  );
}

function CopyableTraceId({ traceId }: { traceId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(traceId).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
      }}
      title="Click to copy this trace ID. Send to engineering with a description of what happened."
      style={S.traceBtn}
    >
      <span style={{ color: 'var(--tk-muted)' }}>trace:</span>
      <span style={{ fontFamily: 'var(--tk-font-mono)' }}>{traceId}</span>
      <span style={{ color: copied ? '#22c55e' : 'var(--tk-muted)', fontSize: 'var(--tk-fs-xs)' }}>
        {copied ? '✓ copied' : '⧉'}
      </span>
    </button>
  );
}

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

const INPUT_BASE: React.CSSProperties = {
  background: 'var(--tk-bg)',
  color: 'var(--tk-fg)',
  border: '2px solid var(--tk-border-soft)',
  borderRadius: 0,
  padding: '6px 10px',
  fontFamily: 'var(--tk-font)',
  fontSize: 'var(--tk-fs-sm)',
};

const S: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 10 },
  toolRow: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  heading: { fontSize: 'var(--tk-fs-md)', fontWeight: 800, margin: 0 },
  muted: { color: 'var(--tk-muted)', fontSize: 'var(--tk-fs-sm)' },
  select: INPUT_BASE,
  tinyBtn: {
    ...INPUT_BASE,
    fontSize: 'var(--tk-fs-xs)',
    fontWeight: 700,
    textTransform: 'uppercase',
    cursor: 'pointer',
    padding: '2px 8px',
  },
  card: {
    border: '2px solid var(--tk-border-soft)',
    borderLeftWidth: 4,
    background: 'var(--tk-surface)',
    padding: '10px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  cardHeader: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  statusBadge: {
    fontSize: 'var(--tk-fs-xs)',
    padding: '2px 8px',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  platform: { fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' },
  handle: { fontWeight: 700, fontSize: 'var(--tk-fs-sm)' },
  bioguide: { fontFamily: 'var(--tk-font-mono)', fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-accent)', textDecoration: 'underline' },
  timeMeta: { fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)' },
  errorBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '8px 10px',
    background: 'var(--tk-bg)',
    border: '1px solid rgba(239,68,68,0.3)',
  },
  traceBtn: {
    ...INPUT_BASE,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    background: 'var(--tk-bg)',
    color: 'var(--tk-fg)',
    cursor: 'pointer',
    fontSize: 'var(--tk-fs-xs)',
    padding: '4px 8px',
    width: 'fit-content',
  },
};
