/**
 * Admin ▸ API quota (FR-62).
 *
 * Read-only gauge of upstream API headroom. The numbers are ESTIMATES derived
 * from recent sync/seed activity, not a precise counter — the UI labels them
 * "est." so operators don't mistake them for exact remaining-quota figures.
 *
 * Backed by GET /api/admin/api-usage. Admin-gated (FR-61).
 */
import { useCallback, useEffect, useState } from 'react';
import { get } from '../../fetcher';

interface UpstreamUsage {
  upstream: 'youtube' | 'congress';
  configured: boolean;
  dailyLimit: number | null;
  limitUnit: 'units' | 'requests';
  estimatedUsed24h: number;
  estimate: boolean;
  lastRateLimitAt: string | null;
  lastRateLimitKind: 'quota' | 'transient' | null;
}

interface UsageReport {
  asOf: string;
  upstreams: UpstreamUsage[];
}

const UPSTREAM_LABEL: Record<string, string> = {
  youtube: 'YouTube Data API',
  congress: 'Congress.gov API',
};

export function ApiUsageView() {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    get<UsageReport>('/api/admin/api-usage')
      .then(setReport)
      .catch((e: unknown) => setError(String((e as { detail?: string }).detail ?? e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load, reload]);

  return (
    <div style={S.root}>
      <div style={S.headerRow}>
        <h2 style={S.heading}>API quota</h2>
        <span style={S.muted}>
          Estimated upstream API headroom over the last 24h. Figures are estimates from recent
          activity, not an exact counter.
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => setReload((n) => n + 1)} style={S.tinyBtn}>↻ Refresh</button>
      </div>

      {loading && <div style={S.muted}>Loading…</div>}
      {error && <div style={{ color: 'var(--tk-danger)' }}>{error}</div>}

      {report && report.upstreams.map((u) => <UpstreamGauge key={u.upstream} u={u} />)}
    </div>
  );
}

function UpstreamGauge({ u }: { u: UpstreamUsage }) {
  const label = UPSTREAM_LABEL[u.upstream] ?? u.upstream;

  if (!u.configured) {
    return (
      <div style={S.card}>
        <div style={S.cardHead}>
          <span style={S.upstreamName}>{label}</span>
          <span style={{ flex: 1 }} />
          <span style={S.notConfigured}>not configured</span>
        </div>
      </div>
    );
  }

  const limit = u.dailyLimit ?? 0;
  const pct = limit > 0 ? Math.min(100, Math.round((u.estimatedUsed24h / limit) * 100)) : 0;
  // Green under 60%, amber under 85%, red above.
  const barColor = pct < 60 ? 'var(--tk-success)' : pct < 85 ? '#b58900' : 'var(--tk-danger)';

  return (
    <div style={S.card}>
      <div style={S.cardHead}>
        <span style={S.upstreamName}>{label}</span>
        <span style={{ flex: 1 }} />
        <span style={S.usageText}>
          ~{u.estimatedUsed24h.toLocaleString()} <span style={S.estTag}>est.</span> / {limit.toLocaleString()} {u.limitUnit}/day
        </span>
      </div>
      <div style={S.track} title={`~${pct}% of the daily ${u.limitUnit} budget (estimated)`}>
        <div style={{ ...S.fill, width: `${pct}%`, background: barColor }} />
      </div>
      <div style={S.cardFoot}>
        <span style={S.muted}>~{pct}% used (est.)</span>
        <span style={{ flex: 1 }} />
        {u.lastRateLimitAt ? (
          <span style={{ color: 'var(--tk-danger)' }}>
            Last rate-limit ({u.lastRateLimitKind ?? 'unknown'}): {fmtTime(u.lastRateLimitAt)}
          </span>
        ) : (
          <span style={S.muted}>No rate-limit hits in the last 24h</span>
        )}
      </div>
    </div>
  );
}

function fmtTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString();
}

const S: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 12 },
  headerRow: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  heading: { fontSize: 'var(--tk-fs-md)', fontWeight: 800, margin: 0 },
  muted: { color: 'var(--tk-muted)', fontSize: 'var(--tk-fs-sm)' },
  tinyBtn: {
    background: 'var(--tk-bg)', color: 'var(--tk-fg)',
    border: '2px solid var(--tk-border-soft)', borderRadius: 0,
    fontSize: 'var(--tk-fs-xs)', fontWeight: 700, textTransform: 'uppercase',
    cursor: 'pointer', padding: '2px 8px',
  },
  card: {
    border: '2px solid var(--tk-border-soft)', background: 'var(--tk-surface)',
    padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8,
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  upstreamName: { fontWeight: 800, fontSize: 'var(--tk-fs-sm)', textTransform: 'uppercase', letterSpacing: '0.04em' },
  usageText: { fontFamily: 'var(--tk-font-mono)', fontSize: 'var(--tk-fs-sm)', fontWeight: 700 },
  estTag: { color: 'var(--tk-muted)', fontWeight: 400, fontStyle: 'italic' },
  notConfigured: { color: 'var(--tk-muted)', fontStyle: 'italic', fontSize: 'var(--tk-fs-sm)' },
  track: { height: 12, background: 'var(--tk-bg)', border: '1px solid var(--tk-border-soft)' },
  fill: { height: '100%' },
  cardFoot: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 'var(--tk-fs-xs)' },
};
