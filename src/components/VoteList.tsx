/**
 * VoteList — clustered, valence-colored Ukraine voting record.
 * Each cluster shows a primary (high-weight) vote with collapsible procedural rows.
 * Traces to: US-3, FR-15, FR-17, T-016
 */
import { useState } from 'react';
import type { ClusteredMemberVoteWithValence, MemberVoteRow } from '../hooks/useVotingRecord';
import type { Valence } from '../services/valence';
import { formatDate } from '../utils/formatters';
import { ErrorBanner } from './ErrorBanner';
import { CommentExpand } from './CommentExpand';
import {
  commentsForRow,
  rollCallKey,
  type CommentsByBill,
} from '../hooks/useRepComments';

export interface VoteListProps {
  clusters: ClusteredMemberVoteWithValence[];
  loading?: boolean;
  error?: string | null;
  /** Optional FR-37 envelope fields — when `traceId` is present, errors
   *  render via `ErrorBanner` instead of the legacy inline div. */
  errorTraceId?: string;
  errorOnRetry?: () => void;
  /** FR-53 AC-53.1 — researcher comments keyed by bill_id. When undefined or
   *  empty, no expand affordances are rendered (preserves pre-V4 behavior). */
  commentsByBill?: CommentsByBill;
}

export function VoteList({
  clusters,
  loading = false,
  error = null,
  errorTraceId,
  errorOnRetry,
  commentsByBill,
}: VoteListProps) {
  if (loading && clusters.length === 0) {
    return <div className="viw-votelist-empty">Loading Ukraine votes…</div>;
  }
  if (error) {
    if (errorTraceId || errorOnRetry) {
      return (
        <ErrorBanner
          message={error}
          traceId={errorTraceId}
          onRetry={errorOnRetry}
        />
      );
    }
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
            <VoteCluster key={i} cluster={c} commentsByBill={commentsByBill} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VoteCluster({
  cluster,
  commentsByBill,
}: {
  cluster: ClusteredMemberVoteWithValence;
  commentsByBill?: CommentsByBill;
}) {
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
        commentsByBill={commentsByBill}
      />
      {expanded &&
        cluster.procedural.map((row, i) => (
          <VoteRow
            key={`proc-${i}`}
            row={row}
            isProcedural
            commentsByBill={commentsByBill}
          />
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
  commentsByBill?: CommentsByBill;
}

function VoteRow({
  row,
  isPrimary = false,
  isProcedural = false,
  expandable = false,
  expanded = false,
  onToggle,
  proceduralCount = 0,
  commentsByBill,
}: VoteRowProps) {
  // FR-53 AC-53.1 — comments scoped to this bill / roll-call.
  const billId = `${row.bill.congress}-${row.bill.type}-${row.bill.number}`;
  const rcKey = rollCallKey(
    row.vote.chamber,
    row.vote.congress,
    row.vote.session,
    row.vote.rollCall,
  );
  const comments = commentsByBill ? commentsForRow(commentsByBill, billId, rcKey) : [];
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
          <span className="viw-votelist-billslug">{formatBillSlug(row.bill.type, row.bill.number)}</span>
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
        {comments.length > 0 && <CommentExpand comments={comments} />}
      </td>
      <td className="viw-votelist-date" data-label="Date">{safeDate(row.vote.date)}</td>
      <td data-label="Position">
        <span
          className={`viw-vote ${positionPillClass(row)}`}
          style={{ filter: positionPillFilter(row) }}
        >
          {displayPosition(row)}
        </span>
      </td>
      <td className="viw-vote-outcome" data-label="Outcome">
        {isPrimary && row.bill.becameLaw
          ? 'Became law'
          : shortenAction(row.vote.action)}
      </td>
    </tr>
  );
}

// ─── Helpers ───

function valenceCss(v: Valence): string {
  return v.replace('-', '-'); // keeps original for clarity; class is viw-valence-${v}
}

/** House bills print without a period after the type; Senate variants
 *  get the conventional `S.` form. Matches the score-breakdown panel +
 *  About panel formatBillSlug, so every slug rendered in the widget
 *  reads consistently. */
function formatBillSlug(type: string, number: string): string {
  const t = type.toUpperCase();
  if (t === 'S' || t === 'SRES' || t === 'SJRES' || t === 'SCONRES') {
    return `${t.replace('S', 'S.').replace('..', '.')} ${number}`;
  }
  return `${t} ${number}`;
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

/**
 * Position-pill color class — green for Aye, red for Nay, grey for
 * Present/Not Voting. Uses the literal member action, not the derived
 * valence, so procedural rows on neutral bills still communicate which
 * way the member voted instead of being uniformly grey.
 */
function positionPillClass(row: MemberVoteRow): string {
  switch (row.memberVote) {
    case 'Aye':        return 'viw-vote-pos-aye';
    case 'Nay':        return 'viw-vote-pos-nay';
    case 'Present':
    case 'Not Voting': return 'viw-vote-pos-unstated';
    default:           return 'viw-vote-pos-unstated';
  }
}

/**
 * Weight-driven saturation — matches the score-badge treatment from
 * FR-43 AC-43.3. A weight-1.0 final-passage Aye pops at full saturation;
 * a weight-0.45 cloture Aye reads as ~60% saturated; a weight-0 motion-
 * to-table vote desaturates toward grey to signal "this doesn't count
 * toward the score."
 */
function positionPillFilter(row: MemberVoteRow): string {
  // Present / Not Voting don't have an action weight to saturate against.
  if (row.memberVote !== 'Aye' && row.memberVote !== 'Nay') return '';
  const w = Math.max(0, Math.min(1, row.vote.weight ?? 0));
  const x = 0.2 + 0.8 * w;
  return `saturate(${Math.round(x * 100) / 100})`;
}
