/**
 * Admin ▸ Weight tuner (FR-64).
 *
 * FM-style bulk weight calibration: search votes, preview a computed weight
 * adjustment (× k or + d) per row, then apply it as a batch of audited
 * single-row PATCHes. Reuses the FR-63 vote-review read endpoint; the only
 * write is the existing PATCH /api/admin/votes/:id { weight }.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { get, patch as patchApi } from '../../fetcher';
import { computeWeight, isWeightChange, type AdjustMode } from '../../utils/weightAdjust';

interface VoteRow {
  id: string;
  bill_id: string;
  bill_label: string | null;
  chamber: string;
  roll_call: number;
  kind: string;
  weight: number;
}

export function WeightTunerView() {
  const [all, setAll] = useState<VoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters.
  const [billFilter, setBillFilter] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [minW, setMinW] = useState('');
  const [maxW, setMaxW] = useState('');

  // Adjustment.
  const [mode, setMode] = useState<AdjustMode>('multiply');
  const [amount, setAmount] = useState('1.2');
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<Array<{ id: string; error: string }>>([]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    get<{ items: VoteRow[] }>('/api/admin/vote-review?state=all')
      .then((r) => setAll(r.items))
      .catch((e: unknown) => setError(String((e as { detail?: string }).detail ?? e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const kinds = useMemo(() => Array.from(new Set(all.map((v) => v.kind))).sort(), [all]);

  const filtered = useMemo(() => {
    const lo = minW === '' ? -Infinity : Number(minW);
    const hi = maxW === '' ? Infinity : Number(maxW);
    const bf = billFilter.trim().toLowerCase();
    return all.filter(
      (v) =>
        (bf === '' || v.bill_id.toLowerCase().includes(bf)) &&
        (kindFilter === '' || v.kind === kindFilter) &&
        v.weight >= lo &&
        v.weight <= hi,
    );
  }, [all, billFilter, kindFilter, minW, maxW]);

  const amt = Number(amount);
  const amtValid = Number.isFinite(amt) && (mode !== 'multiply' || amt > 0);

  const previews = useMemo(
    () =>
      filtered.map((v) => {
        const next = amtValid ? computeWeight(v.weight, mode, amt) : v.weight;
        return { v, next, changes: amtValid && isWeightChange(v.weight, next) };
      }),
    [filtered, mode, amt, amtValid],
  );
  const changeCount = previews.filter((p) => p.changes).length;

  async function apply() {
    const toChange = previews.filter((p) => p.changes);
    if (toChange.length === 0) return;
    const reason = prompt(
      `Apply ${mode === 'multiply' ? `× ${amt}` : `+ ${amt}`} to ${toChange.length} vote weight(s)?\n` +
        `Enter a reason (required, flows into the audit log):`,
    );
    if (!reason || !reason.trim()) return;
    setApplying(true);
    setFailures([]);
    setProgress({ done: 0, total: toChange.length });
    const fails: Array<{ id: string; error: string }> = [];
    let done = 0;
    for (const p of toChange) {
      try {
        await patchApi(`/api/admin/votes/${p.v.id}`, { weight: p.next, _reason: reason.trim() });
      } catch (e: unknown) {
        fails.push({ id: p.v.id, error: String((e as { detail?: string }).detail ?? e) });
      }
      done++;
      setProgress({ done, total: toChange.length });
    }
    setFailures(fails);
    setApplying(false);
    load(); // refresh weights
  }

  return (
    <div style={S.root}>
      <div style={S.headerRow}>
        <h2 style={S.heading}>Weight tuner</h2>
        <span style={S.muted}>
          Search votes, preview a weight adjustment, and apply it in bulk. Every change is audited.
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={load} style={S.tinyBtn}>↻ Refresh</button>
      </div>

      {/* Filters */}
      <div style={S.controls}>
        <label style={S.field}>Bill
          <input value={billFilter} onChange={(e) => setBillFilter(e.target.value)} placeholder="e.g. HR-815" style={S.input} />
        </label>
        <label style={S.field}>Kind
          <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} style={S.input}>
            <option value="">All kinds</option>
            {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <label style={S.field}>Weight ≥
          <input value={minW} onChange={(e) => setMinW(e.target.value)} placeholder="0" style={{ ...S.input, width: 64 }} />
        </label>
        <label style={S.field}>Weight ≤
          <input value={maxW} onChange={(e) => setMaxW(e.target.value)} placeholder="5" style={{ ...S.input, width: 64 }} />
        </label>
      </div>

      {/* Adjustment */}
      <div style={S.controls}>
        <label style={S.field}>Adjustment
          <select value={mode} onChange={(e) => setMode(e.target.value as AdjustMode)} style={S.input}>
            <option value="multiply">Multiply ×</option>
            <option value="linear">Add / subtract +</option>
          </select>
        </label>
        <label style={S.field}>Amount
          <input value={amount} onChange={(e) => setAmount(e.target.value)} style={{ ...S.input, width: 80 }} />
        </label>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={apply}
          disabled={applying || !amtValid || changeCount === 0}
          style={{ ...S.applyBtn, opacity: applying || !amtValid || changeCount === 0 ? 0.5 : 1 }}
        >
          {applying ? 'Applying…' : `Apply to ${changeCount} vote${changeCount === 1 ? '' : 's'}`}
        </button>
      </div>
      {!amtValid && <div style={{ color: 'var(--tk-danger)', fontSize: 'var(--tk-fs-sm)' }}>Enter a valid amount {mode === 'multiply' ? '(> 0)' : ''}.</div>}

      {progress && <div style={S.muted}>Applied {progress.done} / {progress.total}…</div>}
      {failures.length > 0 && (
        <div style={{ color: 'var(--tk-danger)', fontSize: 'var(--tk-fs-sm)' }}>
          {failures.length} failed: {failures.map((f) => f.id).join(', ')}
        </div>
      )}

      {loading && <div style={S.muted}>Loading…</div>}
      {error && <div style={{ color: 'var(--tk-danger)' }}>{error}</div>}
      {!loading && <div style={S.muted}>{filtered.length} match{filtered.length === 1 ? '' : 'es'} · {changeCount} would change</div>}

      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.th}>Bill</th>
            <th style={S.th}>Vote</th>
            <th style={S.th}>Kind</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Weight</th>
            <th style={{ ...S.th, textAlign: 'right' }}>→ New</th>
          </tr>
        </thead>
        <tbody>
          {previews.map(({ v, next, changes }) => (
            <tr key={v.id} style={{ opacity: changes ? 1 : 0.45 }}>
              <td style={S.td}>
                <span style={{ fontFamily: 'var(--tk-font-mono)', fontWeight: 700 }}>{v.bill_id}</span>
              </td>
              <td style={S.td}>{v.chamber} roll {v.roll_call}</td>
              <td style={S.td}>{v.kind}</td>
              <td style={{ ...S.td, textAlign: 'right', fontFamily: 'var(--tk-font-mono)' }}>{v.weight.toFixed(2)}</td>
              <td style={{ ...S.td, textAlign: 'right', fontFamily: 'var(--tk-font-mono)', fontWeight: changes ? 800 : 400, color: changes ? 'var(--tk-link)' : 'var(--tk-muted)' }}>
                {next.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const INPUT_BASE: React.CSSProperties = {
  background: 'var(--tk-bg)', color: 'var(--tk-fg)',
  border: '2px solid var(--tk-border-soft)', borderRadius: 0,
  padding: '6px 10px', fontFamily: 'var(--tk-font)', fontSize: 'var(--tk-fs-sm)',
};

const S: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 10 },
  headerRow: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  heading: { fontSize: 'var(--tk-fs-md)', fontWeight: 800, margin: 0 },
  muted: { color: 'var(--tk-muted)', fontSize: 'var(--tk-fs-sm)' },
  controls: { display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' },
  input: INPUT_BASE,
  tinyBtn: { ...INPUT_BASE, fontSize: 'var(--tk-fs-xs)', fontWeight: 700, textTransform: 'uppercase', cursor: 'pointer', padding: '2px 8px' },
  applyBtn: { ...INPUT_BASE, background: 'var(--tk-accent)', color: 'var(--tk-accent-fg)', borderColor: 'var(--tk-accent)', fontWeight: 800, textTransform: 'uppercase', cursor: 'pointer', padding: '6px 14px' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--tk-fs-sm)' },
  th: { textAlign: 'left', padding: '6px 8px', borderBottom: '2px solid var(--tk-border-soft)', fontSize: 'var(--tk-fs-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--tk-muted)' },
  td: { padding: '6px 8px', borderBottom: '1px solid var(--tk-border-soft)' },
};
