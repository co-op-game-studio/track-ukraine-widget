/**
 * Help section — static researcher documentation.
 * Sub-nav mirrors the SettingsTab pattern; all content is fully static (no API calls).
 */
import { GettingStarted } from './GettingStarted';
import { CurationGuide } from './CurationGuide';
import { PeopleAndPolls } from './PeopleAndPolls';
import { BillsAndVotes } from './BillsAndVotes';
import { ScoringExplained } from './ScoringExplained';

export type HelpView = 'getting-started' | 'curation' | 'people-polls' | 'bills-votes' | 'scoring';

interface ViewSpec {
  id: HelpView;
  label: string;
  help: string;
}

const VIEWS: ViewSpec[] = [
  { id: 'getting-started', label: 'Getting started', help: 'Orientation for new researchers' },
  { id: 'curation',        label: 'Curation guide',  help: 'How to score statements and manage the inbox' },
  { id: 'people-polls',    label: 'People & polls',  help: 'Handles, polling, and rep profiles' },
  { id: 'bills-votes',     label: 'Bills & votes',   help: 'How bill data flows and what you can edit' },
  { id: 'scoring',         label: 'Scoring',         help: 'How the Ukraine score is computed' },
];

export function HelpTab({
  view,
  onChangeView,
}: {
  view: HelpView;
  onChangeView: (v: HelpView) => void;
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
        {view === 'getting-started' && <GettingStarted />}
        {view === 'curation'        && <CurationGuide />}
        {view === 'people-polls'    && <PeopleAndPolls />}
        {view === 'bills-votes'     && <BillsAndVotes />}
        {view === 'scoring'         && <ScoringExplained />}
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
    whiteSpace: 'nowrap',
  },
  subTabActive: {
    color: 'var(--tk-fg)',
    borderColor: 'var(--tk-border-soft)',
    background: 'var(--tk-bg)',
  },
  body: {
    padding: '8px 0',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
};
