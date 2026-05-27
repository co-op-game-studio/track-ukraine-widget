/**
 * Help section — static researcher documentation.
 * Sub-views driven by React Router via /help/:view.
 */
import { NavLink, useParams, Navigate } from 'react-router-dom';
import { GettingStarted } from './GettingStarted';
import { CurationGuide } from './CurationGuide';
import { PeopleAndPolls } from './PeopleAndPolls';
import { BillsAndVotes } from './BillsAndVotes';
import { ScoringExplained } from './ScoringExplained';

export type HelpView = 'getting-started' | 'curation' | 'people-polls' | 'bills-votes' | 'scoring';

const VIEWS: Array<{ id: HelpView; label: string; help: string }> = [
  { id: 'getting-started', label: 'Getting started', help: 'Orientation for new researchers' },
  { id: 'curation',        label: 'Curation guide',  help: 'How to score statements and manage the inbox' },
  { id: 'people-polls',    label: 'People & polls',  help: 'Handles, polling, and rep profiles' },
  { id: 'bills-votes',     label: 'Bills & votes',   help: 'How bill data flows and what you can edit' },
  { id: 'scoring',         label: 'Scoring',         help: 'How the Ukraine score is computed' },
];

const VALID: Set<string> = new Set(VIEWS.map((v) => v.id));

export function HelpTab() {
  const { view = 'getting-started' } = useParams<{ view: string }>();
  if (!VALID.has(view)) return <Navigate to="/help/getting-started" replace />;

  return (
    <div style={styles.root}>
      <nav style={styles.subNav}>
        {VIEWS.map((v) => (
          <NavLink
            key={v.id}
            to={`/help/${v.id}`}
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
  body: {
    padding: '8px 0',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
};
