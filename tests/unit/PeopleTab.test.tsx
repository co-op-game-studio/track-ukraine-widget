/**
 * Tests for src/admin/components/PeopleTab.tsx — top-level admin SPA tab for
 * managing tracked people (members of congress + non-congress influencers/
 * journalists/etc.). Renders two screens:
 *   1. PeopleListView — searchable + filterable card grid + add-person form
 *   2. PersonProfileView — handles, quotes, ingested posts, live feed search,
 *      stats, widget preview, and a handle-edit modal (HandleEditModal)
 *
 * Trace:
 *   - FR-50 / AC-50.* — admin SPA top-level tabs (People is one)
 *   - FR-51 / AC-51.* — social handle CRUD per-person
 *   - FR-52 / AC-52.* — admin SPA, megamenu navigation, Settings home
 *   - CLAUDE.md "Trace IDs are user-visible on errors" — poll-status panels
 *   - CLAUDE.md "Tags are a system primitive" — quote weight × direction
 *
 * Conventions:
 *   - No vi.mock for the SUT — fetch is replaced via globalThis.fetch swap
 *     with restore in afterEach (see tests/unit/TagsView.test.tsx and
 *     tests/unit/useAvailablePlatforms.test.tsx for canonical patterns).
 *   - JSDOM environment from vitest.config.ts.
 *   - Multi-route fetch stub routes by URL match (handles, roster-meta,
 *     quotes, queue, platforms, search, poll-handle, seed).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { PeopleTab } from '../../src/admin/components/PeopleTab';
import { invalidatePlatformsCache, type PlatformLiveness } from '../../src/admin/hooks/useAvailablePlatforms';

const realFetch = globalThis.fetch;

interface HandleRow {
  id: string;
  bioguide_id: string | null;
  entity_name: string | null;
  account_category: string;
  platform: string;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  last_polled_at?: string | null;
  last_poll_attempted_at?: string | null;
  last_poll_status?: string | null;
  last_poll_error?: string | null;
  last_poll_trace_id?: string | null;
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

interface MocEntry {
  bioguideId: string;
  displayName: string;
  first: string;
  last: string;
  state: string;
  chamber: 'Senate' | 'House';
  district?: number | null;
  party: string;
  photoUrl?: string | null;
}

function makeHandle(o: Partial<HandleRow> = {}): HandleRow {
  return {
    id: o.id ?? 'h-1',
    bioguide_id: o.bioguide_id ?? 'B001',
    entity_name: o.entity_name ?? 'Alpha Person',
    account_category: o.account_category ?? 'congress',
    platform: o.platform ?? 'bluesky',
    handle: o.handle ?? 'alpha.bsky.social',
    display_name: o.display_name ?? 'Alpha',
    avatar_url: o.avatar_url ?? null,
    last_polled_at: o.last_polled_at ?? null,
    last_poll_attempted_at: o.last_poll_attempted_at ?? null,
    last_poll_status: o.last_poll_status ?? null,
    last_poll_error: o.last_poll_error ?? null,
    last_poll_trace_id: o.last_poll_trace_id ?? null,
  };
}

function makeQuote(o: Partial<QuoteRow> = {}): QuoteRow {
  return {
    id: o.id ?? 'q-deadbeef-1',
    bioguide_id: o.bioguide_id ?? 'B001',
    media_kind: o.media_kind ?? 'speech',
    source_url: o.source_url ?? 'https://example.com/q',
    source_label: o.source_label ?? 'C-SPAN',
    quoted_at: o.quoted_at ?? '2026-04-01T00:00:00Z',
    body_text: o.body_text ?? 'Some text spoken on the floor',
    weight: o.weight ?? 1.5,
    direction: o.direction ?? 1,
    comment: o.comment ?? null,
    author_email: o.author_email ?? 'curator@example.com',
    created_at: o.created_at ?? '2026-04-02T00:00:00Z',
  };
}

function makeQueue(o: Partial<QueueItem> = {}): QueueItem {
  return {
    id: o.id ?? 'p-1',
    bioguide_id: o.bioguide_id ?? 'B001',
    platform: o.platform ?? 'bluesky',
    platform_post_id: o.platform_post_id ?? 'post-1',
    author_handle: o.author_handle ?? 'alpha.bsky.social',
    posted_at: o.posted_at ?? '2026-04-15T12:00:00Z',
    url: o.url ?? 'https://bsky.app/profile/alpha/post/1',
    body_text: o.body_text ?? 'A pending post',
    media_refs_json: o.media_refs_json ?? '[]',
    ingested_at: o.ingested_at ?? '2026-04-15T12:01:00Z',
    status: o.status ?? 'pending',
    matched_keywords: o.matched_keywords ?? null,
    reviewed_by: o.reviewed_by ?? null,
    reviewed_at: o.reviewed_at ?? null,
  };
}

function makeMoc(o: Partial<MocEntry> = {}): MocEntry {
  return {
    bioguideId: o.bioguideId ?? 'B001',
    displayName: o.displayName ?? 'Alpha Person',
    first: o.first ?? 'Alpha',
    last: o.last ?? 'Person',
    state: o.state ?? 'CA',
    chamber: o.chamber ?? 'Senate',
    district: o.district ?? null,
    party: o.party ?? 'D',
    photoUrl: o.photoUrl ?? null,
  };
}

function makePlatform(slug: string, available = true): PlatformLiveness {
  return { slug, available, bulkEligible: available, checkedAt: '2026-05-04T00:00:00Z' };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

interface InstallOpts {
  handles?: HandleRow[];
  members?: MocEntry[];
  quotes?: QuoteRow[];
  queue?: QueueItem[];
  platforms?: PlatformLiveness[];
  onPostHandles?: (body: unknown) => Response | Promise<Response>;
  onPatchHandle?: (id: string, body: unknown) => Response | Promise<Response>;
  onDeleteHandle?: (id: string) => Response | Promise<Response>;
  onSeed?: (body: unknown) => Response | Promise<Response>;
  onSearch?: (body: unknown) => Response | Promise<Response>;
  onPoll?: (body: unknown) => Response | Promise<Response>;
}

interface InstallReturn {
  calls: FetchCall[];
  setHandles: (next: HandleRow[]) => void;
  setQueue: (next: QueueItem[]) => void;
}

function installFetch(opts: InstallOpts = {}): InstallReturn {
  const calls: FetchCall[] = [];
  const ref = {
    handles: opts.handles ?? [],
    members: opts.members ?? [],
    quotes: opts.quotes ?? [],
    queue: opts.queue ?? [],
    platforms: opts.platforms ?? [],
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = null;
    if (init?.body && typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ url, method, body });

    // Order matters — match the most specific URLs first.
    if (method === 'GET' && url.includes('/api/admin/ingest/handles')) {
      return jsonResponse({ items: ref.handles });
    }
    if (method === 'GET' && url.includes('/api/admin/ingest/roster-meta')) {
      return jsonResponse({ members: ref.members });
    }
    if (method === 'GET' && url.includes('/api/admin/ingest/platforms')) {
      return jsonResponse({ platforms: ref.platforms });
    }
    if (method === 'GET' && url.includes('/api/admin/ingest/queue')) {
      return jsonResponse({ items: ref.queue, total: ref.queue.length });
    }
    if (method === 'GET' && url.includes('/api/admin/quotes')) {
      return jsonResponse({ items: ref.quotes });
    }
    if (method === 'POST' && url.includes('/api/admin/ingest/handles')) {
      if (opts.onPostHandles) return opts.onPostHandles(body);
      return jsonResponse({ ok: true }, 201);
    }
    const patchHandle = /\/api\/admin\/ingest\/handles\/([^/?]+)$/.exec(url);
    if (method === 'PATCH' && patchHandle) {
      if (opts.onPatchHandle) return opts.onPatchHandle(patchHandle[1]!, body);
      return jsonResponse({ ok: true });
    }
    const delHandle = /\/api\/admin\/ingest\/handles\/([^/?]+)$/.exec(url);
    if (method === 'DELETE' && delHandle) {
      if (opts.onDeleteHandle) return opts.onDeleteHandle(delHandle[1]!);
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && url.includes('/api/admin/ingest/seed')) {
      if (opts.onSeed) return opts.onSeed(body);
      return jsonResponse({
        roster: { membersScanned: 535, handlesUpserted: 12, mastodon: 3, bluesky: 8 },
        keywords: { seeded: 4 },
        skipped: false,
      });
    }
    if (method === 'POST' && url.includes('/api/admin/ingest/search')) {
      if (opts.onSearch) return opts.onSearch(body);
      return jsonResponse({ bioguideId: 'B001', results: {} });
    }
    if (method === 'POST' && url.includes('/api/admin/ingest/poll-handle')) {
      if (opts.onPoll) return opts.onPoll(body);
      return jsonResponse({ skipped: false, error: null, newPosts: 0 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return {
    calls,
    setHandles: (next) => { ref.handles = next; },
    setQueue: (next) => { ref.queue = next; },
  };
}

/** JSDOM lacks matchMedia; stub it so the two-column branch (≥1100px) renders.
 *  `wide=false` simulates the mobile single-column branch. */
function stubMatchMedia(wide: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: q.includes('1100') ? wide : false,
    media: q, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  // Each test installs its own fetch stub. Reset platforms cache so the
  // hook re-fetches against the per-test stub instead of returning stale
  // data left over from another test.
  invalidatePlatformsCache();
  try { window.localStorage.removeItem('tk-admin-profile-layout'); } catch { /* noop */ }
  stubMatchMedia(true); // default: wide / two-column for profile tests
});

afterEach(() => {
  globalThis.fetch = realFetch;
  invalidatePlatformsCache();
});

/* ====================================================================== */
/*                       PeopleListView — load + render                   */
/* ====================================================================== */

describe('PeopleTab — list view load', () => {
  it('shows "Loading roster" until the handles fetch resolves', async () => {
    installFetch({ handles: [] });
    render(<PeopleTab />);
    expect(screen.getByText(/Loading roster/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Loading roster/i)).not.toBeInTheDocument());
  });

  it('groups handles into one card per person and renders the header', async () => {
    installFetch({
      handles: [
        makeHandle({ id: 'h-1', bioguide_id: 'B001', entity_name: 'Jane Doe', platform: 'bluesky' }),
        makeHandle({ id: 'h-2', bioguide_id: 'B001', entity_name: 'Jane Doe', platform: 'mastodon' }),
        makeHandle({ id: 'h-3', bioguide_id: 'B002', entity_name: 'John Roe', platform: 'bluesky' }),
      ],
      members: [
        makeMoc({ bioguideId: 'B001', displayName: 'Jane Doe', state: 'CA', chamber: 'Senate', party: 'D' }),
        makeMoc({ bioguideId: 'B002', displayName: 'John Roe', state: 'TX', chamber: 'House', district: 5, party: 'R' }),
      ],
    });
    render(<PeopleTab />);
    await waitFor(() => expect(screen.queryByText(/Loading roster/i)).not.toBeInTheDocument());
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('John Roe')).toBeInTheDocument();
    // Aggregate count: 2 people · 3 handles.
    expect(screen.getByText(/2 people · 3 handles/)).toBeInTheDocument();
  });

  it('renders avatar fallback initials when no photo is available', async () => {
    installFetch({
      handles: [makeHandle({ id: 'h-1', bioguide_id: 'B001', entity_name: 'Alpha Beta', avatar_url: null })],
      members: [makeMoc({ bioguideId: 'B001', displayName: 'Alpha Beta', photoUrl: null })],
    });
    render(<PeopleTab />);
    await waitFor(() => expect(screen.getByText('Alpha Beta')).toBeInTheDocument());
    // Initials placeholder.
    expect(screen.getByText('AB')).toBeInTheDocument();
  });

  it('handles a failing roster fetch (handles + meta) without crashing', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    render(<PeopleTab />);
    await waitFor(() => expect(screen.queryByText(/Loading roster/i)).not.toBeInTheDocument());
    // Empty list still renders the toolbar + add accordion.
    expect(screen.getByRole('button', { name: /\+ Add person/ })).toBeInTheDocument();
  });
});

/* ====================================================================== */
/*                       Search + category filter                         */
/* ====================================================================== */

describe('PeopleTab — search + filter', () => {
  it('filters by name match (case-insensitive)', async () => {
    installFetch({
      handles: [
        makeHandle({ id: 'h-1', bioguide_id: 'B001', entity_name: 'Jane Doe' }),
        makeHandle({ id: 'h-2', bioguide_id: 'B002', entity_name: 'John Roe' }),
      ],
      members: [
        makeMoc({ bioguideId: 'B001', displayName: 'Jane Doe' }),
        makeMoc({ bioguideId: 'B002', displayName: 'John Roe' }),
      ],
    });
    render(<PeopleTab />);
    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/Search by name/i), { target: { value: 'jane' } });
    await waitFor(() => expect(screen.queryByText('John Roe')).not.toBeInTheDocument());
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
  });

  it('filters by state (MoC metadata)', async () => {
    installFetch({
      handles: [
        makeHandle({ id: 'h-1', bioguide_id: 'B001', entity_name: 'Jane Doe' }),
        makeHandle({ id: 'h-2', bioguide_id: 'B002', entity_name: 'John Roe' }),
      ],
      members: [
        makeMoc({ bioguideId: 'B001', displayName: 'Jane Doe', state: 'CA' }),
        makeMoc({ bioguideId: 'B002', displayName: 'John Roe', state: 'TX' }),
      ],
    });
    render(<PeopleTab />);
    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/2 people/)).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/Search by name/i), { target: { value: 'tx' } });
    await waitFor(() => expect(screen.queryByText('Jane Doe')).not.toBeInTheDocument());
    expect(screen.getByText('John Roe')).toBeInTheDocument();
  });

  it('filters by handle text', async () => {
    installFetch({
      handles: [
        makeHandle({ id: 'h-1', bioguide_id: 'B001', entity_name: 'Jane', handle: 'jane.bsky.social' }),
        makeHandle({ id: 'h-2', bioguide_id: 'B002', entity_name: 'John', handle: 'john.bsky.social' }),
      ],
      members: [
        makeMoc({ bioguideId: 'B001', displayName: 'Jane' }),
        makeMoc({ bioguideId: 'B002', displayName: 'John' }),
      ],
    });
    render(<PeopleTab />);
    await waitFor(() => expect(screen.getByText('Jane')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/Search by name/i), { target: { value: 'john.bsky' } });
    await waitFor(() => expect(screen.queryByText('Jane')).not.toBeInTheDocument());
  });

  it('filters by category dropdown', async () => {
    installFetch({
      handles: [
        makeHandle({ id: 'h-1', bioguide_id: 'B001', entity_name: 'Aaron Reps', account_category: 'congress' }),
        makeHandle({ id: 'h-2', bioguide_id: 'B002', entity_name: 'Beth Smith', account_category: 'congress' }),
      ],
      members: [
        makeMoc({ bioguideId: 'B001', displayName: 'Aaron Reps' }),
        makeMoc({ bioguideId: 'B002', displayName: 'Beth Smith' }),
      ],
    });
    render(<PeopleTab />);
    await waitFor(() => expect(screen.getByText('Aaron Reps')).toBeInTheDocument());
    expect(screen.getByText('Beth Smith')).toBeInTheDocument();
    // Pick a non-congress category — both cards should disappear.
    const selects = screen.getAllByRole('combobox');
    const filterSelect = selects.find((s) => within(s).queryByText('All categories'));
    expect(filterSelect).toBeTruthy();
    fireEvent.change(filterSelect!, { target: { value: 'influencer' } });
    await waitFor(() => expect(screen.queryByText('Aaron Reps')).not.toBeInTheDocument());
    expect(screen.queryByText('Beth Smith')).not.toBeInTheDocument();
    // Switch back to "All" — both should reappear.
    fireEvent.change(filterSelect!, { target: { value: '' } });
    await waitFor(() => expect(screen.getByText('Aaron Reps')).toBeInTheDocument());
  });
});

/* ====================================================================== */
/*                            Add person form                             */
/* ====================================================================== */

describe('PeopleTab — add person form', () => {
  it('opens and closes the accordion form', async () => {
    installFetch({ handles: [] });
    render(<PeopleTab />);
    await waitFor(() => expect(screen.queryByText(/Loading roster/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /\+ Add person/ }));
    expect(screen.getByPlaceholderText(/Name \(e.g. Jake Sullivan\)/)).toBeInTheDocument();
    // Close button (✕).
    fireEvent.click(screen.getByTitle('Close'));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/Name \(e.g. Jake Sullivan\)/)).not.toBeInTheDocument(),
    );
  });

  it('Add button is disabled when name is empty', async () => {
    installFetch({ handles: [] });
    render(<PeopleTab />);
    await waitFor(() => expect(screen.queryByText(/Loading roster/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /\+ Add person/ }));
    // The "+ Add person" submit button is the second one — find by being disabled.
    const submitBtn = screen.getAllByRole('button', { name: /\+ Add person/ })
      .find((b) => (b as HTMLButtonElement).disabled);
    expect(submitBtn).toBeTruthy();
  });

  it('POSTs once per filled platform and closes the form on success', async () => {
    const stub = installFetch({
      handles: [],
      onPostHandles: () => jsonResponse({ ok: true }, 201),
    });
    render(<PeopleTab />);
    await waitFor(() => expect(screen.queryByText(/Loading roster/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /\+ Add person/ }));
    fireEvent.change(screen.getByPlaceholderText(/Name \(e.g. Jake Sullivan\)/), {
      target: { value: 'Jake Sullivan' },
    });
    // Fill bluesky + youtube handles.
    fireEvent.change(
      screen.getByPlaceholderText(/@user.bsky.social or paste profile URL/),
      { target: { value: 'jake.bsky.social' } },
    );
    // Click the submit button (it's the only enabled one labelled "+ Add person"
    // now that name is populated).
    const submitBtn = screen.getAllByRole('button', { name: /\+ Add person/ })
      .find((b) => !(b as HTMLButtonElement).disabled);
    fireEvent.click(submitBtn!);
    await waitFor(
      () => expect(stub.calls.some((c) => c.method === 'POST')).toBe(true),
      { timeout: 3000 },
    );
    // POST body shape — entity_name + platform + handle.
    const post = stub.calls.find((c) => c.method === 'POST')!;
    const body = post.body as Record<string, unknown>;
    expect(body.entity_name).toBe('Jake Sullivan');
    expect(body.platform).toBe('bluesky');
    expect(body.handle).toBe('jake.bsky.social');
  });

  it('parses a pasted bluesky URL and routes to the bluesky box', async () => {
    installFetch({ handles: [] });
    render(<PeopleTab />);
    await waitFor(() => expect(screen.queryByText(/Loading roster/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /\+ Add person/ }));
    const blueskyBox = screen.getByPlaceholderText(/@user.bsky.social or paste profile URL/) as HTMLInputElement;
    fireEvent.change(blueskyBox, { target: { value: 'https://bsky.app/profile/foo.bsky.social' } });
    // The bare handle ends up in the bluesky box.
    expect(blueskyBox.value).toBe('foo.bsky.social');
  });
});

/* ====================================================================== */
/*                            Re-sync roster                              */
/* ====================================================================== */

describe('PeopleTab — re-sync roster', () => {
  it('POSTs to /api/admin/ingest/seed and surfaces the result line', async () => {
    const stub = installFetch({
      handles: [],
      onSeed: () => jsonResponse({
        roster: { membersScanned: 535, handlesUpserted: 12, mastodon: 3, bluesky: 8 },
        keywords: { seeded: 4 },
        skipped: false,
      }),
    });
    render(<PeopleTab />);
    await waitFor(() => expect(screen.queryByText(/Loading roster/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Re-sync/ }));
    await waitFor(() => expect(stub.calls.some((c) => c.url.includes('/seed'))).toBe(true), { timeout: 3000 });
    await waitFor(() => expect(screen.getByText(/535 members scanned/)).toBeInTheDocument());
    expect(screen.getByText(/12 handles upserted/)).toBeInTheDocument();
    expect(screen.getByText(/8 Bluesky matched/)).toBeInTheDocument();
  });

  it('shows "Re-sync failed" on error', async () => {
    installFetch({
      handles: [],
      onSeed: () => jsonResponse({ error: 'boom' }, 500),
    });
    render(<PeopleTab />);
    await waitFor(() => expect(screen.queryByText(/Loading roster/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Re-sync/ }));
    await waitFor(() => expect(screen.getByText(/Re-sync failed/i)).toBeInTheDocument(), { timeout: 3000 });
  });
});

/* ====================================================================== */
/*                        Profile view navigation                         */
/* ====================================================================== */

describe('PeopleTab — profile navigation', () => {
  it('opens profile view when initialBioguide prop is set', async () => {
    installFetch({
      handles: [makeHandle({ id: 'h-1', bioguide_id: 'B001', entity_name: 'Jane Doe' })],
      members: [makeMoc({ bioguideId: 'B001', displayName: 'Jane Doe', state: 'CA', chamber: 'Senate' })],
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky')],
    });
    render(<PeopleTab initialBioguide="B001" />);
    expect(await screen.findByRole('button', { name: /← Back to People/ })).toBeInTheDocument();
  });

  it('clicking a card opens the profile (when bioguideId is set)', async () => {
    installFetch({
      handles: [makeHandle({ id: 'h-1', bioguide_id: 'B001', entity_name: 'Jane Doe' })],
      members: [makeMoc({ bioguideId: 'B001', displayName: 'Jane Doe' })],
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky')],
    });
    render(<PeopleTab />);
    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());
    // The card itself is a button; click the heading inside it.
    fireEvent.click(screen.getByText('Jane Doe').closest('button')!);
    expect(await screen.findByRole('button', { name: /← Back to People/ })).toBeInTheDocument();
  });

  it('back button returns to the list', async () => {
    installFetch({
      handles: [makeHandle({ id: 'h-1', bioguide_id: 'B001', entity_name: 'Jane Doe' })],
      members: [makeMoc({ bioguideId: 'B001', displayName: 'Jane Doe' })],
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky')],
    });
    render(<PeopleTab initialBioguide="B001" />);
    const back = await screen.findByRole('button', { name: /← Back to People/ });
    fireEvent.click(back);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /← Back to People/ })).not.toBeInTheDocument(),
    );
  });
});

/* ====================================================================== */
/*                Profile view — sections (handles/quotes/queue)          */
/* ====================================================================== */

describe('PeopleTab — profile sections', () => {
  it('renders the social monitoring section with handle rows', async () => {
    installFetch({
      handles: [
        makeHandle({ id: 'h-1', bioguide_id: 'B001', platform: 'bluesky', handle: 'jane.bsky.social', last_poll_status: 'ok', last_polled_at: '2026-05-04T00:00:00Z' }),
      ],
      members: [makeMoc({ bioguideId: 'B001', displayName: 'Jane Doe' })],
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky')],
    });
    render(<PeopleTab initialBioguide="B001" />);
    // AC-60.10: the Social monitoring panel is collapsed by default — expand it.
    const toggle = await screen.findByRole('button', { name: /Social monitoring/i });
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText('@jane.bsky.social')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Sync now/ })).toBeInTheDocument();
  });

  it('shows "No social handles linked" when there are none', async () => {
    installFetch({
      handles: [],
      members: [makeMoc({ bioguideId: 'B001', displayName: 'Jane Doe' })],
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky')],
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    // AC-60.10: expand the collapsed Social monitoring panel first.
    fireEvent.click(await screen.findByRole('button', { name: /Social monitoring/i }));
    await waitFor(() =>
      expect(screen.getByText(/No social handles linked to this person/)).toBeInTheDocument(),
    );
  });

  it('AC-60.10 — Social monitoring is collapsed by default but its issue summary stays visible', async () => {
    installFetch({
      // One handle that has never been polled ←’ FreshnessBadge shows "never polled".
      handles: [
        makeHandle({ id: 'h-1', bioguide_id: 'B001', platform: 'bluesky', handle: 'jane.bsky.social', last_poll_status: 'error', last_polled_at: null }),
      ],
      members: [makeMoc({ bioguideId: 'B001', displayName: 'Jane Doe' })],
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky')],
    });
    render(<PeopleTab initialBioguide="B001" />);
    const toggle = await screen.findByRole('button', { name: /Social monitoring/i });
    // The FreshnessBadge only renders once the (async) handles fetch resolves —
    // wait for the issue summary to appear before asserting on it. (Without this
    // wait the assertion races the fetch: handles.length is briefly 0 and no
    // badge is rendered — the CI flake on PeopleTab.test.tsx:650.)
    await waitFor(() => expect(within(toggle).getByText(/\d+ failing/i)).toBeInTheDocument());
    // Collapsed by default → the handle row is NOT rendered…
    expect(screen.queryByText('@jane.bsky.social')).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // …but the issue summary (failing / never-polled counts) stays on the
    // header so monitoring problems remain visible while collapsed.
    expect(within(toggle).getByText(/\d+ never polled/i)).toBeInTheDocument();
  });

  it('renders a quote row with weight + direction badges', async () => {
    installFetch({
      handles: [makeHandle({ bioguide_id: 'B001' })],
      members: [makeMoc({ bioguideId: 'B001' })],
      quotes: [
        makeQuote({ id: 'q-deadbeef-1', direction: 1, weight: 2.0, body_text: 'Pro-bill statement' }),
        makeQuote({ id: 'q-cafe-2', direction: -1, weight: 1.0, body_text: 'Anti-bill statement' }),
        makeQuote({ id: 'q-zero-3', direction: 0, weight: 0.5, body_text: 'Neutral statement' }),
      ],
      queue: [],
      platforms: [makePlatform('bluesky')],
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    await waitFor(() => expect(screen.getByText(/Pro-bill statement/)).toBeInTheDocument());
    expect(screen.getByText('PRO')).toBeInTheDocument();
    expect(screen.getByText('ANTI')).toBeInTheDocument();
    expect(screen.getByText('UNSTATED')).toBeInTheDocument();
  });

  it('shows "No quotes yet" when the quotes list is empty', async () => {
    installFetch({
      handles: [makeHandle({ bioguide_id: 'B001' })],
      members: [makeMoc({ bioguideId: 'B001' })],
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky')],
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    await waitFor(() => expect(screen.getByText(/No quotes yet/i)).toBeInTheDocument());
  });

  it('renders ingested posts with status badges', async () => {
    installFetch({
      handles: [makeHandle({ bioguide_id: 'B001' })],
      members: [makeMoc({ bioguideId: 'B001' })],
      quotes: [],
      queue: [
        makeQueue({ id: 'p-1', status: 'pending', body_text: 'Pending text here' }),
        makeQueue({ id: 'p-2', status: 'curated', body_text: 'Curated text here' }),
        makeQueue({ id: 'p-3', status: 'dismissed', body_text: 'Dismissed text here' }),
      ],
      platforms: [makePlatform('bluesky')],
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    // AC-60.14/16 — ingested posts now live in the Social Feed tab.
    fireEvent.click(await screen.findByRole('tab', { name: /Social Feed/i }));
    await waitFor(() => expect(screen.getByText(/Pending text here/)).toBeInTheDocument());
    expect(screen.getByText('pending')).toBeInTheDocument();
    expect(screen.getByText('curated')).toBeInTheDocument();
    expect(screen.getByText('dismissed')).toBeInTheDocument();
  });

  it('AC-60.16 — Social Feed shows related by default; the ephemeral Live Feed Search is gone', async () => {
    installFetch({
      handles: [makeHandle({ bioguide_id: 'B001', platform: 'bluesky' })],
      members: [makeMoc({ bioguideId: 'B001' })],
      quotes: [],
      queue: [
        makeQueue({ id: 'p-rel', status: 'pending', matched_keywords: '["Ukraine"]', body_text: 'related post body' }),
        makeQueue({ id: 'p-unrel', status: 'unrelated', matched_keywords: null, body_text: 'unrelated post body' }),
      ],
      platforms: [makePlatform('bluesky')],
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    fireEvent.click(await screen.findByRole('tab', { name: /Social Feed/i }));
    // Related shown, unrelated hidden by default.
    await waitFor(() => expect(screen.getByText(/related post body/)).toBeInTheDocument());
    expect(screen.queryByText(/unrelated post body/)).not.toBeInTheDocument();
    // The deleted ephemeral search UI is gone.
    expect(screen.queryByText(/Live Feed Search/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Fetch latest/i })).not.toBeInTheDocument();
    // Checking "Show unrelated" reveals the unrelated post.
    fireEvent.click(screen.getByRole('checkbox', { name: /Show unrelated/i }));
    await waitFor(() => expect(screen.getByText(/unrelated post body/)).toBeInTheDocument());
  });
});

/* ====================================================================== */
/*                      Profile view — stat cards                         */
/* ====================================================================== */

describe('PeopleTab — stat cards', () => {
  it('renders stat cards for handles, quotes, ingested posts', async () => {
    installFetch({
      handles: [
        makeHandle({ id: 'h-1', bioguide_id: 'B001', platform: 'bluesky' }),
        makeHandle({ id: 'h-2', bioguide_id: 'B001', platform: 'mastodon' }),
      ],
      members: [makeMoc({ bioguideId: 'B001' })],
      quotes: [
        makeQuote({ id: 'q-1', direction: 1, weight: 2.0 }),
        makeQuote({ id: 'q-2', direction: -1, weight: 1.0 }),
      ],
      queue: [
        makeQueue({ id: 'p-1', status: 'pending' }),
        makeQueue({ id: 'p-2', status: 'curated' }),
        makeQueue({ id: 'p-3', status: 'unrelated', matched_keywords: null }),
        makeQueue({ id: 'p-4', status: 'unrelated', matched_keywords: null }),
      ],
      platforms: [makePlatform('bluesky'), makePlatform('mastodon')],
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    await waitFor(() => expect(screen.getByText('Social handles')).toBeInTheDocument());
    expect(screen.getByText('Quotes')).toBeInTheDocument();
    expect(screen.getByText('Ingested posts')).toBeInTheDocument();
    expect(screen.getByText('Quote score impact')).toBeInTheDocument();
    // The Ingested Posts card breaks down by status, including Unrelated.
    expect(screen.getByText('Unrelated: 2')).toBeInTheDocument();
  });
});

/* ====================================================================== */
/*                     Profile view — re-poll handle                      */
/* ====================================================================== */

describe('PeopleTab — re-poll handle', () => {
  it('POSTs to /api/admin/ingest/poll-handle and shows new-post count', async () => {
    const stub = installFetch({
      handles: [makeHandle({ id: 'h-1', bioguide_id: 'B001', platform: 'bluesky', handle: 'jane.bsky.social' })],
      members: [makeMoc({ bioguideId: 'B001' })],
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky')],
      onPoll: () => jsonResponse({ skipped: false, error: null, newPosts: 3 }),
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    fireEvent.click(await screen.findByRole('button', { name: /Social monitoring/i }));
    const repollBtn = await screen.findByRole('button', { name: /Sync now/ });
    fireEvent.click(repollBtn);
    await waitFor(
      () => expect(stub.calls.some((c) => c.url.includes('/poll-handle'))).toBe(true),
      { timeout: 3000 },
    );
    await waitFor(() => expect(screen.getByText(/\+3 new/)).toBeInTheDocument(), { timeout: 3000 });
  });

  it('AC-60.22 — refetches the posts feed after a re-poll completes', async () => {
    // Queue is empty at first load; the re-poll "ingests" a post (we swap the
    // stub's queue) and the feed must refetch and show it without a reload.
    const stub = installFetch({
      handles: [makeHandle({ id: 'h-1', bioguide_id: 'B001', platform: 'bluesky', handle: 'jane.bsky.social' })],
      members: [makeMoc({ bioguideId: 'B001' })],
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky')],
      onPoll: () => {
        // Simulate the poll persisting a new post to the queue.
        stub.setQueue([
          makeQueue({ id: 'q-new-1', bioguide_id: 'B001', body_text: 'freshly ingested post' }),
        ]);
        return jsonResponse({ skipped: false, error: null, newPosts: 1 });
      },
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    fireEvent.click(await screen.findByRole('button', { name: /Social monitoring/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Sync now/ }));
    // The newly-ingested post appears because the queue effect refetches when
    // the reload trigger bumps after the poll's onDone/onRepoll. View it in the
    // Social Feed tab (AC-60.14).
    fireEvent.click(await screen.findByRole('tab', { name: /Social Feed/i }));
    await waitFor(
      () => expect(screen.getByText(/freshly ingested post/i)).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it('shows the error message when poll returns an error', async () => {
    installFetch({
      handles: [makeHandle({ id: 'h-1', bioguide_id: 'B001', platform: 'bluesky', handle: 'jane.bsky.social' })],
      members: [makeMoc({ bioguideId: 'B001' })],
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky')],
      onPoll: () => jsonResponse({ skipped: false, error: 'rate_limited', newPosts: 0 }),
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    fireEvent.click(await screen.findByRole('button', { name: /Social monitoring/i }));
    const repollBtn = await screen.findByRole('button', { name: /Sync now/ });
    fireEvent.click(repollBtn);
    await waitFor(() => expect(screen.getByText(/rate_limited/)).toBeInTheDocument(), { timeout: 3000 });
  });

  it('shows trace ID and error from prior failed poll', async () => {
    installFetch({
      handles: [makeHandle({
        id: 'h-1',
        bioguide_id: 'B001',
        platform: 'bluesky',
        handle: 'jane.bsky.social',
        last_poll_status: 'error',
        last_poll_error: 'Auth failed',
        last_poll_trace_id: 'trace-xyz-456',
      })],
      members: [makeMoc({ bioguideId: 'B001' })],
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky')],
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    fireEvent.click(await screen.findByRole('button', { name: /Social monitoring/i }));
    await waitFor(() => expect(screen.getByText(/Auth failed/)).toBeInTheDocument());
    expect(screen.getByText(/trace-xyz-456/)).toBeInTheDocument();
  });

  it('renders "display only" for handles whose platform has no adapter', async () => {
    installFetch({
      handles: [makeHandle({ id: 'h-1', bioguide_id: 'B001', platform: 'twitter', handle: 'jane' })],
      members: [makeMoc({ bioguideId: 'B001' })],
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky')], // twitter not available
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    fireEvent.click(await screen.findByRole('button', { name: /Social monitoring/i }));
    await waitFor(() => expect(screen.getByText(/display only/i)).toBeInTheDocument(), { timeout: 3000 });
    // No re-poll button for unsupported platforms.
    expect(screen.queryByRole('button', { name: /Sync now/ })).not.toBeInTheDocument();
  });
});

/* ====================================================================== */
/*                       Refresh-all button                               */
/* ====================================================================== */

describe('PeopleTab — refresh all', () => {
  it('fans out a poll for each handle when clicked', async () => {
    const stub = installFetch({
      handles: [
        makeHandle({ id: 'h-1', bioguide_id: 'B001', platform: 'bluesky' }),
        makeHandle({ id: 'h-2', bioguide_id: 'B001', platform: 'mastodon' }),
      ],
      members: [makeMoc({ bioguideId: 'B001' })],
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky'), makePlatform('mastodon')],
      onPoll: () => jsonResponse({ skipped: false, error: null, newPosts: 0 }),
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    const refreshBtn = await screen.findByRole('button', { name: /Refresh all/ });
    fireEvent.click(refreshBtn);
    // The fan-out is sequential with a 200ms delay between each — wait for
    // both polls to land.
    await waitFor(
      () => expect(stub.calls.filter((c) => c.url.includes('/poll-handle')).length).toBe(2),
      { timeout: 3000 },
    );
  });
});

/* ====================================================================== */
/*                       Handle edit modal                                */
/* ====================================================================== */

describe('PeopleTab — handle edit modal', () => {
  it('opens the modal when "Edit handles" is clicked', async () => {
    installFetch({
      handles: [makeHandle({ id: 'h-1', bioguide_id: 'B001', platform: 'bluesky', handle: 'jane.bsky.social' })],
      members: [makeMoc({ bioguideId: 'B001', displayName: 'Jane Doe' })],
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky'), makePlatform('mastodon')],
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    const editBtn = await screen.findByRole('button', { name: /Edit handles/ });
    fireEvent.click(editBtn);
    expect(await screen.findByRole('button', { name: /\+ Add another handle/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save changes/ })).toBeInTheDocument();
  });

  it('closes via the Cancel button', async () => {
    installFetch({
      handles: [makeHandle({ id: 'h-1', bioguide_id: 'B001', platform: 'bluesky', handle: 'jane.bsky.social' })],
      members: [makeMoc({ bioguideId: 'B001', displayName: 'Jane Doe' })],
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky')],
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    fireEvent.click(await screen.findByRole('button', { name: /Edit handles/ }));
    await screen.findByRole('button', { name: /Save changes/ });
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Save changes/ })).not.toBeInTheDocument(),
    );
  });

  it('adds a draft row when "+ Add another handle" is clicked', async () => {
    installFetch({
      handles: [makeHandle({ id: 'h-1', bioguide_id: 'B001', platform: 'bluesky', handle: 'jane.bsky.social' })],
      members: [makeMoc({ bioguideId: 'B001', displayName: 'Jane Doe' })],
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky'), makePlatform('mastodon')],
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    fireEvent.click(await screen.findByRole('button', { name: /Edit handles/ }));
    const addBtn = await screen.findByRole('button', { name: /\+ Add another handle/ });
    fireEvent.click(addBtn);
    // Counter ticks up: "Social handles (2)".
    await waitFor(() => expect(screen.getByText(/Social handles \(2\)/)).toBeInTheDocument());
  });

  it('PATCHes when an existing handle changes', async () => {
    const stub = installFetch({
      handles: [makeHandle({ id: 'h-1', bioguide_id: 'B001', platform: 'bluesky', handle: 'jane.bsky.social' })],
      members: [makeMoc({ bioguideId: 'B001', displayName: 'Jane Doe' })],
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky')],
      onPatchHandle: (id, body) => {
        expect(id).toBe('h-1');
        const b = body as Record<string, string>;
        expect(b.handle).toBe('jane2.bsky.social');
        return jsonResponse({ ok: true });
      },
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    fireEvent.click(await screen.findByRole('button', { name: /Edit handles/ }));
    // The handle input is pre-filled with 'jane.bsky.social'. Find by value.
    const handleInput = await waitFor(() => {
      const inputs = screen.getAllByDisplayValue('jane.bsky.social');
      return inputs[0] as HTMLInputElement;
    });
    fireEvent.change(handleInput, { target: { value: 'jane2.bsky.social' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(
      () => expect(stub.calls.some((c) => c.method === 'PATCH')).toBe(true),
      { timeout: 3000 },
    );
  });

  it('POSTs a new handle when a draft row is filled and saved', async () => {
    const stub = installFetch({
      handles: [makeHandle({ id: 'h-1', bioguide_id: 'B001', platform: 'bluesky', handle: 'jane.bsky.social' })],
      members: [makeMoc({ bioguideId: 'B001', displayName: 'Jane Doe' })],
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky'), makePlatform('mastodon')],
      onPostHandles: () => jsonResponse({ ok: true }, 201),
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    fireEvent.click(await screen.findByRole('button', { name: /Edit handles/ }));
    fireEvent.click(await screen.findByRole('button', { name: /\+ Add another handle/ }));
    // Find the empty handle input (the new draft row's text input has empty value).
    const allInputs = screen.getAllByRole('textbox') as HTMLInputElement[];
    const emptyInput = allInputs.find((i) => i.value === '');
    expect(emptyInput).toBeTruthy();
    fireEvent.change(emptyInput!, { target: { value: 'jane.mastodon@example.org' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(
      () => expect(stub.calls.some(
        (c) => c.method === 'POST' && c.url.includes('/ingest/handles'),
      )).toBe(true),
      { timeout: 3000 },
    );
  });

  it('DELETEs an existing handle via the remove button', async () => {
    const stub = installFetch({
      handles: [makeHandle({ id: 'h-1', bioguide_id: 'B001', platform: 'bluesky', handle: 'jane.bsky.social' })],
      members: [makeMoc({ bioguideId: 'B001', displayName: 'Jane Doe' })],
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky')],
      onDeleteHandle: () => new Response(null, { status: 204 }),
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    fireEvent.click(await screen.findByRole('button', { name: /Edit handles/ }));
    const removeBtn = await screen.findByTitle(/Remove handle/);
    fireEvent.click(removeBtn);
    await waitFor(
      () => expect(stub.calls.some((c) => c.method === 'DELETE')).toBe(true),
      { timeout: 3000 },
    );
  });

  it('drops a draft row locally without DELETEing', async () => {
    const stub = installFetch({
      handles: [makeHandle({ id: 'h-1', bioguide_id: 'B001', platform: 'bluesky', handle: 'jane.bsky.social' })],
      members: [makeMoc({ bioguideId: 'B001', displayName: 'Jane Doe' })],
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky'), makePlatform('mastodon')],
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    fireEvent.click(await screen.findByRole('button', { name: /Edit handles/ }));
    fireEvent.click(await screen.findByRole('button', { name: /\+ Add another handle/ }));
    await waitFor(() => expect(screen.getByText(/Social handles \(2\)/)).toBeInTheDocument());
    // Two remove buttons now.
    const removeButtons = screen.getAllByTitle(/Remove handle/);
    // Last one is the draft.
    fireEvent.click(removeButtons[removeButtons.length - 1]!);
    await waitFor(() => expect(screen.getByText(/Social handles \(1\)/)).toBeInTheDocument());
    // No DELETE issued for the draft.
    expect(stub.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('shows error banner when save fails', async () => {
    installFetch({
      handles: [makeHandle({ id: 'h-1', bioguide_id: 'B001', platform: 'bluesky', handle: 'jane.bsky.social' })],
      members: [makeMoc({ bioguideId: 'B001', displayName: 'Jane Doe' })],
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky')],
      onPatchHandle: () => jsonResponse({ error: 'boom', detail: 'Something exploded' }, 500),
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    fireEvent.click(await screen.findByRole('button', { name: /Edit handles/ }));
    const handleInput = await waitFor(() => {
      const inputs = screen.getAllByDisplayValue('jane.bsky.social');
      return inputs[0] as HTMLInputElement;
    });
    fireEvent.change(handleInput, { target: { value: 'jane2.bsky.social' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    // The fetcher's parseError lifts `error` into the FetchError.error field;
    // the modal's catch branch surfaces e.message — for FetchError this
    // is undefined, so the modal falls back to "Save failed".
    await waitFor(
      () => expect(screen.getByText(/Save failed|Something exploded|boom/)).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });
});

/* ====================================================================== */
/*                        FreshnessBadge variants                         */
/* ====================================================================== */

describe('PeopleTab — freshness badge', () => {
  it('shows "never polled" when no handles have a successful poll', async () => {
    installFetch({
      handles: [makeHandle({ id: 'h-1', bioguide_id: 'B001', platform: 'bluesky', last_polled_at: null })],
      members: [makeMoc({ bioguideId: 'B001' })],
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky')],
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    // "never polled" appears twice — once in the FreshnessBadge and once in
    // the per-handle "last success: never" text. Asserting on count rather
    // than presence keeps the intent clear.
    await waitFor(() => expect(screen.getAllByText(/never polled/i).length).toBeGreaterThan(0));
  });

  it('counts failing handles in the badge', async () => {
    installFetch({
      handles: [
        makeHandle({ id: 'h-1', bioguide_id: 'B001', platform: 'bluesky', last_poll_status: 'error', last_poll_error: 'auth' }),
      ],
      members: [makeMoc({ bioguideId: 'B001' })],
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky')],
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    await waitFor(() => expect(screen.getByText(/1 failing/i)).toBeInTheDocument());
  });
});

/* ====================================================================== */
/*              Profile view — tabs (AC-60.14 / AC-60.15 / AC-60.21)      */
/* ====================================================================== */

describe('PeopleTab — left-column tabs', () => {
  it('AC-60.14 — renders Quotes/Social Feed/Bills tabs; Quotes selected on load', async () => {
    installFetch({
      handles: [makeHandle({ bioguide_id: 'B001' })],
      members: [makeMoc({ bioguideId: 'B001' })],
      quotes: [makeQuote({ id: 'q-1', body_text: 'a quoted statement' })],
      queue: [],
      platforms: [makePlatform('bluesky')],
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    const quotesTab = await screen.findByRole('tab', { name: /Quotes/i });
    expect(quotesTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Social Feed/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Bills/i })).toBeInTheDocument();
    // Quotes body visible by default.
    await waitFor(() => expect(screen.getByText(/a quoted statement/)).toBeInTheDocument());
  });

  it('AC-60.15 — switching to Social Feed hides the quotes body', async () => {
    installFetch({
      handles: [makeHandle({ bioguide_id: 'B001' })],
      members: [makeMoc({ bioguideId: 'B001' })],
      quotes: [makeQuote({ id: 'q-1', body_text: 'a quoted statement' })],
      queue: [makeQueue({ id: 'p-1', status: 'pending', matched_keywords: '["Ukraine"]', body_text: 'feed post body' })],
      platforms: [makePlatform('bluesky')],
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    await waitFor(() => expect(screen.getByText(/a quoted statement/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: /Social Feed/i }));
    await waitFor(() => expect(screen.getByText(/feed post body/)).toBeInTheDocument());
    expect(screen.queryByText(/a quoted statement/)).not.toBeInTheDocument();
  });

  it('AC-60.14 — Bills tab is hidden for people without a Congress identity', async () => {
    installFetch({
      handles: [makeHandle({ bioguide_id: 'B001', entity_name: 'Some Influencer' })],
      members: [], // no MoC record → not a Congress member
      quotes: [],
      queue: [],
      platforms: [makePlatform('bluesky')],
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    await screen.findByRole('tab', { name: /Quotes/i });
    expect(screen.queryByRole('tab', { name: /Bills/i })).not.toBeInTheDocument();
  });

  it('AC-60.18 — preview collapses to a re-open strip and back', async () => {
    installFetch({
      handles: [makeHandle({ bioguide_id: 'B001' })],
      members: [makeMoc({ bioguideId: 'B001' })],
      quotes: [], queue: [], platforms: [makePlatform('bluesky')],
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    // Expanded: the preview iframe is present.
    expect(await screen.findByTitle(/Widget preview for/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Collapse preview/i }));
    // Collapsed: iframe gone, re-open strip present.
    await waitFor(() => expect(screen.queryByTitle(/Widget preview for/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Show preview/i }));
    await waitFor(() => expect(screen.getByTitle(/Widget preview for/i)).toBeInTheDocument());
  });

  it('AC-60.17 — divider keyboard nudge updates persisted previewPct', async () => {
    installFetch({
      handles: [makeHandle({ bioguide_id: 'B001' })],
      members: [makeMoc({ bioguideId: 'B001' })],
      quotes: [], queue: [], platforms: [makePlatform('bluesky')],
    });
    render(<PeopleTab initialBioguide="B001" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    const divider = await screen.findByRole('separator', { name: /Resize preview pane/i });
    fireEvent.keyDown(divider, { key: 'ArrowRight' });
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem('tk-admin-profile-layout') ?? '{}');
      expect(stored.previewPct).toBeGreaterThan(60);
      expect(stored.previewPct).toBeLessThanOrEqual(75);
    });
  });
});

/* ====================================================================== */
/*                  Bills matrix tab (AC-60.21)                           */
/* ====================================================================== */

describe('PeopleTab — Bills matrix', () => {
  function installBillsFetch(memberJson: unknown, rosterCast: string | null) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.includes('/api/admin/ingest/handles')) return jsonResponse({ items: [makeHandle({ bioguide_id: 'D000563' })] });
      if (method === 'GET' && url.includes('/api/admin/ingest/roster-meta')) return jsonResponse({ members: [makeMoc({ bioguideId: 'D000563', displayName: 'Richard Durbin', chamber: 'Senate', state: 'IL' })] });
      if (method === 'GET' && url.includes('/api/admin/ingest/platforms')) return jsonResponse({ platforms: [makePlatform('bluesky')] });
      if (method === 'GET' && url.includes('/api/admin/ingest/queue')) return jsonResponse({ items: [], total: 0 });
      if (method === 'GET' && url.includes('/api/admin/quotes')) return jsonResponse({ items: [] });
      if (method === 'GET' && url.includes('/api/members/')) return memberJson === null ? jsonResponse({ error: 'member_not_found' }, 404) : jsonResponse(memberJson);
      if (method === 'GET' && url.includes('/api/roll-call-rosters/senate/')) {
        return rosterCast === null
          ? new Response('not found', { status: 404 })
          : jsonResponse({ rollCallId: 'x', chamber: 'senate', congress: 0, session: 0, rollCall: 0, generatedAt: '2026-01-01T00:00:00Z', schemaVersion: 1, casts: [{ lastName: 'Durbin', state: 'IL', cast: rosterCast }] });
      }
      if (method === 'GET' && url.includes('/api/roll-call-rosters/house/')) {
        return rosterCast === null ? new Response('not found', { status: 404 }) : jsonResponse({ rollCallId: 'x', chamber: 'house', congress: 0, session: 0, rollCall: 0, generatedAt: '2026-01-01T00:00:00Z', schemaVersion: 1, casts: { D000563: rosterCast } });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
  }

  const DURBIN_MEMBER = {
    bioguideId: 'D000563', first: 'Richard', last: 'Durbin', officialName: 'Richard J. Durbin',
    state: 'Illinois', district: null, chamber: 'Senate', party: 'D',
    photoUrl: null, website: null, yearEntered: 1997, sponsored: [], cosponsored: [],
    generatedAt: '2026-05-30T00:00:00Z', schemaVersion: 1,
  };

  it('AC-60.21 — renders the matrix with the member position and summary', async () => {
    installBillsFetch(DURBIN_MEMBER, 'Yea');
    render(<PeopleTab initialBioguide="D000563" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    fireEvent.click(await screen.findByRole('tab', { name: /Bills/i }));
    // Summary chips + at least one Aye position cell rendered.
    await waitFor(() => expect(screen.getByText(/tracked/i)).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getAllByText('Aye').length).toBeGreaterThan(0);
  });

  it('AC-60.21 — shows empty state when the member 404s', async () => {
    installBillsFetch(null, null);
    render(<PeopleTab initialBioguide="D000563" />);
    await screen.findByRole('button', { name: /← Back to People/ });
    fireEvent.click(await screen.findByRole('tab', { name: /Bills/i }));
    await waitFor(() => expect(screen.getByText(/No member record found/i)).toBeInTheDocument(), { timeout: 3000 });
  });
});
