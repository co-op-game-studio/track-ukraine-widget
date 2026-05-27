/**
 * Settings ▸ Data Freshness — researcher-facing observation of the bill
 * corpus state.
 *
 * Per AC-59.8: shows research-relevant state ("is the data fresh enough to
 * curate today?") NOT operator state ("cron tick N", "job stalled"). The
 * `lw bills backfill` CLI in CI writes audit_log rows on every run; this
 * view reads those rows + the bills table and presents them as data-state.
 */
import { useCallback, useEffect, useState } from 'react';
import { get } from '../../fetcher';

interface FreshnessResponse {
  asOf: string;
  bills: {
    total: number;
    becameLaw: number;
    byCongress: Array<{ congress: number; n: number }>;
    byDirection: Array<{ direction: string; n: number }>;
  };
  freshness: {
    within24h: number;
    within7d: number;
    within30d: number;
    stale: number;
  };
  staleBills: Array<{ bill_id: string; title: string; last_freshness_check_at: string | null }>;
  lastRefreshAttempt: { created_at: string; actor_email: string; trace_id: string } | null;
}

export function DataFreshnessView() {
  const [data, setData] = useState<FreshnessResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    get<FreshnessResponse>('/api/admin/data-freshness')
      .then(setData)
      .catch((e: { error?: string; detail?: string }) => setErr(e.detail ?? e.error ?? 'failed to load'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={S.root}>
      <div style={S.toolRow}>
        <h2 style={S.heading}>Data freshness</h2>
        <span style={S.muted}>
          Bill corpus state. Refresh runs are scheduled by CI (`lw bills backfill`); this is the read-only view of what the data looks like right now.
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={load} style={S.tinyBtn}>↻ Refresh</button>
      </div>

      {loading && <div style={S.muted}>Loading…</div>}
      {err && <div style={S.err}>Error: {err}</div>}
      {!loading && !err && data && (
        <>
          <Section title="Corpus">
            <KV k="Total bills" v={String(data.bills.total)} />
            <KV k="Became law" v={`${data.bills.becameLaw} of ${data.bills.total}`} />
          </Section>

          <Section title="By congress">
            {data.bills.byCongress.map((r) => (
              <KV key={r.congress} k={`${r.congress}th`} v={String(r.n)} />
            ))}
          </Section>

          <Section title="By direction">
            {data.bills.byDirection.map((r) => (
              <KV key={r.direction} k={r.direction} v={String(r.n)} />
            ))}
          </Section>

          <Section title="Last refreshed">
            <KV k="Within 24h" v={String(data.freshness.within24h)} />
            <KV k="1–7 days ago" v={String(data.freshness.within7d)} />
            <KV k="7–30 days ago" v={String(data.freshness.within30d)} />
            <KV
              k="Older than 30 days"
              v={String(data.freshness.stale)}
              accent={data.freshness.stale > 0 ? 'warn' : undefined}
            />
          </Section>

          {data.lastRefreshAttempt && (
            <Section title="Last refresh attempt">
              <KV k="When" v={relTime(data.lastRefreshAttempt.created_at)} />
              <KV k="Actor" v={data.lastRefreshAttempt.actor_email} />
              <KV k="Trace" v={data.lastRefreshAttempt.trace_id} mono />
            </Section>
          )}

          {data.staleBills.length > 0 && (
            <Section title={`Stale bills (showing ${data.staleBills.length})`}>
              {data.staleBills.map((b) => (
                <div key={b.bill_id} style={S.staleRow}>
                  <span style={S.staleId}>{b.bill_id}</span>
                  <span style={S.staleTitle}>{b.title}</span>
                  <span style={S.muted}>
                    {b.last_freshness_check_at ? relTime(b.last_freshness_check_at) : 'never refreshed'}
                  </span>
                </div>
              ))}
            </Section>
          )}
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={S.section}>
      <div style={S.sectionTitle}>{title}</div>
      <div style={S.sectionBody}>{children}</div>
    </div>
  );
}

function KV({ k, v, mono, accent }: { k: string; v: string; mono?: boolean; accent?: 'warn' }) {
  return (
    <div style={S.kv}>
      <span style={S.kvKey}>{k}</span>
      <span style={{
        ...S.kvValue,
        ...(mono ? { fontFamily: 'var(--tk-font-mono)', fontSize: 'var(--tk-fs-xs)' } : {}),
        ...(accent === 'warn' ? { color: 'var(--tk-warn)' } : {}),
      }}>
        {v}
      </span>
    </div>
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

const S: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 14 },
  toolRow: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  heading: { fontSize: 'var(--tk-fs-md)', fontWeight: 800, margin: 0 },
  muted: { color: 'var(--tk-muted)', fontSize: 'var(--tk-fs-sm)' },
  err: { color: 'var(--tk-danger)', fontSize: 'var(--tk-fs-sm)' },
  tinyBtn: {
    background: 'var(--tk-bg)',
    color: 'var(--tk-fg)',
    border: '2px solid var(--tk-border-soft)',
    fontFamily: 'var(--tk-font)',
    fontSize: 'var(--tk-fs-xs)',
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    cursor: 'pointer',
    padding: '2px 8px',
    borderRadius: 0,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    border: '2px solid var(--tk-border-soft)',
    background: 'var(--tk-surface)',
  },
  sectionTitle: {
    padding: '6px 10px',
    fontSize: 'var(--tk-fs-xs)',
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    color: 'var(--tk-muted)',
    borderBottom: '2px solid var(--tk-border-soft)',
  },
  sectionBody: { display: 'flex', flexDirection: 'column' },
  kv: {
    display: 'flex',
    alignItems: 'center',
    padding: '4px 10px',
    fontSize: 'var(--tk-fs-sm)',
  },
  kvKey: { flex: 1, color: 'var(--tk-muted)' },
  kvValue: { fontWeight: 700 },
  staleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '4px 10px',
    fontSize: 'var(--tk-fs-sm)',
  },
  staleId: { fontFamily: 'var(--tk-font-mono)', fontSize: 'var(--tk-fs-xs)', minWidth: 110 },
  staleTitle: { flex: 1, color: 'var(--tk-fg)' },
};
