/**
 * CommentExpand — inline researcher comment expansion under a VoteList row.
 *
 * Renders a chevron + count when comments exist, expands to show comment
 * markdown plus a score-adjustment chip (AC-53.3) when non-zero.
 *
 * Presentational only — fetcher state lives in `useRepComments`. Markdown
 * is rendered as plain pre-wrapped text (no markdown parser dep) so the
 * embed bundle stays lean. Researcher commentary is editorial prose, not
 * formatted documents.
 *
 * Traces to FR-53 AC-53.1, AC-53.3.
 */
import { useState } from 'react';
import type { ResearcherComment } from '../hooks/useRepComments';

export interface CommentExpandProps {
  comments: readonly ResearcherComment[];
}

export function CommentExpand({ comments }: CommentExpandProps) {
  const [open, setOpen] = useState(false);
  if (comments.length === 0) return null;
  const count = comments.length;
  return (
    <div className="viw-comment-expand">
      <button
        type="button"
        className="viw-comment-expand-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? '▾ Hide' : '▸ Show'} {count} researcher comment
        {count === 1 ? '' : 's'}
      </button>
      {open && (
        <ul className="viw-comment-list" role="list">
          {comments.map((c) => (
            <li key={c.id} className="viw-comment-item">
              <div className="viw-comment-meta">
                <span className="viw-comment-author">
                  {c.authorEmail.split('@')[0]}
                </span>
                <span className="viw-comment-date">
                  {formatRelativeDate(c.createdAt)}
                </span>
                {/* AC-52.43 — chip shows weight × direction (range [-5,+5]). */}
                {c.direction !== 0 && c.weight > 0 && (
                  <ScoreAdjustmentChip value={c.direction * c.weight} />
                )}
              </div>
              <div className="viw-comment-body">{c.bodyMarkdown}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface ScoreAdjustmentChipProps {
  value: number;
}

export function ScoreAdjustmentChip({ value }: ScoreAdjustmentChipProps) {
  const label = (value > 0 ? '+' : '') + value.toFixed(2);
  const cls = value > 0 ? 'viw-score-adj-pos' : 'viw-score-adj-neg';
  return (
    <span
      className={`viw-score-adj ${cls}`}
      title={`Researcher score adjustment: ${label}`}
    >
      {label}
    </span>
  );
}

function formatRelativeDate(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return iso.slice(0, 10);
}
