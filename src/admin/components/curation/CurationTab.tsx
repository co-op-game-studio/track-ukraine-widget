/**
 * Curation tab — single funnel for the discover→score pipeline.
 *
 * Sub-views (controlled by parent via hash routing):
 *   inbox    — pending social-post queue (was: Social ▸ Feed Queue)
 *   add      — Add Quote form (was: Quotes ▸ Add Quote, now the default landing)
 *   quotes   — All quotes list/edit (was: Quotes ▸ All Quotes)
 *   research — Ad-hoc social search by person (was: Social ▸ Research)
 *   direct   — Paste a URL → fetch → curate (was: Social ▸ Add by URL)
 *
 * Aesthetic convergence: every sub-view uses the same card layout, colors,
 * and spacing so the funnel is visually obvious — a card you see in Inbox
 * looks the same after you score it as a quote.
 */
import { QueueView, ResearchView, DirectAddView } from '../SocialFeedTab';
import { AddQuoteView } from './AddQuoteView';
import { QuotesListView } from './QuotesListView';
import type { QuotePrefill } from '../../App';

export type CurationView = 'inbox' | 'add' | 'quotes' | 'research' | 'direct';

const VIEWS: Array<{ id: CurationView; label: string; help: string }> = [
  { id: 'inbox',    label: 'Inbox',     help: 'Pending posts to triage' },
  { id: 'add',      label: 'Add quote', help: 'Score a quote from any source' },
  { id: 'quotes',   label: 'All quotes', help: 'Browse + edit existing quotes' },
  { id: 'research', label: 'Research',  help: 'Search a person’s social feeds' },
  { id: 'direct',   label: 'Add by URL', help: 'Paste a social URL to ingest' },
];

export function CurationTab({
  view,
  onChangeView,
  onNavigateToPerson,
  onCurateAsQuote,
  prefill,
  onPrefillConsumed,
}: {
  view: CurationView;
  onChangeView: (v: CurationView) => void;
  onNavigateToPerson: (bioguideId: string) => void;
  onCurateAsQuote: (data: QuotePrefill) => void;
  prefill: QuotePrefill | null;
  onPrefillConsumed: () => void;
}) {
  return (
    <div style={styles.root}>
      <nav style={styles.subNav}>
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => onChangeView(v.id)}
            title={v.help}
            style={{
              ...styles.subTab,
              ...(view === v.id ? styles.subTabActive : {}),
            }}
          >
            {v.label}
          </button>
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
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  subTabActive: {
    color: 'var(--tk-fg)',
    borderColor: 'var(--tk-border-soft)',
    background: 'var(--tk-bg)',
  },
  body: { display: 'flex', flexDirection: 'column', gap: 12 },
};
