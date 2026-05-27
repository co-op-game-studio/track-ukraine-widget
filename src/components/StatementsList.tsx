/**
 * StatementsList — merged Statements tab (FR-53 AC-53.2 REVISED, AC-53.6).
 *
 * Renders curated social posts AND quotes in a single chronological feed.
 * Each item shows source kind (X / YouTube / video / text / etc.), body
 * text, source link, optional researcher comment, and a score-adjustment
 * chip when non-zero (AC-53.3).
 *
 * Background (project_v4_statements_quotes_plan): the underlying D1
 * tables remain split — `social_posts` for team-entered editorial,
 * `quotes` for auto-ingested + reviewed material — but the embed
 * surfaces them as one feed because both are "what this rep has said
 * publicly about Ukraine, with researcher commentary."
 *
 * Traces to FR-53 AC-53.2 (revised), AC-53.3, AC-53.5, AC-53.6.
 */
import type { SocialPost } from '../hooks/useRepStatements';
import type { RepQuote } from '../hooks/useRepQuotes';
import { ScoreAdjustmentChip } from './CommentExpand';
import { sanitizeUrl } from '../utils/sanitizeUrl';

export interface StatementsListProps {
  posts: readonly SocialPost[];
  quotes: readonly RepQuote[];
  loading?: boolean;
}

interface FeedItem {
  kind: 'post' | 'quote';
  id: string;
  /** What kind of source: 'x' / 'youtube' / 'video' / 'text' / etc. */
  source: string;
  /** ISO date — used for sorting and display. */
  date: string | null;
  bodyText: string;
  sourceUrl: string;
  sourceLabel: string | null;
  /** AC-52.43 — composed contribution = direction × weight, range [-5, +5]. */
  contribution: number;
  comment: string | null;
}

function postToItem(p: SocialPost): FeedItem {
  return {
    kind: 'post',
    id: `post:${p.id}`,
    source: p.platform,
    date: p.postedAt ?? p.createdAt,
    bodyText: p.bodyText,
    sourceUrl: p.url,
    sourceLabel: null,
    contribution: p.direction * p.weight,
    comment: p.comment,
  };
}

function quoteToItem(q: RepQuote): FeedItem {
  return {
    kind: 'quote',
    id: `quote:${q.id}`,
    source: q.mediaKind,
    date: q.quotedAt ?? q.createdAt,
    bodyText: q.bodyText,
    sourceUrl: q.sourceUrl,
    sourceLabel: q.sourceLabel,
    contribution: q.direction * q.weight,
    comment: q.comment,
  };
}

/** Combined chronological feed, newest first. */
export function mergeFeed(
  posts: readonly SocialPost[],
  quotes: readonly RepQuote[],
): FeedItem[] {
  const items: FeedItem[] = [
    ...posts.map(postToItem),
    ...quotes.map(quoteToItem),
  ];
  items.sort((a, b) => {
    const ad = a.date ?? '';
    const bd = b.date ?? '';
    return bd.localeCompare(ad);
  });
  return items;
}

export function StatementsList({ posts, quotes, loading = false }: StatementsListProps) {
  const items = mergeFeed(posts, quotes);
  if (loading && items.length === 0) {
    return <div className="viw-statements-empty">Loading statements…</div>;
  }
  if (items.length === 0) {
    return (
      <div className="viw-statements-empty">
        No researcher-curated statements for this member yet.
      </div>
    );
  }
  return (
    <ul className="viw-statements-list" role="list">
      {items.map((it) => {
        const safeUrl = sanitizeUrl(it.sourceUrl);
        return (
          <li key={it.id} className={`viw-statement-item viw-statement-item-${it.kind}`}>
            <div className="viw-statement-meta">
              <span className={`viw-statement-source viw-statement-${it.source}`}>
                {sourceLabel(it.source, it.kind)}
              </span>
              {it.date && <span className="viw-statement-date">{it.date.slice(0, 10)}</span>}
              {it.contribution !== 0 && <ScoreAdjustmentChip value={it.contribution} />}
            </div>
            {it.kind === 'quote' ? (
              <blockquote className="viw-statement-body">"{it.bodyText}"</blockquote>
            ) : (
              <div className="viw-statement-body">{it.bodyText}</div>
            )}
            {it.comment && (
              <div className="viw-statement-curator-comment">
                <span className="viw-statement-curator-label">Researcher note:</span>{' '}
                {it.comment}
              </div>
            )}
            {safeUrl && (
              <a
                className="viw-statement-source-link"
                href={safeUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {it.sourceLabel ?? 'View source'} ↗
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function sourceLabel(source: string, kind: 'post' | 'quote'): string {
  if (kind === 'post') {
    switch (source) {
      case 'x': return 'X / Twitter';
      case 'facebook': return 'Facebook';
      case 'youtube': return 'YouTube';
      case 'instagram': return 'Instagram';
      // facebook + instagram: kept for display of existing data, not offered for new posts
      default: return source;
    }
  }
  // kind === 'quote'
  switch (source) {
    case 'video': return 'Video';
    case 'audio': return 'Audio';
    case 'text': return 'Text';
    case 'image': return 'Image';
    default: return source;
  }
}
