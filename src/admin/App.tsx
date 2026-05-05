/**
 * Admin SPA root component.
 *
 * Single megamenu nav (per CLAUDE.md "Workflow conventions"). All sections
 * live under one menu, grouped into columns:
 *   People | Bills | Curation { Inbox, Add quote, Quotes, Research, Direct add }
 *   | Activity | Settings { Keywords, Tags, Poll status, App config }
 *
 * Hash-routing keeps deep-links working (e.g. #/people/B001234 opens the
 * profile in a new tab; #/settings/tags lands on the Tags CRUD).
 */
import { useEffect, useRef, useState } from 'react';
import { get, post } from './fetcher';
import { BillsTab } from './components/BillsTab';
import { PeopleTab } from './components/PeopleTab';
import { CurationTab, type CurationView } from './components/curation/CurationTab';
import { SettingsTab, type SettingsView } from './components/settings/SettingsTab';
import { AuditTab } from './components/AuditTab';
import { HelpTab, type HelpView } from './components/help/HelpTab';
import { ThemeToggle } from './components/ThemeToggle';
import { useTheme } from './useTheme';

/* -------------------------------------------------------------------------- */
/*                                  Types                                     */
/* -------------------------------------------------------------------------- */

export type Section = 'people' | 'bills' | 'curation' | 'activity' | 'settings' | 'help';

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

interface RouteState {
  section: Section;
  /** When section === 'people', the optional bioguide selector. */
  bioguide: string | null;
  /** When section === 'curation', the sub-view. */
  curationView: CurationView;
  /** When section === 'settings', the sub-view. */
  settingsView: SettingsView;
  /** When section === 'help', the sub-view. */
  helpView: HelpView;
}

/* -------------------------------------------------------------------------- */
/*                              Hash routing                                  */
/* -------------------------------------------------------------------------- */

const VALID_SECTIONS: Section[] = ['people', 'bills', 'curation', 'activity', 'settings', 'help'];
const VALID_CURATION: CurationView[] = ['inbox', 'add', 'quotes', 'research', 'direct'];
const VALID_SETTINGS: SettingsView[] = ['keywords', 'tags', 'cache', 'poll-status', 'config'];
const VALID_HELP: HelpView[] = ['getting-started', 'curation', 'people-polls', 'bills-votes', 'scoring'];

function parseHash(hash: string): RouteState {
  const clean = hash.replace(/^#\/?/, '');
  const parts = clean.split('/').filter(Boolean);
  const first = parts[0] ?? 'people';
  const section: Section = (VALID_SECTIONS as string[]).includes(first) ? (first as Section) : 'people';

  let bioguide: string | null = null;
  let curationView: CurationView = 'inbox';
  let settingsView: SettingsView = 'keywords';
  let helpView: HelpView = 'getting-started';

  if (section === 'people' && parts[1]) {
    bioguide = parts[1];
  }
  if (section === 'curation' && parts[1] && (VALID_CURATION as string[]).includes(parts[1])) {
    curationView = parts[1] as CurationView;
  }
  if (section === 'settings' && parts[1] && (VALID_SETTINGS as string[]).includes(parts[1])) {
    settingsView = parts[1] as SettingsView;
  }
  if (section === 'help' && parts[1] && (VALID_HELP as string[]).includes(parts[1])) {
    helpView = parts[1] as HelpView;
  }

  return { section, bioguide, curationView, settingsView, helpView };
}

function buildHash(state: RouteState): string {
  if (state.section === 'people' && state.bioguide) return `#/people/${state.bioguide}`;
  if (state.section === 'curation') return `#/curation/${state.curationView}`;
  if (state.section === 'settings') return `#/settings/${state.settingsView}`;
  if (state.section === 'help') return `#/help/${state.helpView}`;
  return `#/${state.section}`;
}

/* -------------------------------------------------------------------------- */
/*                                  Megamenu                                  */
/* -------------------------------------------------------------------------- */

interface MenuLink {
  label: string;
  href: string;
  isActive: (s: RouteState) => boolean;
  onClick: () => void;
}

interface MenuColumn {
  heading: string;
  links: MenuLink[];
}

function Megamenu({
  state,
  navigate,
  open,
  setOpen,
}: {
  state: RouteState;
  navigate: (next: Partial<RouteState>) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
}): React.ReactElement {
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
  }, [open, setOpen]);

  const columns: MenuColumn[] = [
    {
      heading: 'Workspace',
      links: [
        { label: 'People', href: '#/people', isActive: (s) => s.section === 'people', onClick: () => navigate({ section: 'people', bioguide: null }) },
        { label: 'Bills', href: '#/bills', isActive: (s) => s.section === 'bills', onClick: () => navigate({ section: 'bills' }) },
        { label: 'Activity', href: '#/activity', isActive: (s) => s.section === 'activity', onClick: () => navigate({ section: 'activity' }) },
      ],
    },
    {
      heading: 'Curation',
      links: [
        { label: 'Inbox', href: '#/curation/inbox', isActive: (s) => s.section === 'curation' && s.curationView === 'inbox', onClick: () => navigate({ section: 'curation', curationView: 'inbox' }) },
        { label: 'Add quote', href: '#/curation/add', isActive: (s) => s.section === 'curation' && s.curationView === 'add', onClick: () => navigate({ section: 'curation', curationView: 'add' }) },
        { label: 'All quotes', href: '#/curation/quotes', isActive: (s) => s.section === 'curation' && s.curationView === 'quotes', onClick: () => navigate({ section: 'curation', curationView: 'quotes' }) },
        { label: 'Research', href: '#/curation/research', isActive: (s) => s.section === 'curation' && s.curationView === 'research', onClick: () => navigate({ section: 'curation', curationView: 'research' }) },
        { label: 'Add by URL', href: '#/curation/direct', isActive: (s) => s.section === 'curation' && s.curationView === 'direct', onClick: () => navigate({ section: 'curation', curationView: 'direct' }) },
      ],
    },
    {
      heading: 'Admin',
      links: [
        { label: 'Keywords', href: '#/settings/keywords', isActive: (s) => s.section === 'settings' && s.settingsView === 'keywords', onClick: () => navigate({ section: 'settings', settingsView: 'keywords' }) },
        { label: 'Tags', href: '#/settings/tags', isActive: (s) => s.section === 'settings' && s.settingsView === 'tags', onClick: () => navigate({ section: 'settings', settingsView: 'tags' }) },
        { label: 'Cache', href: '#/settings/cache', isActive: (s) => s.section === 'settings' && s.settingsView === 'cache', onClick: () => navigate({ section: 'settings', settingsView: 'cache' }) },
        { label: 'Poll status', href: '#/settings/poll-status', isActive: (s) => s.section === 'settings' && s.settingsView === 'poll-status', onClick: () => navigate({ section: 'settings', settingsView: 'poll-status' }) },
        { label: 'App config', href: '#/settings/config', isActive: (s) => s.section === 'settings' && s.settingsView === 'config', onClick: () => navigate({ section: 'settings', settingsView: 'config' }) },
      ],
    },
    {
      heading: 'Help',
      links: [
        { label: 'Getting started', href: '#/help/getting-started', isActive: (s) => s.section === 'help' && s.helpView === 'getting-started', onClick: () => navigate({ section: 'help', helpView: 'getting-started' }) },
        { label: 'Curation guide', href: '#/help/curation', isActive: (s) => s.section === 'help' && s.helpView === 'curation', onClick: () => navigate({ section: 'help', helpView: 'curation' }) },
        { label: 'People & polls', href: '#/help/people-polls', isActive: (s) => s.section === 'help' && s.helpView === 'people-polls', onClick: () => navigate({ section: 'help', helpView: 'people-polls' }) },
        { label: 'Bills & votes', href: '#/help/bills-votes', isActive: (s) => s.section === 'help' && s.helpView === 'bills-votes', onClick: () => navigate({ section: 'help', helpView: 'bills-votes' }) },
        { label: 'Scoring', href: '#/help/scoring', isActive: (s) => s.section === 'help' && s.helpView === 'scoring', onClick: () => navigate({ section: 'help', helpView: 'scoring' }) },
      ],
    },
  ];

  // Compute the breadcrumb trail for the trigger button label.
  const trigger = (() => {
    if (state.section === 'people') return state.bioguide ? `People · ${state.bioguide}` : 'People';
    if (state.section === 'bills') return 'Bills';
    if (state.section === 'curation') {
      const sub = columns[1]!.links.find((l) => l.isActive(state));
      return `Curation · ${sub?.label ?? 'Inbox'}`;
    }
    if (state.section === 'settings') {
      const sub = columns[2]!.links.find((l) => l.isActive(state));
      return `Admin · ${sub?.label ?? 'Keywords'}`;
    }
    if (state.section === 'help') {
      const sub = columns[3]!.links.find((l) => l.isActive(state));
      return `Help · ${sub?.label ?? 'Getting started'}`;
    }
    return 'Activity';
  })();

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        style={{
          ...menuStyles.trigger,
          ...(open ? menuStyles.triggerOpen : {}),
        }}
      >
        <span style={menuStyles.hamburger}>≡</span>
        <span>{trigger}</span>
        <span style={{ opacity: 0.6 }}>▾</span>
      </button>
      {open && (
        <div style={menuStyles.panel} role="menu">
          {columns.map((col) => (
            <div key={col.heading} style={menuStyles.column}>
              <div style={menuStyles.columnHeading}>{col.heading}</div>
              {col.links.map((link) => {
                const active = link.isActive(state);
                return (
                  <a
                    key={link.href}
                    href={link.href}
                    onClick={(e) => {
                      // Allow ctrl/middle-click to open in new tab; intercept plain clicks.
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
                      e.preventDefault();
                      link.onClick();
                      setOpen(false);
                    }}
                    style={{
                      ...menuStyles.link,
                      ...(active ? menuStyles.linkActive : {}),
                    }}
                  >
                    {link.label}
                  </a>
                );
              })}
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
  // Initialize from URL hash so deep-links land on the right view.
  const initial = parseHash(typeof window !== 'undefined' ? window.location.hash : '');
  const [state, setState] = useState<RouteState>(initial);
  const [whoami, setWhoami] = useState<string | null>(null);
  const [whoamiError, setWhoamiError] = useState<string | null>(null);
  const [quotePrefill, setQuotePrefill] = useState<QuotePrefill | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useTheme();
  useAutoBackfill(whoami);

  function navigate(patch: Partial<RouteState>) {
    setState((prev) => ({ ...prev, ...patch }));
  }

  // Browser back/forward → restore state from the hash.
  useEffect(() => {
    function onPopState() {
      setState(parseHash(window.location.hash));
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Mirror state → hash. First render uses replaceState; subsequent uses pushState
  // so the back button steps through navigation history.
  const firstRender = useRef(true);
  useEffect(() => {
    const hash = buildHash(state);
    if (window.location.hash === hash) return;
    if (firstRender.current) {
      firstRender.current = false;
      window.history.replaceState(null, '', hash);
    } else {
      window.history.pushState(null, '', hash);
    }
  }, [state]);

  function navigateToPerson(bioguideId: string) {
    navigate({ section: 'people', bioguide: bioguideId });
  }

  function curateAsQuote(data: QuotePrefill) {
    setQuotePrefill(data);
    navigate({ section: 'curation', curationView: 'add' });
  }

  useEffect(() => {
    get<{ email: string }>('/api/admin/whoami')
      .then((r) => setWhoami(r.email))
      .catch((e: { error?: string; detail?: string }) => {
        setWhoamiError(e.detail ?? e.error ?? 'unknown');
      });
  }, []);

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <strong style={styles.title}>Track Ukraine — Admin</strong>
          <Megamenu state={state} navigate={navigate} open={menuOpen} setOpen={setMenuOpen} />
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
        {state.section === 'people' && <PeopleTab initialBioguide={state.bioguide} />}
        {state.section === 'bills' && <BillsTab />}
        {state.section === 'curation' && (
          <CurationTab
            view={state.curationView}
            onChangeView={(v) => navigate({ section: 'curation', curationView: v })}
            onNavigateToPerson={navigateToPerson}
            onCurateAsQuote={curateAsQuote}
            prefill={quotePrefill}
            onPrefillConsumed={() => setQuotePrefill(null)}
          />
        )}
        {state.section === 'settings' && (
          <SettingsTab
            view={state.settingsView}
            onChangeView={(v) => navigate({ section: 'settings', settingsView: v })}
          />
        )}
        {state.section === 'activity' && <AuditTab />}
        {state.section === 'help' && (
          <HelpTab
            view={state.helpView}
            onChangeView={(v) => navigate({ section: 'help', helpView: v })}
          />
        )}
      </main>
    </div>
  );
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
    minWidth: 600,
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

/* -------------------------------------------------------------------------- */
/*                              Auto-backfill                                 */
/* -------------------------------------------------------------------------- */

const BACKFILL_VERSION = 'v4-2026-05-03-cr-citations';
const BACKFILL_DONE_FLAG = 'tk-backfilled';
const BACKFILL_CURSOR_KEY = 'tk-backfill-cursor';
function useAutoBackfill(whoami: string | null) {
  useEffect(() => {
    if (!whoami) return;
    let cancelled = false;
    let after = '';
    try {
      const flag = window.localStorage.getItem(BACKFILL_DONE_FLAG);
      if (flag === BACKFILL_VERSION) return;
      after = window.localStorage.getItem(BACKFILL_CURSOR_KEY) ?? '';
    } catch {
      return;
    }

    async function loop() {
      let totalOk = 0;
      let totalFailed = 0;
      for (let i = 0; i < 100 && !cancelled; i++) {
        try {
          const url = `/api/admin/backfill-bills?limit=3${after ? `&after=${encodeURIComponent(after)}` : ''}`;
          const r = await post<{
            processed: number;
            ok: number;
            failed: number;
            next_after: string | null;
            done: boolean;
            summary: Array<{ bill_id: string; ok: boolean; error?: string }>;
          }>(url, {});
          totalOk += r.ok;
          totalFailed += r.failed;
          for (const s of r.summary) {
            if (!s.ok) {
              // eslint-disable-next-line no-console
              console.warn('[backfill] failed:', s.bill_id, s.error);
            }
          }
          if (r.done) {
            window.localStorage.setItem(BACKFILL_DONE_FLAG, BACKFILL_VERSION);
            window.localStorage.removeItem(BACKFILL_CURSOR_KEY);
            // eslint-disable-next-line no-console
            console.info('[backfill] complete', { ok: totalOk, failed: totalFailed });
            return;
          }
          after = r.next_after ?? '';
          window.localStorage.setItem(BACKFILL_CURSOR_KEY, after);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[backfill] chunk failed; will retry on next load:', e);
          return;
        }
      }
    }
    void loop();
    return () => {
      cancelled = true;
    };
  }, [whoami]);
}
