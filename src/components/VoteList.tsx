/**
 * VoteList — clustered, valence-colored Ukraine voting record.
 * Each cluster shows a primary (high-weight) vote with collapsible procedural rows.
 * Traces to: US-3, FR-15, FR-17, T-016
 */
import { useState } from 'react';
import type { ClusteredMemberVoteWithValence, MemberVoteRow } from '../hooks/useVotingRecord';
import type { Valence } from '../services/valence';
import { formatDate } from '../utils/formatters';

export interface VoteListProps {
  clusters: ClusteredMemberVoteWithValence[];
  loading?: boolean;
  error?: string | null;
}

export function VoteList({ clusters, loading = false, error = null }: VoteListProps) {
  if (loading && clusters.length === 0) {
    return <div className="viw-votelist-empty">Loading Ukraine votes…</div>;
  }
  if (error) {
    return <div className="viw-votelist-error" role="alert">{error}</div>;
  }
  if (clusters.length === 0) {
    return (
      <div className="viw-votelist-empty">
        No Ukraine-related votes were recorded for this member.
      </div>
    );
  }

  return (
    <div className="viw-votelist-scroll">
      <table className="viw-votelist" aria-label="Ukraine voting record">
        <thead>
          <tr>
            <th scope="col">Bill &amp; Vote</th>
            <th scope="col">Date</th>
            <th scope="col">Position</th>
            <th scope="col">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {clusters.map((c, i) => (
            <VoteCluster key={i} cluster={c} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VoteCluster({ cluster }: { cluster: ClusteredMemberVoteWithValence }) {
  const hasProcedural = cluster.procedural.length > 0;
  // Clusters start collapsed by default. Voters can opt in to the procedural
  // detail by clicking "Show N procedural votes". See spec FR-21 AC-21.3.
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <VoteRow
        row={cluster.primary}
        isPrimary
        expandable={hasProcedural}
        expanded={expanded}
        onToggle={() => setExpanded((e) => !e)}
        proceduralCount={cluster.procedural.length}
      />
      {expanded &&
        cluster.procedural.map((row, i) => (
          <VoteRow key={`proc-${i}`} row={row} isProcedural />
        ))}
    </>
  );
}

interface VoteRowProps {
  row: MemberVoteRow;
  isPrimary?: boolean;
  isProcedural?: boolean;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  proceduralCount?: number;
}

function VoteRow({
  row,
  isPrimary = false,
  isProcedural = false,
  expandable = false,
  expanded = false,
  onToggle,
  proceduralCount = 0,
}: VoteRowProps) {
  const cls = [
    `viw-valence-${valenceCss(row.valence)}`,
    isPrimary ? 'viw-vote-row-primary' : '',
    isProcedural ? 'viw-vote-row-procedural' : '',
    row.isObstruction ? 'viw-vote-row-obstruction' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <tr className={cls}>
      <td className="viw-votelist-bill" data-label="Bill & Vote">
        <div className="viw-votelist-billnum">
          {row.bill.featured && <span className="viw-billlist-featured" aria-hidden>★</span>}
          {row.bill.type === 'HRES' || row.bill.type === 'SRES' ? '' : ''}
          {row.bill.type}. {row.bill.number}
          <span className="viw-vote-chamber-tag">{row.vote.chamber}</span>
          {row.vote.weight > 0 && row.vote.weight < 0.5 && (
            <span className="viw-vote-weight-tag" title="Procedural — low weight">
              procedural
            </span>
          )}
          {row.isObstruction && (
            <span
              className="viw-obstruction-tag"
              title="Obstruction: procedural or indirect anti-Ukraine action"
            >
              OBSTRUCTION
            </span>
          )}
        </div>
        <div className="viw-votelist-billtitle">
          {isPrimary ? row.bill.label || row.bill.title : row.vote.action}
        </div>
        {expandable && (
          <button
            type="button"
            className="viw-vote-cluster-toggle"
            onClick={onToggle}
            aria-expanded={expanded}
          >
            {expanded ? '▾ Hide' : '▸ Show'} {proceduralCount} procedural vote
            {proceduralCount === 1 ? '' : 's'}
          </button>
        )}
      </td>
      <td className="viw-votelist-date" data-label="Date">{safeDate(row.vote.date)}</td>
      <td data-label="Position">
        <span className={`viw-vote viw-vote-valence-${valenceCss(row.valence)}`}>
          {displayPosition(row)}
        </span>
      </td>
      <td className="viw-vote-outcome" data-label="Outcome">
        {row.bill.becameLaw ? 'Became law' : shortenAction(row.vote.action)}
      </td>
    </tr>
  );
}

// ─── Helpers ───

function valenceCss(v: Valence): string {
  return v.replace('-', '-'); // keeps original for clarity; class is viw-valence-${v}
}

function displayPosition(row: MemberVoteRow): string {
  if (row.memberVote === 'Not Voting') return 'Did Not Vote';
  if (row.memberVote === 'Present') return 'Present';
  // Show Yea/Nay as the base position, then annotate what that means for Ukraine
  return row.memberVote;
}

function safeDate(s: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return formatDate(s.slice(0, 10));
  return s;
}

function shortenAction(t: string): string {
  const trimmed = t.trim();
  if (trimmed.length <= 60) return trimmed;
  return trimmed.slice(0, 58) + '…';
}
