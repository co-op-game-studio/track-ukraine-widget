/**
 * Admin settings tab. Sub-views driven by React Router via /settings/:view.
 *
 * Per CLAUDE.md: anything "operator-edited configuration data" lives here.
 * Poll status and App config are read-only (shown but wrapped in ReadOnlyWrap).
 */
import { NavLink, useParams, Navigate } from 'react-router-dom';
import { KeywordsView } from '../SocialFeedTab';
import { TagsView } from './TagsView';
import { PollStatusView } from './PollStatusView';
import { AppConfigView } from './AppConfigView';
import { CacheView } from './CacheView';

export type SettingsView = 'keywords' | 'tags' | 'cache' | 'poll-status' | 'config';

interface ViewSpec {
  id: SettingsView;
  label: string;
  help: string;
  editable: boolean;
}

const VIEWS: ViewSpec[] = [
  { id: 'keywords',    label: 'Keywords',    help: 'Match keywords for the social ingest pipeline', editable: true },
  { id: 'tags',        label: 'Tags',        help: 'Color-coded labels applied to quotes', editable: true },
  { id: 'cache',       label: 'Cache',       help: 'Inspect + purge KV cache records', editable: true },
  { id: 'poll-status', label: 'Poll status', help: 'Per-handle health (read-only)', editable: false },
  { id: 'config',      label: 'App config',  help: 'Deployment-time settings (read-only)', editable: false },
];

const VALID: Set<string> = new Set(VIEWS.map((v) => v.id));

export function SettingsTab() {
  const { view = 'keywords' } = useParams<{ view: string }>();
  if (!VALID.has(view)) return <Navigate to="/settings/keywords" replace />;

  return (
    <div style={styles.root}>
      <nav style={styles.subNav}>
        {VIEWS.map((v) => (
          <NavLink
            key={v.id}
            to={`/settings/${v.id}`}
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
        {view === 'keywords'    && <KeywordsView />}
        {view === 'tags'        && <TagsView />}
        {view === 'cache'       && <CacheView />}
        {view === 'poll-status' && <ReadOnlyWrap reason="Poll status is read-only — failures persist for engineering visibility."><PollStatusView /></ReadOnlyWrap>}
        {view === 'config'      && <ReadOnlyWrap reason="Set per-env in wrangler.toml. Edit there and redeploy to change."><AppConfigView /></ReadOnlyWrap>}
      </div>
    </div>
  );
}

function ReadOnlyWrap({ children, reason }: { children: React.ReactNode; reason: string }) {
  return (
    <div style={lockStyles.wrap}>
      <div style={lockStyles.banner}>
        <span style={lockStyles.lockIcon}>🔒</span>
        <span><strong>Read-only.</strong> {reason}</span>
      </div>
      <div style={lockStyles.content}>
        {children}
      </div>
    </div>
  );
}

const lockStyles: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 0 },
  banner: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    background: 'var(--tk-surface)',
    border: '2px solid var(--tk-border-soft)',
    borderBottom: 'none',
    color: 'var(--tk-muted)',
    fontSize: 'var(--tk-fs-sm)',
  },
  lockIcon: { fontSize: 14 },
  content: {
    opacity: 0.65,
    border: '2px solid var(--tk-border-soft)',
    borderTop: 'none',
    padding: 12,
    background: 'var(--tk-bg)',
  },
};

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
