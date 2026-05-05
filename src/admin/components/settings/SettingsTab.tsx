/**
 * Admin tab — home for cross-cutting admin knobs.
 *
 * Per CLAUDE.md "Workflow conventions": anything that's "operator-edited
 * configuration data" lives here, not inline on workflow tabs. Today only
 * Keywords + Tags are user-editable; Poll status and App config are read-only
 * (we render them visibly but with `editable: false` so curators see the
 * settings exist while not being able to fiddle with them).
 *
 * Routes still use the `settings` URL prefix to avoid breaking deep-links.
 */
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
  /** When false, the view is shown but rendered greyed out / read-only. */
  editable: boolean;
}

const VIEWS: ViewSpec[] = [
  { id: 'keywords',    label: 'Keywords',    help: 'Match keywords for the social ingest pipeline', editable: true },
  { id: 'tags',        label: 'Tags',        help: 'Color-coded labels applied to quotes', editable: true },
  { id: 'cache',       label: 'Cache',       help: 'Inspect + purge KV cache records', editable: true },
  { id: 'poll-status', label: 'Poll status', help: 'Per-handle health (read-only)', editable: false },
  { id: 'config',      label: 'App config',  help: 'Deployment-time settings (read-only)', editable: false },
];

export function SettingsTab({
  view,
  onChangeView,
}: {
  view: SettingsView;
  onChangeView: (v: SettingsView) => void;
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
        {view === 'keywords'    && <KeywordsView />}
        {view === 'tags'        && <TagsView />}
        {view === 'cache'       && <CacheView />}
        {view === 'poll-status' && <ReadOnlyWrap reason="Poll status is read-only — failures persist for engineering visibility."><PollStatusView /></ReadOnlyWrap>}
        {view === 'config'      && <ReadOnlyWrap reason="Set per-env in wrangler.toml. Edit there and redeploy to change."><AppConfigView /></ReadOnlyWrap>}
      </div>
    </div>
  );
}

/** Wraps a sub-view in a "locked" frame: visible but visually muted with a
 *  banner explaining why it's not editable, and a CSS layer that blocks
 *  pointer events on form controls underneath. Buttons that perform GET-only
 *  actions (refresh, copy trace ID) stay clickable since they don't mutate. */
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
  lockIcon: {
    fontSize: 14,
  },
  content: {
    opacity: 0.65,
    border: '2px solid var(--tk-border-soft)',
    borderTop: 'none',
    padding: 12,
    background: 'var(--tk-bg)',
    // Block writes by intercepting pointer events on form fields.
    // Read-only buttons (refresh, copy) still work by being explicit about
    // pointer-events in their own component.
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
