/**
 * Social Feed tab — replaces the old "Statements" (SocialPostsTab).
 *
 * Two modes:
 *   1. Queue — rolling feed of auto-ingested posts, filterable by keyword
 *      match, platform, MoC. Researchers triage (curate / dismiss).
 *   2. Direct — paste a URL or search by congressperson + platform.
 *
 * All member lookups use a typeahead MoC picker with photos + party colors.
 * Non-MoC accounts supported via account categories (influencer, journalist,
 * bureaucrat, etc.).
 *
 * Traces: FR-59.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { get, post, patch } from '../fetcher';
import { MocPicker, partyStyle } from './MocPicker';
import type { MocEntry } from './MocPicker';
import { useAvailablePlatforms } from '../hooks/useAvailablePlatforms';

/* ---------- Types ---------- */

interface QueueItem {
  id: string;
  bioguide_id: string | null;
  platform: string;
  platform_post_id: string;
  author_handle: string;
  posted_at: string;
  url: string;
  body_text: string;
  media_refs_json: string;
  ingested_at: string;
  status: string;
  matched_keywords: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

interface KeywordRow {
  id: string;
  watch_name: string;
  pattern: string;
  is_regex: number;
  active: number;
  notify: number;
}

interface FetchedPost {
  platform: string;
  platformPostId: string;
  authorHandle: string;
  authorPlatformId: string;
  postedAt: string;
  url: string;
  bodyText: string;
  mediaRefs: Array<{ kind: string; url: string; alt?: string }>;
}

/* ---------- Platform icons ---------- */

const PLATFORM_LABELS: Record<string, string> = {
  bluesky: 'Bluesky',
  youtube: 'YouTube',
  mastodon: 'Mastodon',
  twitter: 'Twitter / X',
};

/* The platform list comes from the backend's live registry (`useAvailablePlatforms`).
 * A platform appears in the UI only when its adapter is registered AND its live
 * health-check passed — so an unset Twitter token, an expired Meta token, or an
 * exhausted YouTube quota all hide the platform from researchers automatically. */

/* ACCOUNT_CATEGORIES moved to PeopleTab.tsx */

/* ---------- Sub-views ---------- */

type SubView = 'direct' | 'research' | 'queue' | 'keywords';

export function SocialFeedTab({ onNavigateToPerson, onCurateAsQuote }: {
  onNavigateToPerson?: (bioguideId: string) => void;
  onCurateAsQuote?: (data: import('../App').QuotePrefill) => void;
}) {
  const [view, setView] = useState<SubView>('direct');

  return (
    <div style={styles.root}>
      <div style={styles.subNav}>
        {([
          ['direct', 'Add by URL'],
          ['research', 'Research'],
          ['queue', 'Feed Queue'],
          ['keywords', 'Keywords'],
        ] as [SubView, string][]).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setView(id)}
            style={{
              ...styles.subTab,
              ...(view === id ? styles.subTabActive : {}),
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'direct' && <DirectAddView />}
      {view === 'research' && <ResearchView onNavigateToPerson={onNavigateToPerson} onCurateAsQuote={onCurateAsQuote} />}
      {view === 'queue' && <QueueView onCurateAsQuote={onCurateAsQuote} />}
      {view === 'keywords' && <KeywordsView />}
    </div>
  );
}

/* ========================================================================== */
/*                              Research view                                 */
/* ========================================================================== */

interface SearchPlatformResult {
  posts: FetchedPost[];
  handle: string | null;
  error?: string;
}

export function ResearchView({
  onNavigateToPerson,
  onCurateAsQuote,
}: {
  onNavigateToPerson?: (bioguideId: string) => void;
  onCurateAsQuote?: (data: import('../App').QuotePrefill) => void;
}) {
  const [selectedMoc, setSelectedMoc] = useState<MocEntry | null>(null);
  const [filterTerms, setFilterTerms] = useState('');
  // Tracks per-post curate state so the button can show "Enqueueing…" without
  // a global spinner. Map<postKey, 'idle' | 'pending' | 'error'> where postKey
  // is `${platform}:${platformPostId}`.
  const [curateState, setCurateState] = useState<Record<string, 'pending' | 'error'>>({});

  // Handles for the selected person.
  const [handles, setHandles] = useState<{ platform: string; handle: string }[]>([]);
  const [loadingHandles, setLoadingHandles] = useState(false);

  // Platform toggles.
  const [platformOverrides, setPlatformOverrides] = useState<Set<string> | null>(null);

  // Feed results.
  const [feedResults, setFeedResults] = useState<Record<string, SearchPlatformResult> | null>(null);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);

  // Load handles when person is selected.
  useEffect(() => {
    if (!selectedMoc) {
      setHandles([]);
      setFeedResults(null);
      setPlatformOverrides(null);
      return;
    }
    setLoadingHandles(true);
    get<{ items: Array<{ platform: string; handle: string; bioguide_id: string | null }> }>(
      `/api/admin/ingest/handles?includeInactive=false`,
    )
      .then((r) => {
        const matched = r.items
          .filter((h) => h.bioguide_id === selectedMoc.bioguideId)
          .map((h) => ({ platform: h.platform, handle: h.handle }));
        setHandles(matched);
      })
      .catch(() => {})
      .finally(() => setLoadingHandles(false));
  }, [selectedMoc]);

  const availablePlatforms = useAvailablePlatforms();
  const availableSet = useMemo(
    () => new Set(availablePlatforms.filter((p) => p.available).map((p) => p.slug)),
    [availablePlatforms],
  );
  const linkedPlatforms = [...new Set(handles.map((h) => h.platform))].filter((p) => availableSet.has(p));
  const activePlatforms = platformOverrides ? [...platformOverrides] : linkedPlatforms;

  function togglePlatform(p: string) {
    setPlatformOverrides((prev) => {
      const current = prev ?? new Set(linkedPlatforms);
      const next = new Set(current);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  }

  async function fetchFeed() {
    if (!selectedMoc) return;
    setFeedLoading(true);
    setFeedResults(null);
    setFeedError(null);
    try {
      const r = await post<{ bioguideId: string; results: Record<string, SearchPlatformResult> }>(
        '/api/admin/ingest/search',
        {
          bioguide_id: selectedMoc.bioguideId,
          platforms: activePlatforms,
          max_posts: 50,
          filter_terms: filterTerms.trim() || undefined,
        },
      );
      setFeedResults(r.results);
    } catch (e) {
      setFeedError(errorMsg(e));
    } finally {
      setFeedLoading(false);
    }
  }

  /**
   * Send a Research-discovered post into the curation pipeline:
   *   1. Enqueue the post (POST /api/admin/ingest/queue) so it gets a real
   *      queue row that can be marked `curated` later. If we've already
   *      ingested this exact post (auto-cron or prior research click), the
   *      backend returns the existing row instead of erroring.
   *   2. Hand the prefill to AddQuoteView via onCurateAsQuote — same handoff
   *      Inbox uses, so the flow is identical from the researcher's POV.
   */
  async function curatePost(p: FetchedPost) {
    if (!selectedMoc || !onCurateAsQuote) return;
    const key = `${p.platform}:${p.platformPostId}`;
    setCurateState((s) => ({ ...s, [key]: 'pending' }));
    try {
      const r = await post<{ row: { id: string } | null; deduped: boolean }>(
        '/api/admin/ingest/queue',
        {
          bioguide_id: selectedMoc.bioguideId,
          platform: p.platform,
          platform_post_id: p.platformPostId,
          author_handle: p.authorHandle,
          posted_at: p.postedAt,
          url: p.url,
          body_text: p.bodyText,
          media_refs_json: JSON.stringify(p.mediaRefs ?? []),
        },
      );
      if (!r.row) throw new Error('Could not enqueue post (no row returned).');
      onCurateAsQuote({
        bioguideId: selectedMoc.bioguideId,
        sourceUrl: p.url,
        sourceLabel: `${PLATFORM_LABELS[p.platform] ?? p.platform} — @${p.authorHandle}`,
        bodyText: p.bodyText,
        quotedAt: p.postedAt,
        mediaKind: 'social',
        queueItemId: r.row.id,
      });
      // Don't clear the per-card state — leave it pending so the button stays
      // visibly disabled until the researcher navigates away.
    } catch (e) {
      setCurateState((s) => ({ ...s, [key]: 'error' }));
      // eslint-disable-next-line no-console
      console.error('[research/curate] failed:', errorMsg(e));
    }
  }

  const ps = selectedMoc ? partyStyle(selectedMoc.party) : null;
  const totalPosts = feedResults
    ? Object.values(feedResults).reduce((n, r) => n + r.posts.length, 0)
    : 0;

  return (
    <div style={styles.section}>
      {/* Person picker */}
      <div style={styles.toolRow}>
        <MocPicker
          value={selectedMoc}
          onChange={(m) => { setSelectedMoc(m); setFeedResults(null); setPlatformOverrides(null); }}
          placeholder="Select person to research…"
        />
      </div>

      {/* Once a person is selected: platform toggles + search filter + fetch */}
      {selectedMoc && (
        <>
          {loadingHandles ? (
            <div style={styles.muted}>Loading handles…</div>
          ) : linkedPlatforms.length === 0 ? (
            <div style={styles.noHandle}>
              No social handles linked for {selectedMoc.displayName}.
              <span style={{ color: 'var(--tk-muted)' }}> Add handles in the People tab first.</span>
            </div>
          ) : (
            <>
              <div style={styles.toolRow}>
                {linkedPlatforms.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => togglePlatform(p)}
                    style={{
                      ...styles.platformToggle,
                      ...(activePlatforms.includes(p) ? styles.platformToggleActive : {}),
                    }}
                  >
                    {PLATFORM_LABELS[p] ?? p}
                  </button>
                ))}
              </div>

              <div style={styles.toolRow}>
                <input
                  type="text"
                  value={filterTerms}
                  onChange={(e) => setFilterTerms(e.target.value)}
                  placeholder="Filter by keyword (optional, regex supported)…"
                  style={{ ...styles.input, flex: 1 }}
                  onKeyDown={(e) => e.key === 'Enter' && fetchFeed()}
                />
                <button
                  type="button"
                  onClick={fetchFeed}
                  disabled={feedLoading || activePlatforms.length === 0}
                  style={styles.actionBtn}
                >
                  {feedLoading ? 'Fetching…' : 'Fetch feed'}
                </button>
                {onNavigateToPerson && (
                  <button
                    type="button"
                    onClick={() => onNavigateToPerson(selectedMoc.bioguideId)}
                    style={{ ...styles.actionBtn, background: 'var(--tk-surface)', color: 'var(--tk-fg)', border: '2px solid var(--tk-border-soft)' }}
                  >
                    View profile
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}

      {feedError && <div style={styles.error}>{feedError}</div>}

      {/* Results */}
      {feedResults && (
        <div style={{ fontSize: 'var(--tk-fs-sm)', color: 'var(--tk-muted)', marginTop: 4 }}>
          {totalPosts} posts across {Object.keys(feedResults).length} platforms
          {filterTerms.trim() ? ` matching "${filterTerms.trim()}"` : ''}
        </div>
      )}

      {feedResults && Object.entries(feedResults).map(([platform, pr]) => (
        <div key={platform}>
          <h4 style={styles.sectionHead}>
            {PLATFORM_LABELS[platform] ?? platform}
            {pr.handle ? ` — @${pr.handle}` : ''}
            {pr.posts.length > 0 ? ` (${pr.posts.length})` : ''}
          </h4>
          {pr.error === 'no_handle' && (
            <div style={styles.noHandle}>
              No {PLATFORM_LABELS[platform] ?? platform} handle linked.
            </div>
          )}
          {pr.error && pr.error !== 'no_handle' && (
            <div style={styles.error}>Error: {pr.error}</div>
          )}
          {!pr.error && pr.posts.length === 0 && (
            <div style={styles.muted}>No posts found</div>
          )}
          {pr.posts.map((p, i) => {
            const key = `${p.platform}:${p.platformPostId}`;
            const state = curateState[key];
            return (
              <div key={i} style={{
                ...styles.queueCard,
                borderLeftWidth: 3,
                borderLeftColor: ps?.accent ?? 'var(--tk-border-soft)',
              }}>
                <div style={styles.queueHeader}>
                  <span style={styles.platformBadge}>
                    {PLATFORM_LABELS[p.platform] ?? p.platform}
                  </span>
                  <span style={styles.handle}>@{p.authorHandle}</span>
                  <a href={p.url} target="_blank" rel="noopener noreferrer" style={{ ...styles.link, fontSize: 'var(--tk-fs-xs)' }}>
                    View original ↗
                  </a>
                  <span style={{ flex: 1 }} />
                  <span style={styles.date}>
                    {new Date(p.postedAt).toLocaleDateString()}
                  </span>
                </div>
                <div style={styles.bodyText}>
                  {p.bodyText.slice(0, 500)}{p.bodyText.length > 500 ? '…' : ''}
                </div>
                <div style={styles.cardActions}>
                  {onCurateAsQuote && (
                    <button
                      type="button"
                      onClick={() => curatePost(p)}
                      disabled={state === 'pending'}
                      style={styles.curateBtn}
                      title="Send this post to Add Quote with the body and source pre-filled."
                    >
                      {state === 'pending' ? 'Sending…' : state === 'error' ? 'Retry curate' : 'Curate as Quote'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ========================================================================== */
/*                               Queue view                                   */
/* ========================================================================== */

/** A single log entry from the poll run. */
interface PollLogEntry {
  time: string;
  platform: string;
  handle: string;
  displayName: string | null;
  /** When this handle was last successfully polled BEFORE this run (for context). */
  lastPolledAt: string | null;
  status: 'ok' | 'error' | 'skipped';
  newPosts: number;
  duplicates: number;
  keywordMatches: number;
  /** ms the request took (for ok/error). */
  durationMs?: number;
  error?: string;
  /** Reason for skip (e.g. "polled 4m ago"). */
  skipReason?: string;
}

interface HandleInfo {
  id: string;
  platform: string;
  handle: string;
  display_name: string | null;
  bioguide_id: string | null;
  last_polled_at: string | null;
  last_seen_post_id: string | null;
}

/** Default frontend concurrency for the per-handle poll fan-out. Used only as
 *  a fallback when /api/admin/config is unreachable. Conservative on purpose —
 *  we'd rather burn 60s on a slow loop than burn the YouTube/Twitter daily
 *  quota in 6s of parallel fan-out. The env var POLL_CONCURRENCY can raise it. */
const DEFAULT_CONCURRENCY = 2;
/** Delay between consecutive requests within a single worker, in ms. Spreads
 *  load over time so a 256-handle run takes minutes rather than seconds, which
 *  keeps us well under per-second rate limits across all providers. */
const PER_REQUEST_DELAY_MS = 250;

export function QueueView({ onCurateAsQuote }: {
  onCurateAsQuote?: (data: import('../App').QuotePrefill) => void;
}) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [kwOnly, setKwOnly] = useState(false);
  const [reload, setReload] = useState(0);

  // Live availability from the backend — drives which toggles render.
  // Includes failed health-checks too so the UI can render them disabled
  // with a tooltip explaining why (expired token, no quota, etc.).
  const availablePlatforms = useAvailablePlatforms();
  const bulkEligibleSet = useMemo(
    () => new Set(availablePlatforms.filter((p) => p.available && p.bulkEligible).map((p) => p.slug)),
    [availablePlatforms],
  );

  // Poll control state.
  const [polling, setPolling] = useState(false);
  // Default-enable only platforms that are both available AND bulk-eligible.
  // Initialized lazily after availability resolves so we don't get stuck
  // with an empty set if the platforms endpoint hadn't returned yet.
  const [enabledPlatforms, setEnabledPlatforms] = useState<Set<string>>(new Set());
  const enabledInitialized = useRef(false);
  useEffect(() => {
    if (enabledInitialized.current) return;
    if (bulkEligibleSet.size === 0) return;
    setEnabledPlatforms(new Set(bulkEligibleSet));
    enabledInitialized.current = true;
  }, [bulkEligibleSet]);
  const [pollLog, setPollLog] = useState<PollLogEntry[]>([]);
  const [pollProgress, setPollProgress] = useState<{ done: number; total: number; inflight: string[] } | null>(null);
  // Concurrency + staleness come from server config (env-derived). They are NOT
  // user-tunable — concurrency lives in wrangler.toml, staleness is derived
  // from the cron schedule. We fetch them only so the poll loop knows the
  // concurrency budget; the staleness gate is enforced backend-side.
  const [concurrency, setConcurrency] = useState<number | null>(null);
  const stopRef = useRef(false);
  const logScrollRef = useRef<HTMLDivElement>(null);

  // Load runtime config (concurrency from env).
  useEffect(() => {
    get<{ pollConcurrency: number }>('/api/admin/config')
      .then((r) => setConcurrency(r.pollConcurrency))
      .catch(() => setConcurrency(DEFAULT_CONCURRENCY));
  }, []);

  // Auto-scroll the log container to the bottom (without scrolling the page).
  useEffect(() => {
    const el = logScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [pollLog.length]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ status: statusFilter, limit: '50' });
    if (kwOnly) params.set('keywordMatch', 'true');
    get<{ items: QueueItem[]; total: number }>(
      `/api/admin/ingest/queue?${params}`,
    )
      .then((r) => { setItems(r.items); setTotal(r.total); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [statusFilter, kwOnly, reload]);

  function togglePollPlatform(p: string) {
    setEnabledPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  }

  async function triggerPoll() {
    setPolling(true);
    stopRef.current = false;
    setPollLog([]);
    setPollProgress({ done: 0, total: 0, inflight: [] });

    try {
      // Fetch the full handles list and filter to enabled platforms.
      const r = await get<{ items: HandleInfo[] }>('/api/admin/ingest/handles?includeInactive=false');
      const allCandidates = r.items.filter((h) => enabledPlatforms.has(h.platform));

      // Staleness is enforced by the backend now (via the persisted
      // `social_poll_min_age_min` setting + the per-call `force` flag), so the
      // client just dispatches every handle and renders whatever the server
      // returns: a real poll, a skip-with-reason, or an error.
      const handles = allCandidates;

      if (handles.length === 0) {
        setPollLog((prev) => [...prev, {
          time: new Date().toLocaleTimeString(),
          platform: 'system',
          handle: '',
          displayName: null,
          lastPolledAt: null,
          status: 'ok',
          newPosts: 0,
          duplicates: 0,
          keywordMatches: 0,
          error: 'No handles to poll.',
        }]);
        setPolling(false);
        setPollProgress(null);
        setReload((n) => n + 1);
        return;
      }

      // Per-platform consecutive-error tracker (so YouTube failing doesn't kill
      // Bluesky polling). Reset on each ok response.
      const platformErrors: Map<string, number> = new Map();
      // Hard stop for the rest of this run — quota exhausted, no point retrying.
      const stoppedPlatforms = new Set<string>();
      // Soft pause — back off until this Date.now() value, then resume.
      // Used for transient 429/403 windows where the upstream tells us
      // "wait N seconds and try again."
      const pausedUntil: Map<string, number> = new Map();

      let done = 0;
      const inflight = new Set<string>();
      let cursor = 0;

      const updateProgress = () => {
        setPollProgress({
          done,
          total: handles.length,
          inflight: [...inflight],
        });
      };

      async function pollOne(h: HandleInfo): Promise<void> {
        const tag = `${h.platform}/@${h.handle}`;
        inflight.add(tag);
        updateProgress();
        const startedAt = performance.now();

        try {
          // If this handle's platform is already auto-stopped, mark it skipped.
          if (stoppedPlatforms.has(h.platform)) {
            setPollLog((prev) => [...prev, {
              time: new Date().toLocaleTimeString(),
              platform: h.platform,
              handle: h.handle,
              displayName: h.display_name,
              lastPolledAt: h.last_polled_at,
              status: 'skipped',
              newPosts: 0,
              duplicates: 0,
              keywordMatches: 0,
              skipReason: 'platform auto-stopped',
            }]);
            return;
          }

          const result = await post<{
            handle: string;
            platform: string;
            bioguideId: string | null;
            displayName: string | null;
            lastPolledAt: string | null;
            skipped: boolean;
            skipReason?: string;
            rateLimited?: boolean;
            rateLimitKind?: 'transient' | 'quota' | null;
            retryAfterSec?: number | null;
            newPosts: number;
            duplicates: number;
            keywordMatches: number;
            error: string | null;
          }>('/api/admin/ingest/poll-handle', {
            handle_id: h.id,
          });

          const durationMs = Math.round(performance.now() - startedAt);

          if (result.skipped) {
            // Backend gated this handle; treat as skipped, not an error, so
            // it doesn't count toward the auto-stop streak.
            platformErrors.set(h.platform, 0);
            setPollLog((prev) => [...prev, {
              time: new Date().toLocaleTimeString(),
              platform: h.platform,
              handle: h.handle,
              displayName: h.display_name,
              lastPolledAt: result.lastPolledAt,
              status: 'skipped',
              newPosts: 0,
              duplicates: 0,
              keywordMatches: 0,
              durationMs,
              skipReason: result.skipReason ?? 'recently polled',
            }]);
            return;
          }

          // Rate-limit signal — recovery depends on whether it's a transient
          // window (Bluesky/Mastodon 429) or a hard quota cap (YouTube/Twitter
          // daily/monthly). The backend tells us via `rateLimitKind`.
          if (result.rateLimited) {
            const platLabel = PLATFORM_LABELS[h.platform] ?? h.platform;
            const retryAfter = result.retryAfterSec ?? 60;

            if (result.rateLimitKind === 'quota') {
              // Hard stop. Operator action required (extend YouTube quota / pay
              // for higher Twitter tier). Don't retry inside this run.
              stoppedPlatforms.add(h.platform);
              setPollLog((prev) => [...prev, {
                time: new Date().toLocaleTimeString(),
                platform: h.platform,
                handle: h.handle,
                displayName: h.display_name,
                lastPolledAt: h.last_polled_at,
                status: 'error',
                newPosts: 0, duplicates: 0, keywordMatches: 0,
                durationMs,
                error: result.error ?? 'over quota',
              }, {
                time: new Date().toLocaleTimeString(),
                platform: 'system',
                handle: '', displayName: null, lastPolledAt: null,
                status: 'error',
                newPosts: 0, duplicates: 0, keywordMatches: 0,
                error: `🛑 ${platLabel} quota exhausted. No more requests until the cap resets — see Admin ▸ App config for how to lift it.`,
              }]);
            } else {
              // Transient backoff. Pause this platform and resume when the
              // window clears. Other workers keep polling other platforms.
              const resumeAt = Date.now() + retryAfter * 1000;
              pausedUntil.set(h.platform, resumeAt);
              setPollLog((prev) => [...prev, {
                time: new Date().toLocaleTimeString(),
                platform: h.platform,
                handle: h.handle,
                displayName: h.display_name,
                lastPolledAt: h.last_polled_at,
                status: 'error',
                newPosts: 0, duplicates: 0, keywordMatches: 0,
                durationMs,
                error: result.error ?? 'rate-limited',
              }, {
                time: new Date().toLocaleTimeString(),
                platform: 'system',
                handle: '', displayName: null, lastPolledAt: null,
                status: 'error',
                newPosts: 0, duplicates: 0, keywordMatches: 0,
                error: `⏸ ${platLabel} rate-limited. Pausing ${retryAfter}s, then resuming. (Other platforms keep going.)`,
              }]);
            }
            return;
          }

          if (result.error) {
            const errMsg = result.error;
            const next = (platformErrors.get(h.platform) ?? 0) + 1;
            platformErrors.set(h.platform, next);
            setPollLog((prev) => [...prev, {
              time: new Date().toLocaleTimeString(),
              platform: h.platform,
              handle: h.handle,
              displayName: h.display_name,
              lastPolledAt: h.last_polled_at,
              status: 'error',
              newPosts: 0,
              duplicates: 0,
              keywordMatches: 0,
              durationMs,
              error: errMsg,
            }]);
            if (next >= 10 && !stoppedPlatforms.has(h.platform)) {
              stoppedPlatforms.add(h.platform);
              setPollLog((prev) => [...prev, {
                time: new Date().toLocaleTimeString(),
                platform: 'system',
                handle: '',
                displayName: null,
                lastPolledAt: null,
                status: 'error',
                newPosts: 0,
                duplicates: 0,
                keywordMatches: 0,
                error: `Auto-stopped ${PLATFORM_LABELS[h.platform] ?? h.platform}: 10 consecutive errors. Other platforms continue.`,
              }]);
            }
          } else {
            platformErrors.set(h.platform, 0);
            setPollLog((prev) => [...prev, {
              time: new Date().toLocaleTimeString(),
              platform: h.platform,
              handle: h.handle,
              displayName: h.display_name,
              lastPolledAt: h.last_polled_at,
              status: 'ok',
              newPosts: result.newPosts,
              duplicates: result.duplicates,
              keywordMatches: result.keywordMatches,
              durationMs,
            }]);
          }
        } catch (e) {
          const durationMs = Math.round(performance.now() - startedAt);
          const next = (platformErrors.get(h.platform) ?? 0) + 1;
          platformErrors.set(h.platform, next);
          setPollLog((prev) => [...prev, {
            time: new Date().toLocaleTimeString(),
            platform: h.platform,
            handle: h.handle,
            displayName: h.display_name,
            lastPolledAt: h.last_polled_at,
            status: 'error',
            newPosts: 0,
            duplicates: 0,
            keywordMatches: 0,
            durationMs,
            error: errorMsg(e),
          }]);
        } finally {
          inflight.delete(tag);
          done++;
          updateProgress();
        }
      }

      // Worker pool: run `concurrency` workers that pull from a shared cursor.
      // Each worker pauses PER_REQUEST_DELAY_MS between requests so the total
      // request rate ≈ concurrency / delay. With concurrency=2 + delay=250ms,
      // that's ~8 req/s — well under every provider's limit even when several
      // researchers click Poll at once.
      //
      // Rate-limit recovery is handled here too:
      //   - stoppedPlatforms (hard stop) → permanently skip handles for this run
      //   - pausedUntil[platform] (soft pause) → defer the handle, sleep a
      //     bit, and re-queue it. We push the handle index to the END of the
      //     deferral queue so other platforms keep flowing.
      const effConcurrency = concurrency ?? DEFAULT_CONCURRENCY;
      const deferredQueue: HandleInfo[] = [];

      function nextHandle(): HandleInfo | null {
        // Prefer a deferred handle whose platform is now unpaused.
        for (let i = 0; i < deferredQueue.length; i++) {
          const h = deferredQueue[i]!;
          if (stoppedPlatforms.has(h.platform)) {
            deferredQueue.splice(i, 1); i--;
            continue;
          }
          const resumeAt = pausedUntil.get(h.platform);
          if (resumeAt && Date.now() < resumeAt) continue;
          deferredQueue.splice(i, 1);
          return h;
        }
        // Otherwise pull the next index from the main cursor.
        while (cursor < handles.length) {
          const idx = cursor++;
          const h = handles[idx]!;
          if (stoppedPlatforms.has(h.platform)) continue;
          const resumeAt = pausedUntil.get(h.platform);
          if (resumeAt && Date.now() < resumeAt) {
            // Defer for later — don't burn the cursor.
            deferredQueue.push(h);
            continue;
          }
          return h;
        }
        return null;
      }

      const workers: Promise<void>[] = [];
      for (let w = 0; w < Math.max(1, effConcurrency); w++) {
        workers.push((async () => {
          while (true) {
            if (stopRef.current) return;
            const h = nextHandle();
            if (!h) {
              // Nothing dispatchable RIGHT NOW. If everything is either done
              // or deferred and the deferral queue is non-empty, sleep and
              // retry. Otherwise we're done.
              if (deferredQueue.length === 0 && cursor >= handles.length) return;
              await new Promise((r) => setTimeout(r, 1000));
              continue;
            }
            await pollOne(h);
            if (PER_REQUEST_DELAY_MS > 0) {
              await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
            }
          }
        })());
      }
      await Promise.all(workers);

      if (stopRef.current) {
        setPollLog((prev) => [...prev, {
          time: new Date().toLocaleTimeString(),
          platform: 'system',
          handle: '',
          displayName: null,
          lastPolledAt: null,
          status: 'error',
          newPosts: 0,
          duplicates: 0,
          keywordMatches: 0,
          error: `Stopped by user (${done} of ${handles.length} handles polled)`,
        }]);
      }
    } catch (e) {
      setPollLog((prev) => [...prev, {
        time: new Date().toLocaleTimeString(),
        platform: 'system',
        handle: '',
        displayName: null,
        lastPolledAt: null,
        status: 'error',
        newPosts: 0,
        duplicates: 0,
        keywordMatches: 0,
        error: `Failed to start: ${errorMsg(e)}`,
      }]);
    }

    setPolling(false);
    setReload((n) => n + 1);
  }

  function stopPoll() {
    stopRef.current = true;
  }

  async function reviewItem(id: string, status: 'curated' | 'dismissed') {
    await patch(`/api/admin/ingest/queue/${id}`, { status });
    setReload((n) => n + 1);
  }

  // Aggregates from log.
  const logTotals = pollLog.reduce(
    (acc, e) => {
      if (e.platform === 'system') return acc;
      if (e.status === 'ok') acc.ok++;
      else if (e.status === 'error') acc.errors++;
      else if (e.status === 'skipped') acc.skipped++;
      acc.newPosts += e.newPosts;
      acc.dupes += e.duplicates;
      acc.kwHits += e.keywordMatches;
      return acc;
    },
    { ok: 0, errors: 0, skipped: 0, newPosts: 0, dupes: 0, kwHits: 0 },
  );

  return (
    <div style={styles.section}>
      {/* Filters row */}
      <div style={styles.toolRow}>
        <label style={styles.filterLabel}>
          Status:
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={styles.select}>
            <option value="pending">Pending</option>
            <option value="curated">Curated</option>
            <option value="dismissed">Dismissed</option>
          </select>
        </label>
        <label style={styles.filterLabel}>
          <input type="checkbox" checked={kwOnly} onChange={() => setKwOnly(!kwOnly)} />
          Keyword matches only
        </label>
      </div>

      {/* Poll controls */}
      <div style={{
        ...styles.addFormBox,
        gap: 8,
      }}>
        <div style={{ fontSize: 'var(--tk-fs-xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--tk-muted)' }}>
          Sync Social Feeds
        </div>
        <div style={styles.toolRow}>
          {availablePlatforms.map((p) => {
            const slug = p.slug;
            const clickable = p.available && p.bulkEligible;
            const reasonNotClickable = !p.available
              ? `${PLATFORM_LABELS[slug] ?? slug} not available: ${p.error ?? 'health check failed'}`
              : !p.bulkEligible
                ? `${PLATFORM_LABELS[slug] ?? slug} is excluded from bulk sync (quota-bound). Sync individuals from their profile.`
                : '';
            return (
              <button
                key={slug}
                type="button"
                onClick={() => clickable && togglePollPlatform(slug)}
                disabled={polling || !clickable}
                title={clickable ? `Toggle ${PLATFORM_LABELS[slug] ?? slug} for bulk sync` : reasonNotClickable}
                style={{
                  ...styles.platformToggle,
                  ...(enabledPlatforms.has(slug) ? styles.platformToggleActive : {}),
                  opacity: clickable ? 1 : 0.4,
                  cursor: clickable ? 'pointer' : 'not-allowed',
                }}
              >
                {PLATFORM_LABELS[slug] ?? slug}
                {!clickable && <span style={{ marginLeft: 4, fontSize: 10 }}>🔒</span>}
              </button>
            );
          })}
          <span style={{ flex: 1 }} />
          {!polling ? (
            <button
              type="button"
              onClick={triggerPoll}
              disabled={enabledPlatforms.size === 0}
              style={{
                ...styles.actionBtn,
                opacity: enabledPlatforms.size === 0 ? 0.5 : 1,
              }}
            >
              Sync {enabledPlatforms.size === bulkEligibleSet.size ? 'all' : enabledPlatforms.size} platform{enabledPlatforms.size !== 1 ? 's' : ''}
            </button>
          ) : (
            <button
              type="button"
              onClick={stopPoll}
              style={{
                ...styles.actionBtn,
                background: 'var(--tk-danger)',
                borderColor: 'var(--tk-danger)',
                color: '#fff',
              }}
            >
              Stop
            </button>
          )}
        </div>


        {/* Progress bar */}
        {pollProgress && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--tk-fs-sm)', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700 }}>
                {pollProgress.done} / {pollProgress.total}
              </span>
              {pollProgress.inflight.length > 0 && (
                <span style={{ color: 'var(--tk-muted)' }}>
                  {pollProgress.inflight.length} in flight
                </span>
              )}
              {logTotals.newPosts > 0 && (
                <span style={{ color: '#22c55e', fontWeight: 700 }}>+{logTotals.newPosts} new</span>
              )}
              {logTotals.skipped > 0 && (
                <span style={{ color: 'var(--tk-muted)' }}>{logTotals.skipped} skipped</span>
              )}
              {logTotals.errors > 0 && (
                <span style={{ color: 'var(--tk-danger)' }}>{logTotals.errors} failed</span>
              )}
            </div>
            <div style={{ height: 4, background: 'var(--tk-border-soft)', width: '100%' }}>
              <div style={{
                height: '100%',
                width: `${pollProgress.total ? (pollProgress.done / pollProgress.total) * 100 : 0}%`,
                background: logTotals.errors > logTotals.ok ? 'var(--tk-danger)' : '#22c55e',
                transition: 'width 0.15s',
              }} />
            </div>
          </div>
        )}

        {/* Live log */}
        {pollLog.length > 0 && (
          <div ref={logScrollRef} style={{
            maxHeight: 240,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            border: '1px solid var(--tk-border-soft)',
            background: 'var(--tk-bg)',
            fontFamily: 'var(--tk-font-mono)',
            fontSize: 'var(--tk-fs-xs)',
            lineHeight: 1.6,
            padding: '4px 0',
          }}>
            {pollLog.map((entry, i) => {
              const bg =
                entry.status === 'error' ? 'rgba(239,68,68,0.08)'
                : entry.status === 'skipped' ? 'rgba(148,163,184,0.06)'
                : entry.newPosts > 0 ? 'rgba(34,197,94,0.08)'
                : 'transparent';
              return (
                <div key={i} style={{ padding: '1px 8px', display: 'flex', gap: 6, background: bg }}>
                  <span style={{ color: 'var(--tk-muted)', minWidth: 60, flexShrink: 0 }}>{entry.time}</span>
                  {entry.platform !== 'system' && (
                    <>
                      <span style={{ color: 'var(--tk-muted)', minWidth: 70, flexShrink: 0, textTransform: 'uppercase' }}>
                        {entry.platform}
                      </span>
                      <span style={{
                        color: entry.status === 'ok' ? 'var(--tk-fg)' : entry.status === 'skipped' ? 'var(--tk-muted)' : 'var(--tk-danger)',
                        fontWeight: entry.newPosts > 0 ? 700 : 400,
                        minWidth: 12,
                        flexShrink: 0,
                      }}>
                        {entry.status === 'ok' ? '✓' : entry.status === 'skipped' ? '⊝' : '✗'}
                      </span>
                      <span style={{ color: 'var(--tk-fg)', flexShrink: 0 }}>
                        @{entry.handle}
                      </span>
                      {entry.status === 'ok' && entry.newPosts > 0 && (
                        <span style={{ color: '#22c55e', fontWeight: 700 }}>+{entry.newPosts} new</span>
                      )}
                      {entry.status === 'ok' && entry.newPosts === 0 && (
                        <span style={{ color: 'var(--tk-muted)' }}>no new</span>
                      )}
                      {entry.status === 'skipped' && (
                        <span style={{ color: 'var(--tk-muted)' }}>{entry.skipReason ?? 'skipped'}</span>
                      )}
                      {entry.status === 'error' && (
                        <span style={{ color: 'var(--tk-danger)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {entry.error}
                        </span>
                      )}
                      {typeof entry.durationMs === 'number' && entry.status !== 'skipped' && (
                        <span style={{ color: 'var(--tk-muted)', marginLeft: 'auto', flexShrink: 0 }}>
                          {entry.durationMs}ms
                        </span>
                      )}
                    </>
                  )}
                  {entry.platform === 'system' && (
                    <span style={{ color: entry.status === 'error' ? 'var(--tk-danger)' : 'var(--tk-muted)', fontWeight: 700 }}>
                      {entry.error}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Final summary */}
        {!polling && pollLog.length > 0 && (
          <div style={{ fontSize: 'var(--tk-fs-sm)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <span>{logTotals.ok + logTotals.errors} synced</span>
            <span style={{ color: '#22c55e', fontWeight: 700 }}>{logTotals.ok} ok</span>
            {logTotals.errors > 0 && <span style={{ color: 'var(--tk-danger)', fontWeight: 700 }}>{logTotals.errors} failed</span>}
            {logTotals.skipped > 0 && <span style={{ color: 'var(--tk-muted)' }}>{logTotals.skipped} skipped (cached)</span>}
            {logTotals.newPosts > 0 && <span style={{ color: '#22c55e' }}>+{logTotals.newPosts} new posts</span>}
            {logTotals.dupes > 0 && <span style={{ color: 'var(--tk-muted)' }}>{logTotals.dupes} dupes</span>}
            {logTotals.kwHits > 0 && <span style={{ color: 'var(--tk-accent)' }}>{logTotals.kwHits} keyword hits</span>}
            <button
              type="button"
              onClick={() => { setPollLog([]); setPollProgress(null); }}
              style={styles.tinyBtn}
            >
              Clear log
            </button>
          </div>
        )}
      </div>

      {loading && <div style={styles.muted}>Loading queue…</div>}

      <div style={styles.muted}>{total} items total</div>

      {items.map((item) => (
        <div key={item.id} style={styles.queueCard}>
          <div style={styles.queueHeader}>
            <span style={styles.platformBadge}>
              {PLATFORM_LABELS[item.platform] ?? item.platform}
            </span>
            <span style={styles.handle}>@{item.author_handle}</span>
            {item.bioguide_id && (
              <a
                href={`#/people/${item.bioguide_id}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ ...styles.bioguide, textDecoration: 'underline', cursor: 'pointer' }}
                title="Open profile in new tab"
              >
                {item.bioguide_id} ↗
              </a>
            )}
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ ...styles.link, fontSize: 'var(--tk-fs-xs)' }}
              title="View original post in new tab"
            >
              View original ↗
            </a>
            <span style={styles.date}>
              {new Date(item.posted_at).toLocaleDateString()}
            </span>
          </div>
          <div style={styles.bodyText}>{item.body_text}</div>
          {item.matched_keywords && (
            <div style={styles.kwTags}>
              {(JSON.parse(item.matched_keywords) as string[]).map((kw) => (
                <span key={kw} style={styles.kwTag}>{kw}</span>
              ))}
            </div>
          )}
          <div style={styles.cardActions}>
            {item.status === 'pending' && (
              <>
                {onCurateAsQuote ? (
                  <button
                    type="button"
                    onClick={() => onCurateAsQuote({
                      bioguideId: item.bioguide_id,
                      sourceUrl: item.url,
                      sourceLabel: `${PLATFORM_LABELS[item.platform] ?? item.platform} — @${item.author_handle}`,
                      bodyText: item.body_text,
                      quotedAt: item.posted_at,
                      mediaKind: 'social',
                      queueItemId: item.id,
                    })}
                    style={styles.curateBtn}
                  >
                    Curate as Quote
                  </button>
                ) : (
                  <button type="button" onClick={() => reviewItem(item.id, 'curated')} style={styles.curateBtn}>
                    Curate
                  </button>
                )}
                <button type="button" onClick={() => reviewItem(item.id, 'dismissed')} style={styles.dismissBtn}>
                  Dismiss
                </button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ========================================================================== */
/*                             Direct add view                                */
/* ========================================================================== */

/** Extract a readable error message from any thrown value (Error or FetchError object). */
function errorMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null) {
    const obj = e as Record<string, unknown>;
    if (typeof obj.detail === 'string') return obj.detail;
    if (typeof obj.error === 'string') return obj.error;
  }
  return String(e);
}

/** Public alias used by sub-views in this file. Same shape as errorMsg. */
function errorMsgOf(e: unknown): string { return errorMsg(e); }

/** Pull a trace ID off a fetcher error, if the backend included one. */
function traceIdOf(e: unknown): string | null {
  if (typeof e === 'object' && e !== null) {
    const obj = e as Record<string, unknown>;
    if (typeof obj.traceId === 'string') return obj.traceId;
  }
  return null;
}

export function DirectAddView() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ post: FetchedPost; moc: { bioguideId: string; handle: string; displayName: string } | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enqueued, setEnqueued] = useState(false);
  const [enqueueing, setEnqueueing] = useState(false);

  function isValidUrl(s: string): boolean {
    try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
  }

  async function fetchPost() {
    const trimmed = url.trim();
    if (!trimmed) return;
    if (!isValidUrl(trimmed)) {
      setError('Enter a valid URL (e.g. https://bsky.app/profile/...). Use the Quotes tab to add non-social-media content.');
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setEnqueued(false);
    try {
      const r = await post<{ post: FetchedPost; moc: { bioguideId: string; handle: string; displayName: string } | null }>(
        '/api/admin/ingest/fetch-post',
        { url: trimmed },
      );
      setResult(r);
    } catch (e) {
      const msg = errorMsg(e);
      if (/unsupported|no adapter/i.test(msg)) {
        setError('This platform is not supported for auto-fetch. To add this as a quote, use the Quotes tab instead.');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }

  async function enqueuePost() {
    if (!result) return;
    setEnqueueing(true);
    setError(null);
    try {
      await post('/api/admin/ingest/queue', {
        platform: result.post.platform,
        platform_post_id: result.post.platformPostId,
        author_handle: result.post.authorHandle,
        author_platform_id: result.post.authorPlatformId,
        bioguide_id: result.moc?.bioguideId ?? null,
        posted_at: result.post.postedAt,
        url: result.post.url,
        body_text: result.post.bodyText,
        media_refs_json: JSON.stringify(result.post.mediaRefs),
        status: 'pending',
      });
      setEnqueued(true);
    } catch (e) {
      setError(errorMsg(e));
    } finally {
      setEnqueueing(false);
    }
  }

  function reset() {
    setUrl('');
    setResult(null);
    setEnqueued(false);
    setError(null);
  }

  return (
    <div style={styles.section}>
      <div style={{ fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)', fontStyle: 'italic' }}>
        Fetch a social media post by URL and add it to the ingest queue. To create a scored quote from any source, use the <strong>Quotes</strong> tab.
      </div>

      {/* URL input */}
      <div style={styles.toolRow}>
        <input
          type="url"
          value={url}
          onChange={(e) => { setUrl(e.target.value); setEnqueued(false); }}
          placeholder="Paste a social media URL (Bluesky, YouTube, Mastodon)..."
          style={{ ...styles.input, flex: 1 }}
          onKeyDown={(e) => e.key === 'Enter' && fetchPost()}
        />
        <button type="button" onClick={fetchPost} disabled={loading} style={styles.actionBtn}>
          {loading ? 'Fetching...' : 'Fetch'}
        </button>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {/* Fetched post preview */}
      {result && !enqueued && (
        <div style={styles.queueCard}>
          <div style={styles.queueHeader}>
            <span style={styles.platformBadge}>
              {PLATFORM_LABELS[result.post.platform] ?? result.post.platform}
            </span>
            <span style={styles.handle}>@{result.post.authorHandle}</span>
            {result.moc && (
              <span style={styles.bioguide}>
                {'→'} {result.moc.displayName}
              </span>
            )}
            <span style={styles.date}>
              {new Date(result.post.postedAt).toLocaleString()}
            </span>
          </div>
          <div style={styles.bodyText}>
            {result.post.bodyText.slice(0, 500)}{result.post.bodyText.length > 500 ? '...' : ''}
          </div>
          <div style={styles.cardActions}>
            <a href={result.post.url} target="_blank" rel="noopener noreferrer" style={styles.link}>
              View original
            </a>
            <button
              type="button"
              onClick={enqueuePost}
              disabled={enqueueing}
              style={styles.curateBtn}
            >
              {enqueueing ? 'Adding...' : 'Add to queue'}
            </button>
            <button
              type="button"
              onClick={reset}
              style={{ ...styles.actionBtn, background: 'var(--tk-surface)', color: 'var(--tk-fg)', border: '2px solid var(--tk-border-soft)' }}
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Enqueued success */}
      {enqueued && (
        <div style={{
          ...styles.addFormBox,
          borderColor: '#22c55e',
          borderLeftWidth: 4,
          borderLeftColor: '#22c55e',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: '#22c55e', fontWeight: 700, fontSize: 16 }}>Added to queue</span>
            <span style={{ fontSize: 'var(--tk-fs-sm)', color: 'var(--tk-fg)' }}>
              Post from @{result?.post.authorHandle} is now in the ingest queue for review.
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button type="button" onClick={reset} style={styles.actionBtn}>
              Add another
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


export function KeywordsView() {
  const [items, setItems] = useState<KeywordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [seeding, setSeeding] = useState(false);
  const [seedResult, setSeedResult] = useState<string | null>(null);

  // Add form
  const [watchName, setWatchName] = useState('');
  const [pattern, setPattern] = useState('');
  const [isRegex, setIsRegex] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addErrorTrace, setAddErrorTrace] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    get<{ items: KeywordRow[] }>('/api/admin/ingest/keywords?includeInactive=true')
      .then((r) => setItems(r.items))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [reload]);

  async function addKeyword() {
    setAddError(null);
    setAddErrorTrace(null);
    // Validate visibly instead of silently no-oping (the old behavior left the
    // researcher staring at an unresponsive button — exactly the failure mode
    // we keep fixing).
    if (!watchName.trim()) { setAddError('Watch name is required (e.g. "ukraine").'); return; }
    if (!pattern.trim())   { setAddError('Pattern is required.'); return; }
    if (isRegex) {
      try { new RegExp(pattern.trim()); }
      catch (e) { setAddError(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`); return; }
    }
    setAdding(true);
    try {
      await post('/api/admin/ingest/keywords', {
        watch_name: watchName.trim(),
        pattern: pattern.trim(),
        is_regex: isRegex,
      });
      setWatchName('');
      setPattern('');
      setIsRegex(false);
      setReload((n) => n + 1);
    } catch (e) {
      setAddError(errorMsgOf(e));
      setAddErrorTrace(traceIdOf(e));
    } finally {
      setAdding(false);
    }
  }

  async function seedKeywords() {
    setSeeding(true);
    setSeedResult(null);
    try {
      const r = await post<{
        roster: { membersScanned: number; handlesUpserted: number; mastodon: number; bluesky: number };
        keywords: { seeded: number };
        skipped: boolean;
      }>('/api/admin/ingest/seed', {});
      setSeedResult(`Seeded ${r.keywords.seeded} keyword watches`);
      setReload((n) => n + 1);
    } catch {
      setSeedResult('Seed failed');
    } finally {
      setSeeding(false);
    }
  }

  async function toggleActive(id: string, active: boolean) {
    await patch(`/api/admin/ingest/keywords/${id}`, { active });
    setReload((n) => n + 1);
  }

  return (
    <div style={styles.section}>
      <div style={styles.toolRow}>
        <button
          type="button"
          onClick={seedKeywords}
          disabled={seeding}
          style={{ ...styles.actionBtn, background: 'var(--tk-surface)', color: 'var(--tk-fg)', border: '2px solid var(--tk-border-soft)' }}
        >
          {seeding ? 'Seeding…' : 'Seed Ukraine keywords'}
        </button>
        {seedResult && <span style={styles.muted}>{seedResult}</span>}
      </div>

      <div style={styles.addFormBox}>
        <div style={styles.toolRow}>
          <input
            type="text"
            value={watchName}
            onChange={(e) => setWatchName(e.target.value)}
            placeholder="Watch name (e.g. ukraine)"
            style={{ ...styles.input, minWidth: 140 }}
          />
          <input
            type="text"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="Keyword or regex pattern"
            style={{ ...styles.input, flex: 1 }}
          />
          <label style={styles.filterLabel}>
            <input type="checkbox" checked={isRegex} onChange={() => setIsRegex(!isRegex)} />
            Regex
          </label>
          <button type="button" onClick={addKeyword} disabled={adding} style={styles.actionBtn}>
            {adding ? 'Adding…' : '+ Add'}
          </button>
        </div>
        {addError && (
          <div style={{ color: 'var(--tk-danger)', fontSize: 'var(--tk-fs-sm)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>{addError}</span>
            {addErrorTrace && (
              <span style={{ color: 'var(--tk-muted)', fontFamily: 'var(--tk-font-mono)', fontSize: 'var(--tk-fs-xs)' }}>
                trace: {addErrorTrace}
              </span>
            )}
          </div>
        )}
      </div>

      {loading && <div style={styles.muted}>Loading keywords…</div>}

      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Name</th>
            <th style={styles.th}>Pattern</th>
            <th style={styles.th}>Type</th>
            <th style={styles.th}>Active</th>
            <th style={styles.th}>Notify</th>
            <th style={styles.th}></th>
          </tr>
        </thead>
        <tbody>
          {items.map((k) => (
            <tr key={k.id} style={{ opacity: k.active ? 1 : 0.5 }}>
              <td style={styles.td}>{k.watch_name}</td>
              <td style={{ ...styles.td, fontFamily: 'var(--tk-font-mono)', fontSize: 'var(--tk-fs-xs)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {k.pattern}
              </td>
              <td style={styles.td}>
                <span style={{
                  fontSize: 'var(--tk-fs-xs)',
                  padding: '1px 5px',
                  background: k.is_regex ? 'var(--tk-accent)' : 'var(--tk-surface)',
                  color: k.is_regex ? 'var(--tk-accent-fg)' : 'var(--tk-fg)',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  border: k.is_regex ? 'none' : '1px solid var(--tk-border-soft)',
                }}>
                  {k.is_regex ? 'regex' : 'keyword'}
                </span>
              </td>
              <td style={styles.td}>{k.active ? 'Yes' : 'No'}</td>
              <td style={styles.td}>{k.notify ? 'Yes' : '—'}</td>
              <td style={styles.td}>
                <button
                  type="button"
                  onClick={() => toggleActive(k.id, !k.active)}
                  style={{
                    ...styles.tinyBtn,
                    color: k.active ? 'var(--tk-danger)' : 'var(--tk-accent)',
                    borderColor: k.active ? 'var(--tk-danger)' : 'var(--tk-accent)',
                  }}
                >
                  {k.active ? 'Disable' : 'Enable'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ========================================================================== */
/*                                Styles                                      */
/* ========================================================================== */

const INPUT_BASE: React.CSSProperties = {
  background: 'var(--tk-bg)',
  color: 'var(--tk-fg)',
  border: '2px solid var(--tk-border-soft)',
  borderRadius: 0,
  padding: '6px 10px',
  fontFamily: 'var(--tk-font)',
  fontSize: 'var(--tk-fs-sm)',
  minWidth: 0,
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
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  subTabActive: {
    color: 'var(--tk-fg)',
    borderColor: 'var(--tk-border-soft)',
    background: 'var(--tk-bg)',
  },
  section: { display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 8 },
  toolRow: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const },
  filterLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 'var(--tk-fs-sm)',
    color: 'var(--tk-muted)',
    whiteSpace: 'nowrap' as const,
    cursor: 'pointer',
  },
  input: INPUT_BASE,
  select: { ...INPUT_BASE, minWidth: 100 },
  actionBtn: {
    ...INPUT_BASE,
    background: 'var(--tk-accent)',
    color: 'var(--tk-accent-fg)',
    border: '2px solid var(--tk-border)',
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    padding: '6px 14px',
  },
  addFormBox: {
    padding: '10px 14px',
    border: '2px solid var(--tk-border-soft)',
    background: 'var(--tk-surface)',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  muted: { color: 'var(--tk-muted)', fontSize: 'var(--tk-fs-sm)' },
  error: { color: 'var(--tk-danger)', fontSize: 'var(--tk-fs-sm)' },
  noHandle: {
    fontSize: 'var(--tk-fs-sm)',
    padding: '8px 12px',
    background: 'var(--tk-surface)',
    border: '2px solid var(--tk-border-soft)',
    color: 'var(--tk-fg)',
    fontStyle: 'italic',
  },
  pollResult: {
    fontSize: 'var(--tk-fs-sm)',
    padding: '6px 10px',
    background: 'var(--tk-surface)',
    border: '2px solid var(--tk-border-soft)',
  },
  queueCard: {
    border: '2px solid var(--tk-border-soft)',
    padding: '10px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  queueHeader: {
    display: 'flex',
    gap: 10,
    alignItems: 'center',
    flexWrap: 'wrap' as const,
    fontSize: 'var(--tk-fs-sm)',
  },
  platformBadge: {
    fontSize: 'var(--tk-fs-xs)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    fontWeight: 700,
    color: 'var(--tk-muted)',
  },
  handle: { fontWeight: 700, color: 'var(--tk-fg)' },
  bioguide: { color: 'var(--tk-muted)', fontFamily: 'var(--tk-font-mono)', fontSize: 'var(--tk-fs-xs)' },
  date: { color: 'var(--tk-muted)', fontSize: 'var(--tk-fs-xs)', marginLeft: 'auto' },
  bodyText: {
    fontSize: 'var(--tk-fs-sm)',
    color: 'var(--tk-fg)',
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
  },
  kwTags: { display: 'flex', gap: 4, flexWrap: 'wrap' as const },
  kwTag: {
    fontSize: 'var(--tk-fs-xs)',
    padding: '2px 6px',
    background: 'var(--tk-accent)',
    color: 'var(--tk-accent-fg)',
    fontWeight: 700,
    textTransform: 'uppercase' as const,
  },
  cardActions: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    fontSize: 'var(--tk-fs-sm)',
  },
  link: {
    color: 'var(--tk-fg)',
    textDecoration: 'underline',
    fontWeight: 700,
    fontSize: 'var(--tk-fs-sm)',
  },
  curateBtn: {
    ...INPUT_BASE,
    background: 'var(--tk-accent)',
    color: 'var(--tk-accent-fg)',
    fontWeight: 700,
    cursor: 'pointer',
    padding: '4px 10px',
    border: '2px solid var(--tk-accent)',
  },
  dismissBtn: {
    ...INPUT_BASE,
    background: 'transparent',
    color: 'var(--tk-danger)',
    fontWeight: 700,
    cursor: 'pointer',
    padding: '4px 10px',
    border: '2px solid var(--tk-danger)',
  },
  platformBar: { display: 'flex', gap: 4, flexWrap: 'wrap' as const },
  platformToggle: {
    ...INPUT_BASE,
    cursor: 'pointer',
    padding: '4px 10px',
    opacity: 0.5,
  },
  platformToggleActive: {
    opacity: 1,
    borderColor: 'var(--tk-accent)',
    background: 'var(--tk-surface)',
  },
  sectionHead: {
    fontSize: 'var(--tk-fs-sm)',
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    color: 'var(--tk-muted)',
    margin: '12px 0 4px',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: 'var(--tk-fs-sm)',
  },
  th: {
    textAlign: 'left' as const,
    padding: '6px 10px',
    borderBottom: '2px solid var(--tk-border-soft)',
    fontSize: 'var(--tk-fs-xs)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    color: 'var(--tk-muted)',
  },
  td: {
    padding: '6px 10px',
    borderBottom: '1px solid var(--tk-border-soft)',
    color: 'var(--tk-fg)',
  },
  tinyBtn: {
    ...INPUT_BASE,
    cursor: 'pointer',
    padding: '2px 8px',
    fontSize: 'var(--tk-fs-xs)',
    background: 'transparent',
  },
};
