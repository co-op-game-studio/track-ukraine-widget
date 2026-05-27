/**
 * Audit / Recent Activity tab. FR-52 AC-52.5 + FR-58.
 *
 * Read-only feed of the latest audit_log rows from /api/admin/audit.
 * Shows actor, action, target, reason, before/after diff, trace ID.
 */
import { useEffect, useState } from 'react';
import { get, type FetchError } from '../fetcher';
import type { AuditFullItem } from '../types';

interface AuditResponse {
  items: (AuditFullItem & { reason?: string | null })[];
}

export function AuditTab() {
  const [items, setItems] = useState<AuditFullItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    get<AuditResponse>('/api/admin/audit?limit=100')
      .then((r) => {
        setItems(r.items ?? []);
        setError(null);
      })
      .catch((e: FetchError) => setError(e.detail ?? e.error))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ color: 'var(--muted)' }}>Loading audit log…</div>;
  if (error) return <div style={{ color: 'var(--danger)' }}>Audit error: {error}</div>;
  if (items.length === 0) return <div style={{ color: 'var(--muted)' }}>No audit entries yet.</div>;

  return (
    <div>
      <p style={{ color: 'var(--muted)', fontSize: 12 }}>
        Newest first. <code>before</code> / <code>after</code> snapshots are the full row state at
        the moment of the edit. Trace IDs correlate with structured Worker logs.
      </p>
      <ul style={styles.list}>
        {items.map((it) => (
          <li key={it.id} style={styles.item}>
            <div style={styles.head}>
              <span style={styles.actor}>{it.actor_email}</span>
              <span style={styles.action}>{it.action}</span>
              <span style={styles.target}>
                {it.target_table}
                {it.row_title ? ` · ${it.row_title}` : ` · ${it.row_id}`}
              </span>
              <span style={styles.when}>{relTime(it.created_at)}</span>
            </div>
            {it.reason && (
              <div style={styles.reason}>
                <strong>Reason:</strong> {it.reason}
              </div>
            )}
            {(it.before !== null || it.after !== null) && (
              <details style={styles.diff}>
                <summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>before / after</summary>
                <pre style={styles.pre}>{formatDiff(it.before, it.after)}</pre>
              </details>
            )}
            <div style={styles.trace}>
              trace: <code>{it.trace_id}</code>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return iso.slice(0, 10);
}

function formatDiff(before: unknown, after: unknown): string {
  return JSON.stringify({ before, after }, null, 2);
}

const styles: Record<string, React.CSSProperties> = {
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 12 },
  item: {
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    padding: 12,
    fontSize: 13,
  },
  head: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
    paddingBottom: 6,
    borderBottom: '1px solid var(--border)',
    marginBottom: 6,
  },
  actor: { color: 'var(--accent)', fontWeight: 600 },
  action: {
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: 3,
    padding: '1px 6px',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  target: { color: 'var(--fg)', flex: 1 },
  when: { color: 'var(--muted)', fontSize: 11 },
  reason: { padding: '6px 0', color: 'var(--fg)' },
  diff: { marginTop: 6 },
  pre: {
    background: 'var(--bg)',
    padding: 8,
    borderRadius: 3,
    fontSize: 11,
    overflowX: 'auto',
    margin: '6px 0 0 0',
  },
  trace: { color: 'var(--muted)', fontSize: 11, marginTop: 6 },
};
