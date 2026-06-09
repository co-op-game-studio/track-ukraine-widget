/**
 * Admin ▸ Vote review (FR-63 AC-63.6).
 *
 * The multi-stage review surface for the explicit per-vote direction. Every
 * vote was mechanically converted from the old inversion multiplier (score-
 * preserving); here a researcher re-confirms or corrects each vote's direction.
 * Previously-inverted votes (legacy multiplier −1) are flagged for extra
 * scrutiny. Confirming or changing a direction is an audited write that stamps
 * direction_reviewed_at/by.
 *
 * No bill-direction math: each vote states "an Aye on this vote is pro / anti /
 * neutral toward Ukraine" directly.
 */
import { useCallback, useEffect, useState } from 'react';
import { get, patch as patchApi } from '../../fetcher';

type Direction = 'pro' | 'anti' | 'neutral';
type ReviewState = 'unreviewed' | 'reviewed' | 'all';

interface VoteReviewRow {
  id: string;
  bill_id: string;
  bill_label: string | null;
  bill_title: string | null;
  bill_direction: string;
  chamber: string;
  roll_call: number;
  kind: string;
  action: string | null;
  date: string;
  action_date: string | null;
  direction: Direction;
  direction_reviewed_at: string | null;
  direction_reviewed_by: string | null;
  previously_inverted: boolean;
  reviewed: boolean;
}

const DIR_META: Record<Direction, { label: string; meaning: string; color: string }> = {
  pro:     { label: 'Pro-Ukraine',  meaning: 'An Aye on this vote counts as pro-Ukraine.',  color: 'var(--tk-success)' },
  anti:    { label: 'Anti-Ukraine', meaning: 'An Aye on this vote counts as anti-Ukraine.', color: 'var(--tk-danger)' },
  neutral: { label: 'Neutral',      meaning: 'This vote does not count toward the score.',   color: 'var(--tk-muted)' },
};

export function VoteReviewView() {
  const [items, setItems] = useState<VoteReviewRow[]>([]);
  const [state, setState] = useState<ReviewState>('unreviewed');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    get<{ items: VoteReviewRow[] }>(`/api/admin/vote-review?state=${state}`)
      .then((r) => setItems(r.items))
      .catch((e: unknown) => setError(String((e as { detail?: string }).detail ?? e)))
      .finally(() => setLoading(false));
  }, [state]);

  useEffect(() => { load(); }, [load, reload]);

  async function setDirection(row: VoteReviewRow, direction: Direction, confirmOnly: boolean) {
    const verb = confirmOnly ? 'Confirm' : `Change to ${DIR_META[direction].label}`;
    const reason = prompt(
      `${verb} the direction of ${row.bill_id} ${row.chamber} roll ${row.roll_call}?\n` +
        `Enter a reason (required, flows into the audit log):`,
    );
    if (!reason || !reason.trim()) return;
    setBusyId(row.id);
    try {
      await patchApi(`/api/admin/votes/${row.id}`, { direction, _reason: reason.trim() });
      setReload((n) => n + 1);
    } catch (e: unknown) {
      alert(`Update failed: ${String((e as { detail?: string }).detail ?? e)}`);
    } finally {
      setBusyId(null);
    }
  }

  const unreviewedCount = items.filter((i) => !i.reviewed).length;
  const invertedCount = items.filter((i) => i.previously_inverted).length;

  return (
    <div style={S.root}>
      <div style={S.headerRow}>
        <h2 style={S.heading}>Vote review</h2>
        <span style={S.muted}>
          Re-confirm each vote's Ukraine direction. Flagged (⚑) votes were previously scored by
          inversion and deserve a close look.
        </span>
        <span style={{ flex: 1 }} />
        <select value={state} onChange={(e) => setState(e.target.value as ReviewState)} style={S.select}>
          <option value="unreviewed">Needs review</option>
          <option value="reviewed">Reviewed</option>
          <option value="all">All</option>
        </select>
        <button type="button" onClick={() => setReload((n) => n + 1)} style={S.tinyBtn}>↻ Refresh</button>
      </div>

      {!loading && (
        <div style={S.muted}>
          {items.length} vote{items.length === 1 ? '' : 's'}
          {state !== 'reviewed' && ` · ${unreviewedCount} need review`}
          {invertedCount > 0 && ` · ${invertedCount} flagged ⚑`}
        </div>
      )}
      {loading && <div style={S.muted}>Loading…</div>}
      {error && <div style={{ color: 'var(--tk-danger)' }}>{error}</div>}

      {items.map((row) => {
        const meta = DIR_META[row.direction];
        const busy = busyId === row.id;
        return (
          <div key={row.id} style={{ ...S.card, borderLeftColor: meta.color }}>
            <div style={S.cardHead}>
              {row.previously_inverted && <span title="Previously inverted — review carefully" style={S.flag}>⚑</span>}
              <span style={S.billId}>{row.bill_id}</span>
              <span style={S.muted}>{row.chamber} · roll {row.roll_call} · {row.kind}</span>
              {row.reviewed && (
                <span style={S.reviewedTag} title={`Reviewed by ${row.direction_reviewed_by ?? '—'} at ${row.direction_reviewed_at ?? '—'}`}>
                  ✓ reviewed
                </span>
              )}
              <span style={{ flex: 1 }} />
              <span style={{ ...S.dirBadge, background: meta.color }}>{meta.label}</span>
            </div>
            <div style={S.billLabel}>{row.bill_label ?? row.bill_title ?? ''}</div>
            {row.action && <div style={S.action}>{row.action}</div>}
            <div style={S.meaning}>{meta.meaning}</div>
            <div style={S.actions}>
              <button
                type="button"
                disabled={busy}
                onClick={() => setDirection(row, row.direction, true)}
                style={S.confirmBtn}
                title="Confirm the current direction is correct"
              >
                {busy ? '…' : '✓ Confirm'}
              </button>
              <span style={S.muted}>or set:</span>
              {(['pro', 'anti', 'neutral'] as Direction[]).map((d) => (
                <button
                  key={d}
                  type="button"
                  disabled={busy || d === row.direction}
                  onClick={() => setDirection(row, d, false)}
                  style={{
                    ...S.dirBtn,
                    ...(d === row.direction ? { opacity: 0.4, cursor: 'default' } : {}),
                    borderColor: DIR_META[d].color,
                    color: DIR_META[d].color,
                  }}
                >
                  {DIR_META[d].label}
                </button>
              ))}
            </div>
          </div>
        );
      })}
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
  select: INPUT_BASE,
  tinyBtn: { ...INPUT_BASE, fontSize: 'var(--tk-fs-xs)', fontWeight: 700, textTransform: 'uppercase', cursor: 'pointer', padding: '2px 8px' },
  card: { border: '2px solid var(--tk-border-soft)', borderLeftWidth: 4, background: 'var(--tk-surface)', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6 },
  cardHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  flag: { color: 'var(--tk-danger)', fontWeight: 900 },
  billId: { fontWeight: 800, fontSize: 'var(--tk-fs-sm)', fontFamily: 'var(--tk-font-mono)' },
  reviewedTag: { color: 'var(--tk-success)', fontSize: 'var(--tk-fs-xs)', fontWeight: 700 },
  dirBadge: { color: '#fff', fontSize: 'var(--tk-fs-xs)', fontWeight: 700, padding: '2px 8px', textTransform: 'uppercase', letterSpacing: '0.04em' },
  billLabel: { fontSize: 'var(--tk-fs-sm)', fontWeight: 600 },
  action: { fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)' },
  meaning: { fontSize: 'var(--tk-fs-sm)', fontStyle: 'italic' },
  actions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 2 },
  confirmBtn: { ...INPUT_BASE, fontSize: 'var(--tk-fs-xs)', fontWeight: 700, cursor: 'pointer', padding: '4px 10px', borderColor: 'var(--tk-success)', color: 'var(--tk-success)' },
  dirBtn: { ...INPUT_BASE, fontSize: 'var(--tk-fs-xs)', fontWeight: 700, cursor: 'pointer', padding: '4px 10px', background: 'var(--tk-bg)' },
};
