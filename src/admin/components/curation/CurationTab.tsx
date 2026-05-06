/**
 * Curation tab — single funnel for the discover→score pipeline.
 *
 * Sub-views driven by React Router via /curation/:view.
 */
import { NavLink, useParams, Navigate } from 'react-router-dom';
import { QueueView, ResearchView, DirectAddView } from '../SocialFeedTab';
import { AddQuoteView } from './AddQuoteView';
import { QuotesListView } from './QuotesListView';
import type { QuotePrefill } from '../../App';

export type CurationView = 'inbox' | 'add' | 'quotes' | 'research' | 'direct';

// Inbox temporarily hidden from sub-nav — workflow not ready. The view
// renderer below still handles it so deep-links resolve, but it's unlisted.
const VIEWS: Array<{ id: CurationView; label: string; help: string }> = [
  { id: 'add',      label: 'Add quote',  help: 'Score a quote from any source' },
  { id: 'quotes',   label: 'All quotes', help: 'Browse + edit existing quotes' },
  { id: 'research', label: 'Research',   help: 'Search a person\'s social feeds' },
  { id: 'direct',   label: 'Add by URL', help: 'Paste a social URL to ingest' },
];

const VALID: Set<string> = new Set<string>([...VIEWS.map((v) => v.id), 'inbox']);

export function CurationTab({
  onNavigateToPerson,
  onCurateAsQuote,
  prefill,
  onPrefillConsumed,
}: {
  onNavigateToPerson: (bioguideId: string) => void;
  onCurateAsQuote: (data: QuotePrefill) => void;
  prefill: QuotePrefill | null;
  onPrefillConsumed: () => void;
}) {
  const { view = 'add' } = useParams<{ view: string }>();
  if (!VALID.has(view)) return <Navigate to="/curation/add" replace />;

  return (
    <div style={styles.root}>
      <nav style={styles.subNav}>
        {VIEWS.map((v) => (
          <NavLink
            key={v.id}
            to={`/curation/${v.id}`}
            title={v.help}
            style={({ isActive }) => ({
              ...styles.subTab,
              ...(isActive ? styles.subTabActive : {}),
            })}
          >
            {v.label}
          </NavLink>
        ))}
      </nav>
      <div style={styles.body}>
        {view === 'inbox'    && <QueueView onCurateAsQuote={onCurateAsQuote} />}
        {view === 'add'      && <AddQuoteView prefill={prefill} onPrefillConsumed={onPrefillConsumed} />}
        {view === 'quotes'   && <QuotesListView onNavigateToPerson={onNavigateToPerson} />}
        {view === 'research' && <ResearchView onNavigateToPerson={onNavigateToPerson} onCurateAsQuote={onCurateAsQuote} />}
        {view === 'direct'   && <DirectAddView />}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 12 },
  subNav: {
    display: 'flex',
    gap: 0,
    borderBottom: '2px solid var(--tk-border-soft)',
    overflowX: 'auto',
  },
  subTab: {
    display: 'block',
    background: 'transparent',
    color: 'var(--tk-muted)',
    border: '2px solid transparent',
    borderBottom: 'none',
    borderRadius: 0,
    padding: '6px 14px',
    cursor: 'pointer',
    fontFamily: 'var(--tk-font)',
    fontSize: 'var(--tk-fs-xs)',
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    textDecoration: 'none',
    whiteSpace: 'nowrap' as const,
  },
  subTabActive: {
    color: 'var(--tk-fg)',
    borderColor: 'var(--tk-border-soft)',
    background: 'var(--tk-bg)',
  },
  body: { display: 'flex', flexDirection: 'column', gap: 12 },
};
