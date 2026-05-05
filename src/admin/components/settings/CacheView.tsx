/**
 * Admin ▸ Cache — KV cache inspection + purge.
 *
 * Backed by `/api/admin/cache` (GET overview, GET <slug>, POST <slug>,
 * DELETE <slug>/<key>). Operator surface for the KV records the publish
 * pipeline + the read-through fills produce — when curated data has
 * drifted (a re-published bill that won't shake loose, a member profile
 * with stale photo URL, a stats record that didn't pick up the latest
 * partyPriors overlay), the operator can purge from here instead of
 * waiting for TTL expiry.
 *
 * Every purge requires a reason that flows into the structured log
 * (`admin.cache.purge_prefix` / `admin.cache.purge_key`) — same audit
 * posture as D1 mutations.
 *
 * Traces: FR-58 (cache control surface), AC-58.5 / AC-51.7 (cache-key
 * invalidation explicit operator surface).
 */
import { useCallback, useEffect, useState } from 'react';
import { get, post, del as delApi } from '../../fetcher';

interface PrefixSummary {
  slug: string;
  prefix: string;
  description: string;
  ttlSec: number;
  approxCount: number;
  truncated: boolean;
}

interface PrefixDetail {
  slug: string;
  prefix: string;
  description: string;
  ttlSec: number;
  keys: string[];
  truncated: boolean;
}

export function CacheView() {
  const [overview, setOverview] = useState<PrefixSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    get<{ prefixes: PrefixSummary[] }>('/api/admin/cache')
      .then((r) => setOverview(r.prefixes))
      .catch((e: unknown) => {
        setError(typeof e === 'object' && e !== null ? String((e as { detail?: string }).detail ?? e) : String(e));
        setOverview(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load, reload]);

  return (
    <div style={S.root}>
      <div style={S.headerRow}>
        <h2 style={S.heading}>Cache</h2>
        <span style={S.muted}>
          KV records produced by the publish pipeline + Worker read-throughs.
          Counts are page-capped (5 pages × 1k = 5k); larger prefixes show "truncated".
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => setReload((n) => n + 1)} style={S.tinyBtn}>↻ Refresh</button>
      </div>

      {loading && <div style={S.muted}>Loading…</div>}
      {error && <div style={{ color: 'var(--tk-danger)' }}>{error}</div>}

      {overview && overview.map((p) => (
        <PrefixRow
          key={p.slug}
          summary={p}
          expanded={expandedSlug === p.slug}
          onToggle={() => setExpandedSlug(expandedSlug === p.slug ? null : p.slug)}
          onChanged={() => setReload((n) => n + 1)}
        />
      ))}
    </div>
  );
}

function PrefixRow({
  summary,
  expanded,
  onToggle,
  onChanged,
}: {
  summary: PrefixSummary;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  return (
    <div style={S.card}>
      <div style={S.cardHeader} onClick={onToggle}>
        <span style={S.slug}>{summary.slug}</span>
        <span style={{ ...S.kvKey, color: 'var(--tk-muted)' }}>{summary.prefix}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--tk-font-mono)', fontWeight: 700 }}>
          {summary.approxCount}{summary.truncated ? '+' : ''} keys
        </span>
        {summary.ttlSec > 0 && (
          <span style={S.muted}>TTL {Math.round(summary.ttlSec / 86400)}d</span>
        )}
        <span style={{ color: 'var(--tk-muted)' }}>{expanded ? '▾' : '▸'}</span>
      </div>
      <div style={{ fontSize: 'var(--tk-fs-sm)', color: 'var(--tk-muted)', padding: '0 12px 8px 12px' }}>
        {summary.description}
      </div>
      {expanded && (
        <PrefixDetail slug={summary.slug} onChanged={onChanged} />
      )}
    </div>
  );
}

function PrefixDetail({ slug, onChanged }: { slug: string; onChanged: () => void }) {
  const [detail, setDetail] = useState<PrefixDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [purging, setPurging] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    get<PrefixDetail>(`/api/admin/cache/${slug}`)
      .then(setDetail)
      .catch((e: unknown) => setError(String((e as { detail?: string }).detail ?? e)))
      .finally(() => setLoading(false));
  }, [slug]);

  async function purgeAll() {
    const reason = prompt(`Purge ALL keys under "${slug}"? This cannot be undone. Why?`);
    if (!reason || !reason.trim()) return;
    setPurging(true);
    try {
      const r = await post<{ purged: number }>(`/api/admin/cache/${slug}`, { _reason: reason.trim() });
      alert(`Purged ${r.purged} keys.`);
      onChanged();
    } catch (e: unknown) {
      alert(`Purge failed: ${String((e as { detail?: string }).detail ?? e)}`);
    } finally {
      setPurging(false);
    }
  }

  async function purgeOne(fullKey: string) {
    const tail = fullKey.replace(detail?.prefix ?? '', '');
    const reason = prompt(`Purge "${fullKey}"? Why?`);
    if (!reason || !reason.trim()) return;
    try {
      await delApi(`/api/admin/cache/${slug}/${encodeURIComponent(tail)}?reason=${encodeURIComponent(reason.trim())}`);
      onChanged();
    } catch (e: unknown) {
      alert(`Purge failed: ${String((e as { detail?: string }).detail ?? e)}`);
    }
  }

  return (
    <div style={S.detailWrap}>
      {loading && <div style={S.muted}>Loading keys…</div>}
      {error && <div style={{ color: 'var(--tk-danger)' }}>{error}</div>}
      {detail && (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={S.muted}>Showing {detail.keys.length} key{detail.keys.length === 1 ? '' : 's'}{detail.truncated ? ' (truncated; more exist)' : ''}.</span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              onClick={purgeAll}
              disabled={purging || detail.keys.length === 0}
              style={{ ...S.dangerBtn, opacity: (purging || detail.keys.length === 0) ? 0.5 : 1 }}
              title="Purge every key under this prefix"
            >
              {purging ? 'Purging…' : `Purge all (${detail.keys.length})`}
            </button>
          </div>
          {detail.keys.length === 0 && (
            <div style={S.muted}>No keys.</div>
          )}
          <div style={S.keyList}>
            {detail.keys.map((k) => (
              <div key={k} style={S.keyRow}>
                <span style={S.kvKey}>{k}</span>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  onClick={() => purgeOne(k)}
                  style={S.tinyBtn}
                  title="Purge this single key"
                >
                  Purge
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
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
  headerRow: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  heading: { fontSize: 'var(--tk-fs-md)', fontWeight: 800, margin: 0 },
  muted: { color: 'var(--tk-muted)', fontSize: 'var(--tk-fs-sm)' },
  card: {
    border: '2px solid var(--tk-border-soft)',
    background: 'var(--tk-surface)',
    display: 'flex',
    flexDirection: 'column',
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '8px 12px',
    cursor: 'pointer',
    flexWrap: 'wrap',
  },
  slug: {
    fontWeight: 700,
    fontSize: 'var(--tk-fs-sm)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  kvKey: {
    fontFamily: 'var(--tk-font-mono)',
    fontSize: 'var(--tk-fs-xs)',
  },
  detailWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '8px 12px 12px 12px',
    borderTop: '1px solid var(--tk-border-soft)',
    background: 'var(--tk-bg)',
  },
  keyList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    maxHeight: 320,
    overflowY: 'auto',
  },
  keyRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 6px',
    background: 'var(--tk-surface)',
    border: '1px solid var(--tk-border-soft)',
  },
  tinyBtn: {
    ...INPUT_BASE,
    fontSize: 'var(--tk-fs-xs)',
    fontWeight: 700,
    textTransform: 'uppercase',
    cursor: 'pointer',
    padding: '2px 8px',
  },
  dangerBtn: {
    ...INPUT_BASE,
    background: 'var(--tk-danger)',
    color: 'var(--tk-danger-fg)',
    borderColor: 'var(--tk-danger)',
    fontSize: 'var(--tk-fs-xs)',
    fontWeight: 700,
    textTransform: 'uppercase',
    cursor: 'pointer',
    padding: '4px 12px',
  },
};
