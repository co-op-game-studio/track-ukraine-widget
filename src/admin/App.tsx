/**
 * Admin SPA root component.
 *
 * Single megamenu nav (per CLAUDE.md "Workflow conventions"). All sections
 * live under one menu, grouped into columns:
 *   Workspace | Curation | Admin | Help
 *
 * Routing: react-router-dom v7 HashRouter (hash = no server-config required;
 * CF Workers serves /admin/index.html and the SPA owns everything after #).
 */
import { useEffect, useRef, useState } from 'react';
import { Routes, Route, NavLink, useNavigate, useParams, Navigate } from 'react-router-dom';
import { get } from './fetcher';
import { BillsTab } from './components/BillsTab';
import { PeopleTab } from './components/PeopleTab';
import { CurationTab } from './components/curation/CurationTab';
import { SettingsTab } from './components/settings/SettingsTab';
import { AuditTab } from './components/AuditTab';
import { HelpTab } from './components/help/HelpTab';
import { ThemeToggle } from './components/ThemeToggle';
import { useTheme } from './useTheme';

/* -------------------------------------------------------------------------- */
/*                                  Types                                     */
/* -------------------------------------------------------------------------- */

/** Data passed from Curation > Inbox "Curate" to Curation > Add Quote. */
export interface QuotePrefill {
  bioguideId: string | null;
  sourceUrl: string;
  sourceLabel: string;
  bodyText: string;
  quotedAt: string | null;
  mediaKind: string;
  /** Queue item ID — marked curated after the quote is saved. */
  queueItemId: string;
}

/* -------------------------------------------------------------------------- */
/*                                  Megamenu                                  */
/* -------------------------------------------------------------------------- */

interface MenuLink {
  label: string;
  to: string;
  /** Whether this link should match the current path (exact or prefix). */
  end?: boolean;
}

interface MenuColumn {
  heading: string;
  links: MenuLink[];
}

const COLUMNS: MenuColumn[] = [
  {
    heading: 'Workspace',
    links: [
      { label: 'People',   to: '/people',   end: true },
      { label: 'Bills',    to: '/bills',    end: true },
      { label: 'Activity', to: '/activity', end: true },
    ],
  },
  {
    heading: 'Curation',
    links: [
      // Inbox temporarily hidden — feed not ready for triage workflow.
      // Route still resolves so deep-links don't 404, but it's unlinked.
      { label: 'Add quote',  to: '/curation/add' },
      { label: 'All quotes', to: '/curation/quotes' },
      { label: 'Research',   to: '/curation/research' },
      { label: 'Add by URL', to: '/curation/direct' },
    ],
  },
  {
    heading: 'Admin',
    links: [
      { label: 'Keywords',       to: '/settings/keywords' },
      { label: 'Tags',           to: '/settings/tags' },
      { label: 'Cache',          to: '/settings/cache' },
      { label: 'Poll status',    to: '/settings/poll-status' },
      { label: 'Data freshness', to: '/settings/freshness' },
      { label: 'App config',     to: '/settings/config' },
    ],
  },
  {
    heading: 'Help',
    links: [
      { label: 'Getting started', to: '/help/getting-started' },
      { label: 'Curation guide',  to: '/help/curation' },
      { label: 'People & polls',  to: '/help/people-polls' },
      { label: 'Bills & votes',   to: '/help/bills-votes' },
      { label: 'Scoring',         to: '/help/scoring' },
    ],
  },
];

function Megamenu({ onNavigate }: { onNavigate: () => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        style={{
          ...menuStyles.trigger,
          ...(open ? menuStyles.triggerOpen : {}),
        }}
      >
        <span style={menuStyles.hamburger}>≡</span>
        <span>Menu</span>
        <span style={{ opacity: 0.6 }}>▾</span>
      </button>
      {open && (
        <div style={menuStyles.panel} role="menu">
          {COLUMNS.map((col) => (
            <div key={col.heading} style={menuStyles.column}>
              <div style={menuStyles.columnHeading}>{col.heading}</div>
              {col.links.map((link) => (
                <NavLink
                  key={link.to}
                  to={link.to}
                  end={link.end}
                  onClick={() => { setOpen(false); onNavigate(); }}
                  style={({ isActive }) => ({
                    ...menuStyles.link,
                    ...(isActive ? menuStyles.linkActive : {}),
                  })}
                >
                  {link.label}
                </NavLink>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  App                                       */
/* -------------------------------------------------------------------------- */

export function App() {
  const [whoami, setWhoami] = useState<string | null>(null);
  const [whoamiError, setWhoamiError] = useState<string | null>(null);
  const [quotePrefill, setQuotePrefill] = useState<QuotePrefill | null>(null);
  const navigate = useNavigate();

  useTheme();

  useEffect(() => {
    get<{ email: string }>('/api/admin/whoami')
      .then((r) => setWhoami(r.email))
      .catch((e: { error?: string; detail?: string }) => {
        setWhoamiError(e.detail ?? e.error ?? 'unknown');
      });
  }, []);

  function curateAsQuote(data: QuotePrefill) {
    setQuotePrefill(data);
    navigate('/curation/add');
  }

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <strong style={styles.title}>Track Ukraine — Admin</strong>
          <Megamenu onNavigate={() => {}} />
        </div>
        <div style={styles.headerRight}>
          <span style={styles.whoami}>
            {whoami
              ? `Logged in as ${whoami}`
              : whoamiError
                ? `Auth error: ${whoamiError}`
                : 'Identifying…'}
          </span>
          <ThemeToggle />
        </div>
      </header>
      <main style={styles.body}>
        <Routes>
          <Route path="/people"            element={<PeopleTab initialBioguide={null} />} />
          <Route path="/people/:bioguide"  element={<PeopleTabRoute />} />
          <Route path="/bills"             element={<BillsTab />} />
          <Route path="/curation/:view"    element={<CurationTab onNavigateToPerson={(id) => navigate(`/people/${id}`)} onCurateAsQuote={curateAsQuote} prefill={quotePrefill} onPrefillConsumed={() => setQuotePrefill(null)} />} />
          <Route path="/curation"          element={<Navigate to="/curation/add" replace />} />
          <Route path="/settings/:view"    element={<SettingsTab />} />
          <Route path="/settings"          element={<Navigate to="/settings/keywords" replace />} />
          <Route path="/activity"          element={<AuditTab />} />
          <Route path="/help/:view"        element={<HelpTab />} />
          <Route path="/help"              element={<Navigate to="/help/getting-started" replace />} />
          <Route path="/"                  element={<Navigate to="/people" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function PeopleTabRoute() {
  const { bioguide } = useParams<{ bioguide: string }>();
  return <PeopleTab initialBioguide={bioguide ?? null} />;
}

/* -------------------------------------------------------------------------- */
/*                                  Styles                                    */
/* -------------------------------------------------------------------------- */

const menuStyles: Record<string, React.CSSProperties> = {
  trigger: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: 'var(--tk-bg)',
    color: 'var(--tk-fg)',
    border: '2px solid var(--tk-border-soft)',
    borderRadius: 0,
    padding: '6px 12px',
    cursor: 'pointer',
    fontFamily: 'var(--tk-font)',
    fontSize: 'var(--tk-fs-sm)',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  triggerOpen: {
    background: 'var(--tk-accent)',
    color: 'var(--tk-accent-fg)',
    borderColor: 'var(--tk-accent)',
  },
  hamburger: {
    fontSize: 18,
    lineHeight: 1,
    fontWeight: 900,
  },
  panel: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    left: 0,
    minWidth: 680,
    background: 'var(--tk-surface)',
    border: '2px solid var(--tk-border-soft)',
    boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
    padding: 16,
    display: 'grid',
    gridTemplateColumns: 'repeat(4, minmax(150px, 1fr))',
    gap: 24,
    zIndex: 100,
  },
  column: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  columnHeading: {
    fontSize: 'var(--tk-fs-xs)',
    fontWeight: 900,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: 'var(--tk-muted)',
    paddingBottom: 6,
    marginBottom: 4,
    borderBottom: '1px solid var(--tk-border-soft)',
  },
  link: {
    display: 'block',
    color: 'var(--tk-fg)',
    textDecoration: 'none',
    padding: '6px 10px',
    fontFamily: 'var(--tk-font)',
    fontSize: 'var(--tk-fs-sm)',
    fontWeight: 600,
    border: '2px solid transparent',
    cursor: 'pointer',
  },
  linkActive: {
    background: 'var(--tk-bg)',
    borderColor: 'var(--tk-border-soft)',
    fontWeight: 800,
  },
};

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 20px',
    background: 'var(--tk-surface)',
    borderBottom: '2px solid var(--tk-border-soft)',
    gap: 16,
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  title: {
    fontSize: 'var(--tk-fs-md)',
    fontStyle: 'italic',
    fontWeight: 'var(--tk-fw-black)' as unknown as number,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: 'var(--tk-fg)',
  },
  whoami: {
    color: 'var(--tk-muted)',
    fontSize: 'var(--tk-fs-sm)',
  },
  body: {
    flex: 1,
    overflow: 'auto',
    padding: 20,
  },
};

// Backfill removed in v4.1.0: ingest is owned by `lw bills backfill` running
// in CI. The runtime stack never drives ingest — see memory
// `feedback_seeding_is_buildops_not_runtime` + docs/spec.md FR-59.
