/**
 * MemberVotesMatrix — succinct matrix of the bills we track vs how this member
 * voted (for/against Ukraine). Admin Bills tab. Reuses the widget's
 * `resolveMemberVotes` resolver (live roster fetches) so admin and the public
 * widget can't drift.
 *
 * Traces to: FR-60 AC-60.21, FR-32 AC-32.30..32.33.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useMemberById } from '../../hooks/useMemberById';
import {
  resolveMemberVotes,
  type MemberBillPosition,
} from '../../services/memberVotes';
import { fetchRollCallRoster } from '../../services/rollCallRosters';

type Status = 'idle' | 'loading' | 'success' | 'error' | 'notfound';

/** Compose member identity (useMemberById normalizes chamber/state) → resolver. */
function useMemberVotes(bioguideId: string): { status: Status; rows: MemberBillPosition[] } {
  const { representative, status: memberStatus } = useMemberById(bioguideId, window.location.origin);
  const [rows, setRows] = useState<MemberBillPosition[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const reqRef = useRef(0);

  useEffect(() => {
    if (memberStatus === 'loading' || memberStatus === 'idle') { setStatus('loading'); return; }
    if (memberStatus === 'notfound') { setStatus('notfound'); return; }
    if (memberStatus === 'error' || !representative) { setStatus('error'); return; }

    const thisReq = ++reqRef.current;
    setStatus('loading');
    const lastName = representative.name.split(',')[0]?.trim() ?? representative.name;
    resolveMemberVotes(
      {
        bioguideId: representative.bioguideId,
        chamber: representative.chamber,
        lastName,
        state: representative.state,
      },
      {
        fetchRoster: (chamber, congress, session, rollCall) =>
          fetchRollCallRoster(chamber, congress, session, rollCall, window.location.origin),
      },
    )
      .then((r) => { if (thisReq === reqRef.current) { setRows(r); setStatus('success'); } })
      .catch(() => { if (thisReq === reqRef.current) setStatus('error'); });
  }, [representative, memberStatus]);

  return { status, rows };
}

const POS_COLOR: Record<string, string> = {
  Aye: '#22c55e', Nay: '#ef4444', Present: '#888', 'Not Voting': '#888', 'Did Not Serve': 'var(--tk-muted)',
};
const UKR_COLOR: Record<string, string> = { for: '#22c55e', against: '#ef4444', 'n/a': 'var(--tk-muted)' };
const UKR_LABEL: Record<string, string> = { for: 'For', against: 'Against', 'n/a': '—' };

export function MemberVotesMatrix({ bioguideId }: { bioguideId: string }) {
  const { status, rows } = useMemberVotes(bioguideId);

  if (status === 'loading') return <div style={mutedStyle}>Loading voting record…</div>;
  if (status === 'notfound') return <div style={mutedStyle}>No member record found for this person.</div>;
  if (status === 'error') return <div style={errStyle}>Could not load the voting record. Try again.</div>;
  if (rows.length === 0) return <div style={mutedStyle}>No Ukraine-related votes recorded.</div>;

  const forCount = rows.filter((r) => r.forAgainstUkraine === 'for').length;
  const againstCount = rows.filter((r) => r.forAgainstUkraine === 'against').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 'var(--tk-fs-sm)' }}>
        <span><strong>{rows.length}</strong> tracked</span>
        <span style={{ color: '#22c55e' }}><strong>{forCount}</strong> for Ukraine</span>
        <span style={{ color: '#ef4444' }}><strong>{againstCount}</strong> against</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Bill</th>
              <th style={thStyle}>Date</th>
              <th style={thStyle}>Position</th>
              <th style={thStyle}>Outcome</th>
              <th style={thStyle}>Ukraine</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.bill.congress}-${r.bill.type}-${r.bill.number}-${r.vote.rollCall}-${i}`}>
                <td style={tdStyle}>
                  <span style={{ fontWeight: 700 }}>{r.bill.label}</span>
                  {r.bill.title && (
                    <span style={{ color: 'var(--tk-muted)', marginLeft: 6 }}>
                      {r.bill.title.slice(0, 60)}{r.bill.title.length > 60 ? '…' : ''}
                    </span>
                  )}
                </td>
                <td style={tdStyle}>{r.vote.date ? new Date(r.vote.date).toLocaleDateString() : '—'}</td>
                <td style={{ ...tdStyle, color: POS_COLOR[r.cast] ?? 'var(--tk-fg)', fontWeight: 700, fontStyle: r.cast === 'Did Not Serve' ? 'italic' : 'normal' }}>
                  {r.cast}
                </td>
                <td style={tdStyle}>{r.becameLaw ? 'Became law' : '—'}</td>
                <td style={{ ...tdStyle, color: UKR_COLOR[r.forAgainstUkraine], fontWeight: 700 }}>
                  {UKR_LABEL[r.forAgainstUkraine]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const mutedStyle: CSSProperties = { color: 'var(--tk-muted)', fontSize: 'var(--tk-fs-sm)' };
const errStyle: CSSProperties = { color: 'var(--tk-danger)', fontSize: 'var(--tk-fs-sm)' };
const tableStyle: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--tk-fs-sm)' };
const thStyle: CSSProperties = {
  textAlign: 'left', padding: '6px 8px', borderBottom: '2px solid var(--tk-border-soft)',
  fontSize: 'var(--tk-fs-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--tk-muted)',
};
const tdStyle: CSSProperties = { padding: '6px 8px', borderBottom: '1px solid var(--tk-border-soft)' };
