/**
 * People tab — top-level tab for managing tracked people (congress + non-congress).
 *
 * Two views:
 *   1. PeopleListView — card grid with search/filter, add-person accordion
 *   2. PersonProfileView — full profile with stats, handles, quotes, feed, widget preview
 *
 * Extracted from SocialFeedTab to be a first-class top-level tab.
 * Other tabs (Social Feed, Quotes) link into person profiles here.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { get, post, patch, del } from '../fetcher';
import { partyStyle } from './MocPicker';
import type { MocEntry } from './MocPicker';
import { useAvailablePlatforms } from '../hooks/useAvailablePlatforms';
import { parseHandleUrl } from '../utils/parseHandleUrl';
import { useMediaQuery } from '../useMediaQuery';
import { useProfileLayout } from '../useProfileLayout';
import { DraggableDivider } from './DraggableDivider';
import { MemberVotesMatrix } from './MemberVotesMatrix';

/**
 * FR-60 AC-60.6 — build the profile widget-preview iframe src. Deep-links the
 * same-origin `/embed` onto this member so the preview opens directly on their
 * public profile (no manual search), reflecting the current environment's data.
 */
export function embedPreviewSrc(origin: string, bioguideId: string): string {
  return `${origin}/embed?bioguide=${encodeURIComponent(bioguideId)}`;
}

/* ========================================================================== */
/*                                 Types                                      */
/* ========================================================================== */

interface HandleRow {
  id: string;
  bioguide_id: string | null;
  entity_name: string | null;
  account_category: string;
  platform: string;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  /** Migration 0008 — durable poll status per handle. */
  last_polled_at?: string | null;
  last_poll_attempted_at?: string | null;
  last_poll_status?: string | null;
  last_poll_error?: string | null;
  last_poll_trace_id?: string | null;
}

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

interface QuoteRow {
  id: string;
  bioguide_id: string;
  media_kind: string;
  source_url: string;
  source_label: string | null;
  quoted_at: string | null;
  body_text: string;
  weight: number;
  direction: number;
  comment: string | null;
  author_email: string;
  created_at: string;
}

interface AccountCategory {
  id: string;
  label: string;
}

interface PersonCard {
  key: string;
  name: string;
  bioguideId: string | null;
  category: string;
  avatarUrl: string | null;
  handles: HandleRow[];
  moc?: MocEntry;
}

const PLATFORM_LABELS: Record<string, string> = {
  bluesky: 'Bluesky',
  youtube: 'YouTube',
  mastodon: 'Mastodon',
  twitter: 'Twitter / X',
};


const ACCOUNT_CATEGORIES: AccountCategory[] = [
  { id: 'congress', label: 'Member of Congress' },
  { id: 'influencer', label: 'Influencer' },
  { id: 'journalist', label: 'Journalist' },
  { id: 'bureaucrat', label: 'Government Official' },
  { id: 'thinktank', label: 'Think Tank / Policy' },
  { id: 'ngo', label: 'NGO / Advocacy' },
  { id: 'foreign_official', label: 'Foreign Official' },
  { id: 'military', label: 'Military / Defense' },
  { id: 'other', label: 'Other' },
];

function errorMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null) {
    const obj = e as Record<string, unknown>;
    if (typeof obj.detail === 'string') return obj.detail;
    if (typeof obj.error === 'string') return obj.error;
  }
  return String(e);
}

/* ========================================================================== */
/*                              Public API                                    */
/* ========================================================================== */

export function PeopleTab({ initialBioguide }: { initialBioguide?: string | null }) {
  const [profileBioguide, setProfileBioguide] = useState<string | null>(initialBioguide ?? null);

  // Allow parent to push a new bioguide via prop change.
  useEffect(() => {
    if (initialBioguide) setProfileBioguide(initialBioguide);
  }, [initialBioguide]);

  function openProfile(bioguideId: string) {
    setProfileBioguide(bioguideId);
  }

  if (profileBioguide) {
    return (
      <PersonProfileView
        bioguideId={profileBioguide}
        onBack={() => setProfileBioguide(null)}
        onNavigate={openProfile}
      />
    );
  }

  return <PeopleListView onOpenProfile={openProfile} />;
}

/* ========================================================================== */
/*                          Group-by-person helper                            */
/* ========================================================================== */

function groupByPerson(items: HandleRow[]): PersonCard[] {
  const map = new Map<string, PersonCard>();
  for (const h of items) {
    const key = h.bioguide_id ?? h.entity_name ?? h.handle;
    let card = map.get(key);
    if (!card) {
      card = {
        key,
        name: h.entity_name ?? h.display_name ?? h.handle,
        bioguideId: h.bioguide_id,
        category: h.account_category,
        avatarUrl: h.avatar_url,
        handles: [],
      };
      map.set(key, card);
    }
    if (!card.avatarUrl && h.avatar_url) card.avatarUrl = h.avatar_url;
    card.handles.push(h);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ========================================================================== */
/*                           People list view                                 */
/* ========================================================================== */

function PeopleListView({ onOpenProfile }: { onOpenProfile: (bioguideId: string) => void }) {
  const [items, setItems] = useState<HandleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [seeding, setSeeding] = useState(false);
  const [seedResult, setSeedResult] = useState<string | null>(null);

  // MoC metadata.
  const [mocMap, setMocMap] = useState<Map<string, MocEntry>>(new Map());
  const mocFetchedRef = useRef(false);

  // Add form state (non-congress people only).
  const [addFormOpen, setAddFormOpen] = useState(false);
  const [entityName, setEntityName] = useState('');
  const [accountCategory, setAccountCategory] = useState('influencer');
  const [addHandles, setAddHandles] = useState<Record<string, string>>({
    bluesky: '', youtube: '', mastodon: '', threads: '',
  });
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ includeInactive: 'false' });
    get<{ items: HandleRow[] }>(`/api/admin/ingest/handles?${params}`)
      .then((r) => setItems(r.items))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [reload]);

  useEffect(() => {
    if (mocFetchedRef.current) return;
    mocFetchedRef.current = true;
    get<{ members: MocEntry[] }>('/api/admin/ingest/roster-meta')
      .then((r) => {
        const map = new Map<string, MocEntry>();
        for (const m of r.members) map.set(m.bioguideId, m);
        setMocMap(map);
      })
      .catch(() => {});
  }, []);

  const cards = useMemo(() => {
    let grouped = groupByPerson(items);
    for (const card of grouped) {
      if (card.bioguideId && mocMap.has(card.bioguideId)) {
        card.moc = mocMap.get(card.bioguideId);
      }
    }
    // v4.1.0 — AC-59.8 PeopleTab roster-driven enumeration: every sitting
    // member of Congress gets a card, regardless of whether they have a
    // handle row yet. Members not yet represented in mocs_social_handles
    // appear with an empty handles list + "no handles tracked" caption.
    const seenBioguides = new Set(grouped.map((c) => c.bioguideId).filter(Boolean));
    for (const moc of mocMap.values()) {
      if (seenBioguides.has(moc.bioguideId)) continue;
      grouped.push({
        key: moc.bioguideId,
        name: moc.displayName,
        bioguideId: moc.bioguideId,
        category: 'congress',
        avatarUrl: null,
        handles: [],
        moc,
      });
    }
    grouped.sort((a, b) => a.name.localeCompare(b.name));
    if (categoryFilter) {
      grouped = grouped.filter((c) => c.category === categoryFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      grouped = grouped.filter((c) =>
        c.name.toLowerCase().includes(q) ||
        c.handles.some((h) => h.handle.toLowerCase().includes(q)) ||
        (c.moc?.state ?? '').toLowerCase().includes(q) ||
        (c.moc?.party ?? '').toLowerCase().startsWith(q),
      );
    }
    return grouped;
  }, [items, mocMap, categoryFilter, search]);

  const totalHandles = useMemo(() => cards.reduce((n, c) => n + c.handles.length, 0), [cards]);
  // v4.1.0 — coverage metric. Counts Congress members with ≥1 handle vs total.
  const coverage = useMemo(() => {
    const congressCards = cards.filter((c) => c.category === 'congress');
    const withHandles = congressCards.filter((c) => c.handles.length > 0).length;
    return { withHandles, total: congressCards.length };
  }, [cards]);

  async function addPerson() {
    if (!entityName.trim()) return;
    const filled = Object.entries(addHandles).filter(([, v]) => v.trim());
    if (filled.length === 0) return;

    setAdding(true);
    try {
      for (const [plat, h] of filled) {
        await post('/api/admin/ingest/handles', {
          bioguide_id: null,
          entity_name: entityName.trim(),
          account_category: accountCategory,
          platform: plat,
          handle: h.trim(),
          platform_id: h.trim(),
          display_name: entityName.trim(),
          source: 'manual',
        });
      }
      setEntityName('');
      setAddHandles({ bluesky: '', youtube: '', mastodon: '', facebook: '', instagram: '', threads: '' });
      setAddFormOpen(false);
      setReload((n) => n + 1);
    } catch {
      // TODO: show error
    } finally {
      setAdding(false);
    }
  }

  async function resyncRoster() {
    setSeeding(true);
    setSeedResult(null);
    try {
      const r = await post<{
        roster: { membersScanned: number; handlesUpserted: number; mastodon: number; bluesky: number };
        keywords: { seeded: number };
        skipped: boolean;
      }>('/api/admin/ingest/seed', {});
      const parts: string[] = [];
      parts.push(`${r.roster.membersScanned} members scanned`);
      parts.push(`${r.roster.handlesUpserted} handles upserted`);
      if (r.roster.bluesky > 0) parts.push(`${r.roster.bluesky} Bluesky matched`);
      if (r.roster.mastodon > 0) parts.push(`${r.roster.mastodon} Mastodon found`);
      if (r.keywords.seeded > 0) parts.push(`${r.keywords.seeded} keywords seeded`);
      setSeedResult(parts.join(' · '));
      setReload((n) => n + 1);
    } catch {
      setSeedResult('Re-sync failed');
    } finally {
      setSeeding(false);
    }
  }

  return (
    <div style={styles.section}>
      {/* Add person — accordion toggle */}
      {!addFormOpen ? (
        <button
          type="button"
          onClick={() => setAddFormOpen(true)}
          style={{
            ...styles.actionBtn,
            width: '100%',
            padding: '8px 0',
            fontSize: 'var(--tk-fs-sm)',
            background: 'var(--tk-surface)',
            color: 'var(--tk-fg)',
            border: '2px dashed var(--tk-border-soft)',
            cursor: 'pointer',
            marginBottom: 8,
          }}
        >
          + Add person
        </button>
      ) : (
        <div style={{ ...styles.addFormBox, marginBottom: 8 }}>
          <div style={styles.toolRow}>
            <input
              type="text"
              value={entityName}
              onChange={(e) => setEntityName(e.target.value)}
              placeholder="Name (e.g. Jake Sullivan)"
              style={{ ...styles.input, flex: 1 }}
            />
            <select
              value={accountCategory}
              onChange={(e) => setAccountCategory(e.target.value)}
              style={styles.select}
            >
              {ACCOUNT_CATEGORIES.filter((c) => c.id !== 'congress').map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setAddFormOpen(false)}
              style={{ ...styles.actionBtn, background: 'transparent', color: 'var(--tk-muted)', border: 'none', fontSize: 18, padding: '0 4px', cursor: 'pointer' }}
              title="Close"
            >
              ✕
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 }}>
            {Object.keys(addHandles).map((plat) => (
              <div key={plat} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 'var(--tk-fs-xs)', fontWeight: 700, minWidth: 90, color: 'var(--tk-muted)' }}>
                  {PLATFORM_LABELS[plat] ?? plat}
                </span>
                <input
                  type="text"
                  value={addHandles[plat]}
                  onChange={(e) => {
                    const v = e.target.value;
                    // Pasting a profile URL? Move it to the matching platform
                    // box and store the bare handle, leaving this box empty.
                    const parsed = parseHandleUrl(v);
                    if (parsed && parsed.platform !== plat) {
                      setAddHandles((prev) => ({ ...prev, [plat]: '', [parsed.platform]: parsed.handle }));
                    } else if (parsed) {
                      setAddHandles((prev) => ({ ...prev, [plat]: parsed.handle }));
                    } else {
                      setAddHandles((prev) => ({ ...prev, [plat]: v }));
                    }
                  }}
                  placeholder={plat === 'bluesky' ? '@user.bsky.social or paste profile URL' : plat === 'mastodon' ? '@user@instance or URL' : 'handle or paste URL'}
                  style={{ ...styles.input, flex: 1 }}
                />
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <button type="button" onClick={addPerson} disabled={adding || !entityName.trim()} style={styles.actionBtn}>
              {adding ? 'Adding…' : '+ Add person'}
            </button>
          </div>
        </div>
      )}

      {/* Search + filter + actions */}
      <div style={styles.toolRow}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, handle, state, party…"
          style={{ ...styles.input, flex: 1, minWidth: 200 }}
        />
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          style={styles.select}
        >
          <option value="">All categories</option>
          {ACCOUNT_CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={resyncRoster}
          disabled={seeding}
          style={{ ...styles.actionBtn, background: 'var(--tk-surface)', color: 'var(--tk-fg)', border: '2px solid var(--tk-border-soft)' }}
        >
          {seeding ? 'Syncing…' : 'Re-sync'}
        </button>
        <span style={styles.muted}>
          {cards.length} people · {totalHandles} handles
          {coverage.total > 0 && ` · ${coverage.withHandles}/${coverage.total} Congress with handles`}
        </span>
      </div>

      {seedResult && <div style={styles.pollResult}>{seedResult}</div>}

      {loading && <div style={styles.muted}>Loading roster…</div>}

      {/* Person cards grid */}
      <div style={rosterStyles.grid}>
        {cards.map((card) => {
          const moc = card.moc;
          const ps = moc ? partyStyle(moc.party) : null;
          const photoUrl = moc?.photoUrl ?? card.avatarUrl;
          const categoryLbl = ACCOUNT_CATEGORIES.find((c) => c.id === card.category)?.label ?? card.category;

          return (
            <button
              key={card.key}
              type="button"
              onClick={() => {
                if (card.bioguideId) onOpenProfile(card.bioguideId);
              }}
              style={{
                ...rosterStyles.card,
                borderColor: ps ? ps.accent : 'var(--tk-border-soft)',
                borderLeftWidth: 4,
                borderLeftColor: ps ? ps.accent : 'var(--tk-border-soft)',
              }}
            >
              <div style={rosterStyles.cardHeader}>
                {photoUrl ? (
                  <img
                    src={photoUrl}
                    alt=""
                    style={{
                      ...rosterStyles.avatar,
                      borderColor: ps ? ps.accent : 'var(--tk-border-soft)',
                    }}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                ) : (
                  <div style={{
                    ...rosterStyles.avatarPlaceholder,
                    background: ps ? ps.accent : 'var(--tk-surface)',
                  }}>
                    {card.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
                  </div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 'var(--tk-fs-sm)', color: 'var(--tk-fg)' }}>
                    {card.name}
                  </div>
                  <div style={{ fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    {moc ? (
                      <>
                        <span>{moc.chamber === 'Senate' ? 'Senator' : 'Rep.'}</span>
                        <span style={{ color: ps?.accent, fontWeight: 700 }}>{moc.party}</span>
                        <span>{moc.state}{moc.chamber === 'House' && moc.district ? `-${moc.district}` : ''}</span>
                      </>
                    ) : (
                      <span style={{
                        fontSize: 'var(--tk-fs-xs)',
                        padding: '1px 5px',
                        background: 'var(--tk-surface)',
                        border: '1px solid var(--tk-border-soft)',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                      }}>
                        {categoryLbl}
                      </span>
                    )}
                  </div>
                </div>
                <span style={{
                  fontSize: 'var(--tk-fs-xs)',
                  color: 'var(--tk-muted)',
                  fontFamily: 'var(--tk-font-mono)',
                }}>
                  →
                </span>
              </div>

              <div style={rosterStyles.platforms}>
                {card.handles.length === 0 ? (
                  <span style={{
                    fontFamily: 'var(--tk-font-mono)',
                    fontSize: 'var(--tk-fs-xs)',
                    color: 'var(--tk-muted)',
                    fontStyle: 'italic',
                  }}>
                    no handles tracked
                  </span>
                ) : (
                  card.handles.map((h) => (
                    <span key={h.id} style={rosterStyles.platformChip}>
                      <span style={{ fontFamily: 'var(--tk-font-mono)', fontSize: 'var(--tk-fs-xs)' }}>
                        {PLATFORM_LABELS[h.platform] ?? h.platform}
                      </span>
                    </span>
                  ))
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ========================================================================== */
/*                           Person profile view                              */
/* ========================================================================== */

function PersonProfileView({
  bioguideId,
  onBack,
  onNavigate,
}: {
  bioguideId: string;
  onBack: () => void;
  onNavigate: (bioguideId: string) => void;
}) {
  void onNavigate;

  const [handles, setHandles] = useState<HandleRow[]>([]);
  const [moc, setMoc] = useState<MocEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [editCard, setEditCard] = useState<PersonCard | null>(null);
  const [reloadHandles, setReloadHandles] = useState(0);

  const [quotes, setQuotes] = useState<QuoteRow[]>([]);
  const [loadingQuotes, setLoadingQuotes] = useState(true);

  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [loadingQueue, setLoadingQueue] = useState(true);

  // FR-60 layout (AC-60.10): two-column on wide screens (≥1100px) — the LEFT
  // column holds everything bio/work (back, header, stat cards, social, quotes,
  // live feed) at ~70% width; the RIGHT column (~30%) is the sticky widget
  // preview spanning full height. Recent posts span full width below. Below
  // 1100px (tablets portrait + phones) it collapses to one column, reordered so
  // the preview sits right after the stat cards. Social monitoring is a
  // collapsible panel (collapsed by default); its issue summary stays visible
  // on the collapsed header.
  const twoColumn = useMediaQuery('(min-width: 1100px)');
  const [socialOpen, setSocialOpen] = useState(false);

  // FR-60 AC-60.14 — tabbed left column (Quotes default; reset on member switch).
  type ProfileTab = 'quotes' | 'feed' | 'bills';
  const [tab, setTab] = useState<ProfileTab>('quotes');
  // AC-60.16 — feed shows related posts by default; checkbox reveals unrelated.
  const [showUnrelated, setShowUnrelated] = useState(false);
  // AC-60.17/18 — persisted preview width % + collapsed state; container ref
  // for the divider's percentage math.
  const { layout, setPreviewPct, toggleCollapsed } = useProfileLayout();
  const gridRef = useRef<HTMLDivElement | null>(null);
  // Bills tab only applies to Congress members (need a bioguide + roster identity).
  const hasCongressIdentity = Boolean(moc);

  // Which platforms have a registered + healthy adapter? Drives whether we
  // render the Re-poll button on each handle row — there's no point offering
  // it for facebook/instagram/x/threads since we have no adapter to call.
  const livePlatforms = useAvailablePlatforms();
  const pollablePlatforms = useMemo(
    () => new Set(livePlatforms.filter((p) => p.available).map((p) => p.slug)),
    [livePlatforms],
  );

  const mocFetchedRef = useRef(false);
  useEffect(() => {
    if (mocFetchedRef.current) return;
    mocFetchedRef.current = true;
    get<{ members: MocEntry[] }>('/api/admin/ingest/roster-meta')
      .then((r) => {
        const entry = r.members.find((m) => m.bioguideId === bioguideId);
        if (entry) setMoc(entry);
      })
      .catch(() => {});
  }, [bioguideId]);

  useEffect(() => {
    setLoading(true);
    get<{ items: HandleRow[] }>(`/api/admin/ingest/handles?includeInactive=false`)
      .then((r) => {
        setHandles(r.items.filter((h) => h.bioguide_id === bioguideId));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [bioguideId, reloadHandles]);

  useEffect(() => {
    setLoadingQuotes(true);
    get<{ items: QuoteRow[] }>(`/api/admin/quotes?bioguideId=${encodeURIComponent(bioguideId)}`)
      .then((r) => setQuotes(r.items))
      .catch(() => {})
      .finally(() => setLoadingQuotes(false));
  }, [bioguideId]);

  useEffect(() => {
    setLoadingQueue(true);
    get<{ items: QueueItem[]; total: number }>(
      `/api/admin/ingest/queue?bioguideId=${encodeURIComponent(bioguideId)}&limit=20`,
    )
      .then((r) => setQueueItems(r.items))
      .catch(() => {})
      .finally(() => setLoadingQueue(false));
    // AC-60.22: reloadHandles is bumped by a completed re-poll (RefreshAllButton
    // onDone / per-handle onRepoll). Depending on it here makes the posts feed
    // refetch after a poll persists new rows — not just the handle list.
  }, [bioguideId, reloadHandles]);

  // AC-60.14 — default back to the Quotes tab whenever the viewed member changes.
  useEffect(() => { setTab('quotes'); }, [bioguideId]);

  // Profile-level "what platforms can we actually pull from?" derived from
  // live availability + the rep's linked handles. Falls back to the
  // hardcoded set while the platforms endpoint is in flight.
  const personCard = useMemo<PersonCard | null>(() => {
    if (handles.length === 0 && !moc) return null;
    const first = handles[0];
    return {
      key: bioguideId,
      name: moc?.displayName ?? first?.entity_name ?? first?.display_name ?? bioguideId,
      bioguideId,
      category: first?.account_category ?? 'congress',
      avatarUrl: moc?.photoUrl ?? first?.avatar_url ?? null,
      handles,
      moc: moc ?? undefined,
    };
  }, [handles, moc, bioguideId]);

  const ps = moc ? partyStyle(moc.party) : null;
  const photoUrl = moc?.photoUrl ?? handles[0]?.avatar_url;
  const personName = moc?.displayName ?? handles[0]?.entity_name ?? handles[0]?.display_name ?? bioguideId;

  /* ── Compute stats from already-loaded data ── */
  const stats = useMemo(() => {
    const quotePro = quotes.filter((q) => q.direction > 0).length;
    const quoteAnti = quotes.filter((q) => q.direction < 0).length;
    const quoteUnstated = quotes.filter((q) => q.direction === 0).length;
    const quoteAvgWeight = quotes.length > 0
      ? quotes.reduce((s, q) => s + q.weight, 0) / quotes.length
      : 0;

    const postsPending = queueItems.filter((i) => i.status === 'pending').length;
    const postsCurated = queueItems.filter((i) => i.status === 'curated').length;
    const postsDismissed = queueItems.filter((i) => i.status === 'dismissed').length;
    const postsUnrelated = queueItems.filter((i) => i.status === 'unrelated').length;

    const platformCounts: Record<string, number> = {};
    for (const h of handles) {
      platformCounts[h.platform] = (platformCounts[h.platform] ?? 0) + 1;
    }

    return {
      quotePro, quoteAnti, quoteUnstated, quoteAvgWeight,
      postsPending, postsCurated, postsDismissed, postsUnrelated,
      platformCounts,
    };
  }, [quotes, queueItems, handles]);

  // AC-60.16 — Social Feed list: related posts (status !== 'unrelated') by
  // default; the "Show unrelated" checkbox includes the rest.
  const feedPosts = useMemo(
    () => (showUnrelated ? queueItems : queueItems.filter((i) => i.status !== 'unrelated')),
    [queueItems, showUnrelated],
  );

  return (
    <div style={styles.section}>
      {/* ── Profile grid (AC-60.14..60.20). Desktop: LEFT column (bio/work +
          tabs) | draggable divider | RIGHT preview (full height, sticky-ish via
          the grid being the scroll boundary). Collapsed: left fills, a slim
          re-open strip on the right. Mobile (<1100px): single column,
          back→header→cards→preview→tabs; no divider/collapse/resize. ── */}
      <div
        ref={gridRef}
        style={
          !twoColumn
            ? {
                display: 'grid',
                gridTemplateColumns: '1fr',
                gridTemplateAreas: '"back" "header" "cards" "preview" "left"',
                gap: 10,
              }
            : layout.previewCollapsed
              ? {
                  display: 'grid',
                  gridTemplateColumns: '1fr 28px',
                  gridTemplateAreas: '"left strip"',
                  columnGap: 12,
                  height: 'calc(100vh - 96px)',
                  overflow: 'hidden',
                  alignItems: 'stretch',
                }
              : {
                  display: 'grid',
                  gridTemplateColumns: `minmax(0, ${100 - layout.previewPct}fr) 6px minmax(0, ${layout.previewPct}fr)`,
                  gridTemplateAreas: '"left divider preview"',
                  columnGap: 12,
                  height: 'calc(100vh - 96px)',
                  overflow: 'hidden',
                  alignItems: 'stretch',
                }
        }
      >
      {/* LEFT column wrapper. Two-column: a flex column owning its own vertical
          scroll (the grid is the scroll boundary). Single-column: `display:
          contents` so each child joins the outer grid via its gridArea. */}
      <div style={twoColumn
        ? { gridArea: 'left', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, minHeight: 0, overflowY: 'auto' }
        : { display: 'contents' }}>
      {/* Back button */}
      <div style={{ gridArea: 'back' }}>
        <button
          type="button"
          onClick={onBack}
          style={{
            ...styles.actionBtn,
            background: 'var(--tk-surface)',
            color: 'var(--tk-fg)',
            border: '2px solid var(--tk-border-soft)',
            fontSize: 'var(--tk-fs-xs)',
          }}
        >
          ← Back to People
        </button>
      </div>

      {/* Profile header */}
      <div style={{
        gridArea: 'header',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '16px 20px',
        border: `2px solid ${ps?.accent ?? 'var(--tk-border-soft)'}`,
        borderLeftWidth: 6,
        borderLeftColor: ps?.accent ?? 'var(--tk-border-soft)',
        background: ps ? `linear-gradient(135deg, ${ps.bg} 0%, var(--tk-bg) 100%)` : 'var(--tk-bg)',
      }}>
        {photoUrl ? (
          <img
            src={photoUrl}
            alt=""
            style={{ width: 72, height: 72, borderRadius: '50%', objectFit: 'cover', border: `3px solid ${ps?.accent ?? 'var(--tk-border-soft)'}`, flexShrink: 0 }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        ) : (
          <div style={{
            width: 72, height: 72, borderRadius: '50%',
            background: ps?.accent ?? 'var(--tk-surface)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 24, fontWeight: 700, color: '#fff', flexShrink: 0,
          }}>
            {personName.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 20, color: 'var(--tk-fg)' }}>{personName}</div>
          {moc && (
            <div style={{ fontSize: 'var(--tk-fs-sm)', color: 'var(--tk-muted)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>{moc.chamber === 'Senate' ? 'Senator' : 'Representative'}</span>
              <span style={{ color: ps?.accent, fontWeight: 700, fontSize: 'var(--tk-fs-sm)' }}>{moc.party}</span>
              <span>{moc.state}{moc.chamber === 'House' && moc.district ? `-${moc.district}` : ''}</span>
              <span style={{ fontFamily: 'var(--tk-font-mono)', fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)' }}>{bioguideId}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Stats summary ── */}
      {(!loadingQuotes || !loadingQueue) && (
        <div style={{
          gridArea: 'cards',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: 8,
        }}>
          {/* Handles */}
          <StatCard label="Social handles" value={String(handles.length)}>
            {Object.entries(stats.platformCounts).map(([p, n]) => (
              <span key={p} style={statDetailStyle}>{PLATFORM_LABELS[p] ?? p}: {n}</span>
            ))}
          </StatCard>

          {/* Quotes */}
          <StatCard label="Quotes" value={String(quotes.length)}>
            {quotes.length > 0 && (
              <>
                <span style={{ ...statDetailStyle, color: '#22c55e' }}>Pro: {stats.quotePro}</span>
                <span style={{ ...statDetailStyle, color: '#ef4444' }}>Anti: {stats.quoteAnti}</span>
                <span style={statDetailStyle}>Unstated: {stats.quoteUnstated}</span>
                <span style={statDetailStyle}>Avg wt: {stats.quoteAvgWeight.toFixed(2)}</span>
              </>
            )}
          </StatCard>

          {/* Ingested posts */}
          <StatCard label="Ingested posts" value={String(queueItems.length)}>
            {queueItems.length > 0 && (
              <>
                <span style={{ ...statDetailStyle, color: '#eab308' }}>Pending: {stats.postsPending}</span>
                <span style={{ ...statDetailStyle, color: '#22c55e' }}>Curated: {stats.postsCurated}</span>
                <span style={{ ...statDetailStyle, color: '#ef4444' }}>Dismissed: {stats.postsDismissed}</span>
                <span style={statDetailStyle}>Unrelated: {stats.postsUnrelated}</span>
              </>
            )}
          </StatCard>

          {/* Quote score contribution */}
          {quotes.length > 0 && (
            <StatCard
              label="Quote score impact"
              value={(() => {
                const total = quotes.reduce((s, q) => s + q.weight * q.direction, 0);
                return (total >= 0 ? '+' : '') + total.toFixed(2);
              })()}
            >
              <span style={statDetailStyle}>Sum of weight × direction</span>
            </StatCard>
          )}
        </div>
      )}

      {/* ── Social monitoring section (collapsible — AC-60.10) ── */}
      <div style={{ ...profileSectionStyle, gridArea: 'social' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: socialOpen ? 8 : 0 }}>
          {/* Toggle: title + caret + ALWAYS-visible freshness/issue summary so
              problems are obvious even while the panel is collapsed. */}
          <button
            type="button"
            onClick={() => setSocialOpen((o) => !o)}
            aria-expanded={socialOpen}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              color: 'var(--tk-fg)', textAlign: 'left',
            }}
          >
            <span aria-hidden style={{ fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)', width: 12, display: 'inline-block' }}>
              {socialOpen ? '▾' : '▸'}
            </span>
            <span style={profileSectionTitle}>Social monitoring ({handles.length})</span>
            <FreshnessBadge handles={handles} />
          </button>
          <div style={{ display: 'flex', gap: 6 }}>
            <RefreshAllButton
              handles={handles}
              onDone={() => setReloadHandles((n) => n + 1)}
            />
            {personCard && (
              <button
                type="button"
                onClick={() => setEditCard(personCard)}
                style={rosterStyles.editBtn}
              >
                Edit handles
              </button>
            )}
          </div>
        </div>
        {socialOpen && (
          loading ? (
            <div style={styles.muted}>Loading…</div>
          ) : handles.length === 0 ? (
            <div style={styles.muted}>No social handles linked to this person.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {handles.map((h) => (
                <HandleStatusRow
                  key={h.id}
                  handle={h}
                  pollable={pollablePlatforms.has(h.platform)}
                  onRepoll={() => setReloadHandles((n) => n + 1)}
                />
              ))}
            </div>
          )
        )}
      </div>

      {/* ── Tab bar (AC-60.14): Quotes | Social Feed | Bills ── */}
      <div role="tablist" aria-label="Profile sections" style={tabNavStyle}>
        <button type="button" role="tab" aria-selected={tab === 'quotes'} onClick={() => setTab('quotes')}
          style={tab === 'quotes' ? tabBtnActiveStyle : tabBtnStyle}>
          Quotes ({quotes.length})
        </button>
        <button type="button" role="tab" aria-selected={tab === 'feed'} onClick={() => setTab('feed')}
          style={tab === 'feed' ? tabBtnActiveStyle : tabBtnStyle}>
          Social Feed ({queueItems.length})
        </button>
        {hasCongressIdentity && (
          <button type="button" role="tab" aria-selected={tab === 'bills'} onClick={() => setTab('bills')}
            style={tab === 'bills' ? tabBtnActiveStyle : tabBtnStyle}>
            Bills
          </button>
        )}
      </div>

      {/* ── Tab body — fills the rest of the left column; scrolls internally ── */}
      <div style={{ ...profileSectionStyle, flex: twoColumn ? 1 : undefined, minHeight: twoColumn ? 0 : undefined, display: 'flex', flexDirection: 'column' }}>
        {tab === 'quotes' && (
          loadingQuotes ? (
            <div style={styles.muted}>Loading quotes…</div>
          ) : quotes.length === 0 ? (
            <div style={styles.muted}>No quotes yet. Use the Quotes tab or "Add by URL" to add scored quotes.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: twoColumn ? 1 : undefined, minHeight: 0, overflowY: 'auto' }}>
              {quotes.map((q) => {
                const dirColor = q.direction > 0 ? '#22c55e' : q.direction < 0 ? '#ef4444' : '#888';
                return (
                  <div key={q.id} style={{ ...styles.queueCard, borderLeftWidth: 4, borderLeftColor: dirColor }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--tk-fs-xs)', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, color: dirColor, textTransform: 'uppercase' }}>
                        {q.direction > 0 ? 'PRO' : q.direction < 0 ? 'ANTI' : 'UNSTATED'}
                      </span>
                      <span style={{ fontFamily: 'var(--tk-font-mono)', fontWeight: 700 }}>w={q.weight.toFixed(2)}</span>
                      <span style={{ padding: '1px 5px', background: 'var(--tk-surface)', border: '1px solid var(--tk-border-soft)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        {q.media_kind}
                      </span>
                      {q.quoted_at && <span style={{ color: 'var(--tk-muted)' }}>{new Date(q.quoted_at).toLocaleDateString()}</span>}
                      <span style={{ color: 'var(--tk-muted)', marginLeft: 'auto' }}>{new Date(q.created_at).toLocaleDateString()}</span>
                    </div>
                    <div style={styles.bodyText}>{q.body_text.slice(0, 300)}{q.body_text.length > 300 ? '…' : ''}</div>
                    {q.comment && <div style={{ fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)', fontStyle: 'italic' }}>Note: {q.comment}</div>}
                    <div style={styles.cardActions}>
                      {q.source_url && <a href={q.source_url} target="_blank" rel="noopener noreferrer" style={styles.link}>{q.source_label ?? 'Source'}</a>}
                      <span style={{ fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)', fontFamily: 'var(--tk-font-mono)' }}>{q.id.slice(0, 8)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )
        )}

        {tab === 'feed' && (
          <>
            {/* AC-60.16 — related by default; checkbox reveals unrelated. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)', cursor: 'pointer' }}>
                <input type="checkbox" checked={showUnrelated} onChange={(e) => setShowUnrelated(e.target.checked)} />
                Show unrelated
              </label>
              <span style={{ fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)' }}>
                Use <strong>Refresh all</strong> above to re-pull the feed.
              </span>
            </div>
            {loadingQueue ? (
              <div style={styles.muted}>Loading…</div>
            ) : feedPosts.length === 0 ? (
              <div style={styles.muted}>
                {showUnrelated ? 'No ingested posts for this person yet.' : 'No related posts — re-pull or "Show unrelated".'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: twoColumn ? 1 : undefined, minHeight: 0, overflowY: 'auto' }}>
                {feedPosts.map((item) => (
                  <div key={item.id} style={styles.queueCard}>
                    <div style={styles.queueHeader}>
                      <span style={styles.platformBadge}>{PLATFORM_LABELS[item.platform] ?? item.platform}</span>
                      <span style={styles.handle}>@{item.author_handle}</span>
                      <span style={{
                        padding: '1px 5px', fontSize: 'var(--tk-fs-xs)', fontWeight: 700, textTransform: 'uppercase',
                        background: item.status === 'curated' ? '#22c55e' : item.status === 'dismissed' ? '#ef4444' : item.status === 'unrelated' ? 'var(--tk-bg)' : 'var(--tk-surface)',
                        color: item.status === 'pending' || item.status === 'unrelated' ? 'var(--tk-muted)' : '#fff',
                        border: item.status === 'pending' || item.status === 'unrelated' ? '1px solid var(--tk-border-soft)' : 'none',
                      }}>
                        {item.status}
                      </span>
                      <span style={styles.date}>{new Date(item.posted_at).toLocaleDateString()}</span>
                    </div>
                    <div style={styles.bodyText}>{item.body_text.slice(0, 200)}{item.body_text.length > 200 ? '…' : ''}</div>
                    <div style={styles.cardActions}>
                      <a href={item.url} target="_blank" rel="noopener noreferrer" style={styles.link}>View original</a>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'bills' && hasCongressIdentity && (
          <div style={{ flex: twoColumn ? 1 : undefined, minHeight: 0, overflowY: 'auto' }}>
            <MemberVotesMatrix bioguideId={bioguideId} />
          </div>
        )}
      </div>

      </div>{/* end LEFT column flex wrapper */}

      {/* ── Resize divider (AC-60.17) — only when two-column and not collapsed ── */}
      {twoColumn && !layout.previewCollapsed && (
        <DraggableDivider containerRef={gridRef} previewPct={layout.previewPct} onChange={setPreviewPct} />
      )}

      {/* ── Widget preview (FR-60). Full pane height; collapsible to a strip. ── */}
      {twoColumn && layout.previewCollapsed ? (
        <button
          type="button"
          aria-label="Show preview"
          aria-expanded={false}
          onClick={toggleCollapsed}
          style={{
            gridArea: 'strip', cursor: 'pointer', writingMode: 'vertical-rl',
            border: '2px solid var(--tk-border-soft)', background: 'var(--tk-surface)',
            color: 'var(--tk-fg)', fontWeight: 700, fontSize: 'var(--tk-fs-xs)',
            textTransform: 'uppercase', letterSpacing: '0.04em', height: '100%',
          }}
        >
          ▸ Widget Preview
        </button>
      ) : (
        <div
          style={{
            ...profileSectionStyle,
            gridArea: 'preview',
            ...(twoColumn ? { height: '100%', minHeight: 0 } : {}),
            display: 'flex', flexDirection: 'column',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={profileSectionTitle}>Widget Preview</div>
            {twoColumn && (
              <button type="button" aria-label="Collapse preview" onClick={toggleCollapsed}
                style={{ ...styles.actionBtn, padding: '2px 8px', fontSize: 'var(--tk-fs-xs)' }}>
                ✕ Hide
              </button>
            )}
          </div>
          <div style={{ fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)', marginBottom: 4 }}>
            The public widget for {personName}, rendered against this environment&rsquo;s data.
          </div>
          <iframe
            src={embedPreviewSrc(window.location.origin, bioguideId)}
            title={`Widget preview for ${personName}`}
            style={{
              width: '100%',
              flex: twoColumn ? 1 : undefined,
              minHeight: twoColumn ? 0 : 480,
              height: twoColumn ? '100%' : undefined,
              border: '2px solid var(--tk-border-soft)',
              background: '#0d1117',
              borderRadius: 0,
            }}
          />
        </div>
      )}

      </div>{/* end two-column grid */}

      {/* Edit modal */}
      {editCard && (
        <HandleEditModal
          card={editCard}
          onClose={() => setEditCard(null)}
          onSaved={() => { setEditCard(null); setReloadHandles((n) => n + 1); }}
        />
      )}
    </div>
  );
}

/* ========================================================================== */
/*                               Stat card                                    */
/* ========================================================================== */

function StatCard({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <div style={statCardStyle}>
      <div style={{ fontSize: 'var(--tk-fs-xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--tk-muted)' }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--tk-fg)', fontFamily: 'var(--tk-font-mono)' }}>
        {value}
      </div>
      {children && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 }}>
          {children}
        </div>
      )}
    </div>
  );
}

const statCardStyle: React.CSSProperties = {
  padding: '12px 16px',
  border: '2px solid var(--tk-border-soft)',
  background: 'var(--tk-surface)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const statDetailStyle: React.CSSProperties = {
  fontSize: 'var(--tk-fs-xs)',
  color: 'var(--tk-muted)',
};

/* ========================================================================== */
/*                           Handle edit modal                                */
/* ========================================================================== */

function HandleEditModal({
  card,
  onClose,
  onSaved,
}: {
  card: PersonCard;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Working set. Locally-added rows get a synthetic `__new` flag so save creates
  // them; existing rows get patched in place. Multi-profile per platform is fine
  // — the DB unique constraint is on `(platform, platform_id, active_from)`, not
  // on `(platform, bioguide_id)`, so two Bluesky accounts for the same MoC are
  // permitted (e.g. official + personal).
  type DraftHandle = HandleRow & { __new?: boolean; __newDraft?: { handleInput: string; platformIdInput: string } };
  const [handles, setHandles] = useState<DraftHandle[]>(card.handles.map((h) => ({ ...h })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Live registry of platforms whose adapters are loaded + healthy. Drives
  // which options appear in the platform <select> below — researchers can't
  // add a Twitter handle if the bearer token isn't set, etc.
  const availablePlatforms = useAvailablePlatforms();
  const platformOptions = availablePlatforms.length > 0
    ? availablePlatforms.filter((p) => p.available).map((p) => p.slug)
    : ['bluesky', 'mastodon']; // safe fallback while loading

  const moc = card.moc;
  const ps = moc ? partyStyle(moc.party) : null;
  const photoUrl = moc?.photoUrl ?? card.avatarUrl;

  function updateField(id: string, field: keyof HandleRow, value: string) {
    // When the researcher pastes a profile URL into the handle field, parse
    // it and auto-fill both the platform and the bare handle. This means
    // they can paste any social URL without having to extract the @handle
    // by hand or pick the right platform first.
    if (field === 'handle') {
      const parsed = parseHandleUrl(value);
      if (parsed) {
        setHandles((prev) => prev.map((h) => h.id === id ? { ...h, platform: parsed.platform, handle: parsed.handle } : h));
        return;
      }
    }
    setHandles((prev) => prev.map((h) => h.id === id ? { ...h, [field]: value } : h));
  }

  function addNewHandle() {
    // Use a temporary client-side id; replaced by server-issued id on save.
    const tmpId = `__new_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    setHandles((prev) => [
      ...prev,
      {
        id: tmpId,
        bioguide_id: card.bioguideId,
        entity_name: null,
        account_category: 'congress',
        platform: platformOptions[0] ?? 'bluesky',
        handle: '',
        display_name: null,
        avatar_url: null,
        last_polled_at: null,
        last_poll_attempted_at: null,
        last_poll_status: null,
        last_poll_error: null,
        last_poll_trace_id: null,
        __new: true,
      },
    ]);
  }

  async function saveAll() {
    setSaving(true);
    setError(null);
    try {
      for (const h of handles) {
        if (h.__new) {
          if (!h.handle.trim()) continue; // skip empty draft rows silently
          // Create on the server. platform_id defaults to the handle text when
          // unknown — backend `resolveAccount` should be called on first poll
          // to fill in the canonical platform_id, but for now we store the
          // handle as-is so curators can add accounts immediately.
          await post('/api/admin/ingest/handles', {
            bioguide_id: card.bioguideId,
            entity_name: card.name,
            account_category: 'congress',
            platform: h.platform,
            account_kind: 'official',
            handle: h.handle.trim(),
            platform_id: h.handle.trim(), // resolved on first poll
            display_name: card.name,
          });
        } else {
          const orig = card.handles.find((o) => o.id === h.id);
          if (!orig) continue;
          const changes: Record<string, string> = {};
          if (h.handle !== orig.handle) changes['handle'] = h.handle;
          if (h.platform !== orig.platform) changes['platform'] = h.platform;
          if (Object.keys(changes).length > 0) {
            await patch(`/api/admin/ingest/handles/${h.id}`, changes);
          }
        }
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function removeHandle(id: string) {
    // Local-only draft? Just drop from state.
    if (id.startsWith('__new_')) {
      setHandles((prev) => prev.filter((h) => h.id !== id));
      return;
    }
    try {
      await del(`/api/admin/ingest/handles/${id}`);
      setHandles((prev) => prev.filter((h) => h.id !== id));
      onSaved();
    } catch {
      setError('Remove failed');
    }
  }

  return (
    <div
      ref={backdropRef}
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
      style={modalStyles.backdrop}
    >
      <div style={modalStyles.panel}>
        <div style={{
          ...rosterStyles.cardHeader,
          padding: '16px 20px',
          borderBottom: `3px solid ${ps?.accent ?? 'var(--tk-border-soft)'}`,
          background: ps ? ps.bg : 'var(--tk-surface)',
        }}>
          {photoUrl ? (
            <img
              src={photoUrl}
              alt=""
              style={{ ...rosterStyles.avatar, width: 52, height: 52, borderColor: ps?.accent ?? 'var(--tk-border-soft)' }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          ) : (
            <div style={{
              ...rosterStyles.avatarPlaceholder,
              width: 52, height: 52, fontSize: 18,
              background: ps ? ps.accent : 'var(--tk-surface)',
            }}>
              {card.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
            </div>
          )}
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: ps ? ps.fg : 'var(--tk-fg)' }}>
              {card.name}
            </div>
            {moc && (
              <div style={{ fontSize: 'var(--tk-fs-xs)', color: ps ? 'rgba(255,255,255,0.7)' : 'var(--tk-muted)' }}>
                {moc.chamber === 'Senate' ? 'Senator' : 'Rep.'}{' '}
                <span style={{ color: ps?.accent, fontWeight: 700 }}>{moc.party}</span>
                {' · '}{moc.state}{moc.chamber === 'House' && moc.district ? `-${moc.district}` : ''}
              </div>
            )}
          </div>
          <button type="button" onClick={onClose} style={modalStyles.closeBtn} title="Close">
            ✕
          </button>
        </div>

        <div style={modalStyles.body}>
          <div style={{ fontSize: 'var(--tk-fs-xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--tk-muted)', marginBottom: 8 }}>
            Social handles ({handles.length})
          </div>

          {handles.map((h) => (
            <div key={h.id} style={modalStyles.row}>
              <select
                value={h.platform}
                onChange={(e) => updateField(h.id, 'platform', e.target.value)}
                style={{ ...styles.select, minWidth: 110 }}
              >
                {/* Always include the current platform so existing rows for a
                    now-unavailable platform still render correctly. */}
                {!platformOptions.includes(h.platform) && (
                  <option value={h.platform}>{PLATFORM_LABELS[h.platform] ?? h.platform} (unavailable)</option>
                )}
                {platformOptions.map((slug) => (
                  <option key={slug} value={slug}>{PLATFORM_LABELS[slug] ?? slug}</option>
                ))}
              </select>
              <input
                type="text"
                value={h.handle}
                onChange={(e) => updateField(h.id, 'handle', e.target.value)}
                style={{ ...styles.input, flex: 1 }}
              />
              <button
                type="button"
                onClick={() => removeHandle(h.id)}
                style={modalStyles.removeBtn}
                title="Remove handle"
              >
                ✕
              </button>
            </div>
          ))}

          <button
            type="button"
            onClick={addNewHandle}
            style={{
              ...styles.actionBtn,
              background: 'var(--tk-surface)',
              color: 'var(--tk-fg)',
              border: '2px dashed var(--tk-border-soft)',
              alignSelf: 'flex-start',
              marginTop: 8,
              fontSize: 'var(--tk-fs-xs)',
            }}
            title="Add a second/third profile (e.g. official + personal). Curators only."
          >
            + Add another handle
          </button>

          {error && <div style={styles.error}>{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button type="button" onClick={onClose} style={{ ...styles.actionBtn, background: 'var(--tk-surface)', color: 'var(--tk-fg)', border: '2px solid var(--tk-border-soft)' }}>
              Cancel
            </button>
            <button type="button" onClick={saveAll} disabled={saving} style={styles.actionBtn}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ========================================================================== */
/*                       Per-handle social monitoring row                     */
/* ========================================================================== */

/** Single handle row with poll status + trace ID + re-poll. Trace IDs are
 *  user-visible per CLAUDE.md "Workflow conventions". */
function HandleStatusRow({ handle, pollable, onRepoll }: { handle: HandleRow; pollable: boolean; onRepoll: () => void }) {
  const [polling, setPolling] = useState(false);
  const [pollResult, setPollResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const status = handle.last_poll_status;
  const isError = status === 'error';
  const isOk = status === 'ok';
  const accent = isError ? 'var(--tk-danger)' : isOk ? '#22c55e' : 'var(--tk-muted)';

  async function repoll() {
    setPolling(true);
    setPollResult(null);
    try {
      const r = await post<{ skipped: boolean; error: string | null; newPosts: number; traceId?: string }>(
        '/api/admin/ingest/poll-handle',
        { handle_id: handle.id, force: true },
      );
      if (r.error) {
        setPollResult({ ok: false, msg: r.error });
      } else {
        setPollResult({ ok: true, msg: `+${r.newPosts} new` });
      }
      onRepoll();
    } catch (e) {
      setPollResult({ ok: false, msg: errorMsg(e) });
    } finally {
      setPolling(false);
    }
  }

  return (
    <div style={{
      ...rosterStyles.platformChip,
      flexDirection: 'column',
      alignItems: 'stretch',
      padding: '8px 10px',
      borderLeft: `4px solid ${accent}`,
      gap: 4,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {pollable && (
          <span style={{
            fontSize: 'var(--tk-fs-xs)',
            fontWeight: 700,
            padding: '1px 6px',
            background: accent,
            color: '#fff',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}>
            {status ?? 'never tried'}
          </span>
        )}
        <span style={{ fontWeight: 700 }}>{PLATFORM_LABELS[handle.platform] ?? handle.platform}</span>
        <span style={{ fontFamily: 'var(--tk-font-mono)' }}>@{handle.handle}</span>
        <span style={{ flex: 1 }} />
        {pollable && (
          <>
            <span style={{ fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)' }}>
              last attempted: {relTime(handle.last_poll_attempted_at ?? null)}
            </span>
            <span style={{ fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)' }}>
              last success: {handle.last_polled_at ? relTime(handle.last_polled_at) : 'never'}
            </span>
          </>
        )}
        {pollable ? (
          <button
            type="button"
            onClick={repoll}
            disabled={polling}
            style={rosterStyles.editBtn}
          >
            {polling ? 'Syncing…' : 'Sync now'}
          </button>
        ) : (
          <span
            title="No automated poller for this platform — display only."
            style={{
              fontSize: 'var(--tk-fs-xs)',
              fontWeight: 700,
              padding: '1px 6px',
              border: '1px solid var(--tk-border-soft)',
              color: 'var(--tk-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            display only
          </span>
        )}
      </div>
      {isError && handle.last_poll_error && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 8px', background: 'var(--tk-bg)', border: '1px solid rgba(239,68,68,0.3)' }}>
          <div style={{ color: 'var(--tk-danger)', fontSize: 'var(--tk-fs-sm)' }}>
            {handle.last_poll_error}
          </div>
          {handle.last_poll_trace_id && <CopyableTraceId traceId={handle.last_poll_trace_id} />}
        </div>
      )}
      {pollResult && (
        <div style={{ fontSize: 'var(--tk-fs-xs)', color: pollResult.ok ? '#22c55e' : 'var(--tk-danger)' }}>
          {pollResult.msg}
        </div>
      )}
    </div>
  );
}

function CopyableTraceId({ traceId }: { traceId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(traceId).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
      }}
      title="Click to copy this trace ID."
      style={{
        background: 'var(--tk-bg)',
        color: 'var(--tk-fg)',
        border: '1px solid var(--tk-border-soft)',
        padding: '2px 6px',
        cursor: 'pointer',
        fontSize: 'var(--tk-fs-xs)',
        fontFamily: 'var(--tk-font-mono)',
        display: 'inline-flex',
        gap: 6,
        width: 'fit-content',
      }}
    >
      <span style={{ color: 'var(--tk-muted)' }}>trace:</span>
      <span>{traceId}</span>
      <span style={{ color: copied ? '#22c55e' : 'var(--tk-muted)' }}>{copied ? '✓' : '⧉'}</span>
    </button>
  );
}

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

/** Aggregate freshness chip for the Social monitoring header. Shows the
 *  oldest successful poll across this person's handles + counts of stale
 *  / failing handles, so a researcher knows at a glance whether the data
 *  in front of them is current. */
function FreshnessBadge({ handles }: { handles: HandleRow[] }) {
  if (handles.length === 0) return null;
  const oldest = handles.reduce<number | null>((acc, h) => {
    const t = h.last_polled_at ? Date.parse(h.last_polled_at) : null;
    if (t === null) return acc;
    if (acc === null) return t;
    return Math.min(acc, t);
  }, null);
  const failing = handles.filter((h) => h.last_poll_status === 'error').length;
  const neverPolled = handles.filter((h) => !h.last_polled_at).length;
  // "stale" = last successful poll older than 24h (cron should refresh daily).
  const staleCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const stale = handles.filter((h) => h.last_polled_at && Date.parse(h.last_polled_at) < staleCutoff).length;
  const tone = failing > 0 ? 'var(--tk-danger)' : (stale > 0 || neverPolled > 0) ? '#eab308' : '#22c55e';
  const label = oldest
    ? `oldest update ${relTime(new Date(oldest).toISOString())}`
    : 'never polled';
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '2px 8px',
      border: `1px solid ${tone}`,
      color: tone,
      fontSize: 'var(--tk-fs-xs)',
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
    }}>
      {label}
      {failing > 0 && <span>· {failing} failing</span>}
      {stale > 0 && <span>· {stale} stale</span>}
      {neverPolled > 0 && <span>· {neverPolled} never polled</span>}
    </span>
  );
}

/** "Refresh all" button — fans out a force-poll across every handle for
 *  this person, in parallel with a small delay between requests so we don't
 *  trip rate limits. Researchers click this when they want fresh data on
 *  open (e.g. before scoring a quote). */
function RefreshAllButton({ handles, onDone }: { handles: HandleRow[]; onDone: () => void }) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  async function run() {
    if (handles.length === 0) return;
    setRunning(true);
    setProgress({ done: 0, total: handles.length });
    let done = 0;
    // Sequential with a tiny delay — N is small (a person has 1–6 handles).
    // Parallel would risk tripping per-platform rate limits when most handles
    // are on the same platform.
    for (const h of handles) {
      try {
        await post('/api/admin/ingest/poll-handle', { handle_id: h.id, force: true });
      } catch {
        // Non-fatal; continue the loop. The handle row will show its own error.
      }
      done++;
      setProgress({ done, total: handles.length });
      await new Promise((r) => setTimeout(r, 200));
    }
    setRunning(false);
    setProgress(null);
    onDone();
  }

  if (handles.length === 0) return null;
  return (
    <button
      type="button"
      onClick={run}
      disabled={running}
      style={rosterStyles.editBtn}
      title="Force-poll every handle for this person right now (bypasses staleness gate)."
    >
      {running ? `↻ Refreshing ${progress?.done ?? 0}/${progress?.total ?? 0}…` : '↻ Refresh all'}
    </button>
  );
}

/* ========================================================================== */
/*                                 Styles                                     */
/* ========================================================================== */

const profileSectionStyle: React.CSSProperties = {
  padding: '12px 16px',
  border: '2px solid var(--tk-border-soft)',
  background: 'var(--tk-bg)',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const profileSectionTitle: React.CSSProperties = {
  fontSize: 'var(--tk-fs-xs)',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--tk-muted)',
};

const tabNavStyle: React.CSSProperties = {
  display: 'flex',
  gap: 4,
  borderBottom: '2px solid var(--tk-border-soft)',
};

const tabBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  borderBottom: '2px solid transparent',
  marginBottom: -2,
  padding: '8px 14px',
  cursor: 'pointer',
  color: 'var(--tk-muted)',
  fontWeight: 700,
  fontSize: 'var(--tk-fs-sm)',
};

const tabBtnActiveStyle: React.CSSProperties = {
  ...tabBtnStyle,
  color: 'var(--tk-fg)',
  borderBottom: '2px solid var(--tk-accent)',
};

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
  section: { display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 8 },
  toolRow: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const },
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
  date: { color: 'var(--tk-muted)', fontSize: 'var(--tk-fs-xs)', marginLeft: 'auto' },
  bodyText: {
    fontSize: 'var(--tk-fs-sm)',
    color: 'var(--tk-fg)',
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
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
};

const rosterStyles: Record<string, React.CSSProperties> = {
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
    gap: 8,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '10px 14px',
    border: '2px solid var(--tk-border-soft)',
    background: 'var(--tk-bg)',
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'var(--tk-font)',
    color: 'var(--tk-fg)',
    transition: 'border-color 0.15s',
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: '50%',
    objectFit: 'cover' as const,
    border: '2px solid var(--tk-border-soft)',
    flexShrink: 0,
  },
  avatarPlaceholder: {
    width: 40,
    height: 40,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 14,
    fontWeight: 700,
    color: '#fff',
    flexShrink: 0,
  },
  platforms: {
    display: 'flex',
    gap: 4,
    flexWrap: 'wrap' as const,
  },
  platformChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 6px',
    background: 'var(--tk-surface)',
    border: '1px solid var(--tk-border-soft)',
    fontSize: 'var(--tk-fs-xs)',
    color: 'var(--tk-muted)',
    whiteSpace: 'nowrap' as const,
  },
  editBtn: {
    padding: '4px 10px',
    background: 'var(--tk-surface)',
    border: '2px solid var(--tk-border-soft)',
    color: 'var(--tk-fg)',
    fontSize: 'var(--tk-fs-xs)',
    fontWeight: 700,
    fontFamily: 'var(--tk-font)',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
  },
};

const modalStyles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 1000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.6)',
    backdropFilter: 'blur(4px)',
  },
  panel: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '80vh',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--tk-bg)',
    border: '2px solid var(--tk-border-soft)',
    boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
    overflow: 'hidden',
  },
  body: {
    padding: '16px 20px',
    overflowY: 'auto',
    flex: 1,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 0',
    borderBottom: '1px solid var(--tk-border-soft)',
  },
  removeBtn: {
    background: 'none',
    border: 'none',
    color: '#ef4444',
    cursor: 'pointer',
    fontSize: 16,
    fontWeight: 700,
    padding: '2px 6px',
    lineHeight: 1,
    flexShrink: 0,
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: 'rgba(255,255,255,0.7)',
    cursor: 'pointer',
    fontSize: 20,
    fontWeight: 700,
    padding: '0 4px',
    lineHeight: 1,
  },
};
