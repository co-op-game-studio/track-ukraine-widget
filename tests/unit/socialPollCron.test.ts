/**
 * runSocialPollCron orchestrator tests.
 *
 * Spec anchors: FR-59 (social ingest infrastructure), ADR-018 (cron staleness
 * window). The cron loops every registered platform, applies a "skip handles
 * polled within (interval - safety_margin)" gate, and delegates per-platform
 * to pollPlatform. Tests cover every observable branch: D1-absent early
 * return, YouTube on-demand registration, the YouTube exclusion from the
 * polling loop, the staleness filter (recent + invalid + null), the empty-
 * handles continue branch, the success accounting path, the per-platform
 * try/catch arm, and persistence of handle-level errors via
 * recordHandlePollFailure.
 *
 * Conventions: in-memory FakeD1 + dependency injection through the ProxyEnv
 * shape only — no vi.mock. Platform behavior is controlled by registering a
 * fake adapter for an unused PlatformSlug, and by stubbing globalThis.fetch
 * for the bluesky/mastodon paths.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runSocialPollCron } from '../../proxy/services/social-poll-cron';
import {
  registerAdapter,
  _resetRegistry,
  listPlatforms,
} from '../../src/ingest/factory';
import { BlueskyAdapter } from '../../src/ingest/adapters/bluesky';
import { MastodonAdapter } from '../../src/ingest/adapters/mastodon';
import type {
  SocialAdapter,
  ResolvedAccount,
  ListAuthorPostsInput,
  ListAuthorPostsResult,
  IngestedPost,
  PlatformSlug,
} from '../../src/ingest/types';
import type {
  ProxyEnv,
  D1Like,
  D1PreparedStatementLike,
  D1ResultLike,
  KVLike,
} from '../../proxy/env';

/* -------------------------------------------------------------------------- */
/*                         In-memory FakeD1 (focused)                         */
/* -------------------------------------------------------------------------- */

/**
 * Minimal D1 fake covering the SQL surface runSocialPollCron actually emits
 * (via ingest-store): listKeywordWatches, listHandles, enqueuePost,
 * updateHandlePollState, recordHandlePollFailure. Patterned after
 * tests/unit/ingestStore.test.ts but trimmed to the few queries we hit.
 */
class FakeD1 implements D1Like {
  tables: Record<string, Record<string, unknown>[]> = {
    mocs_social_handles: [],
    social_post_queue: [],
    social_keyword_watches: [],
    audit_log: [],
    researchers: [],
  };
  /** When set, the next listHandles SELECT throws (for catch-arm coverage). */
  failNextListHandles = false;

  prepare(query: string): D1PreparedStatementLike {
    return new FakeStmt(this, query, []);
  }

  async batch<T>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
    const snapshot = JSON.parse(JSON.stringify(this.tables));
    const out: D1ResultLike<T>[] = [];
    try {
      for (const s of statements) out.push((await s.run()) as D1ResultLike<T>);
      return out;
    } catch (err) {
      this.tables = snapshot;
      return [{ success: false, error: (err as Error).message } as D1ResultLike<T>];
    }
  }

  async exec(): Promise<{ count: number; duration: number }> {
    return { count: 0, duration: 0 };
  }
}

class FakeStmt implements D1PreparedStatementLike {
  constructor(
    private d1: FakeD1,
    private query: string,
    private bindings: unknown[],
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new FakeStmt(this.d1, this.query, [...this.bindings, ...values]);
  }

  async first<T = unknown>(): Promise<T | null> {
    const r = this.execute();
    return ((r.results?.[0] ?? null) as T | null);
  }

  async run(): Promise<D1ResultLike<unknown>> {
    return this.execute();
  }

  async all<T = unknown>(): Promise<D1ResultLike<T>> {
    return this.execute() as D1ResultLike<T>;
  }

  private execute(): D1ResultLike<unknown> {
    const q = this.query.replace(/\s+/g, ' ').trim();

    // Plain INSERT (audit_log, social_post_queue, mocs_social_handles, researchers).
    const insMatch = q.match(/^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s+VALUES/i);
    if (insMatch) {
      const table = insMatch[1]!;
      const cols = insMatch[2]!.split(',').map((c) => c.trim());
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => { row[c] = this.bindings[i] ?? null; });
      this.d1.tables[table] = this.d1.tables[table] ?? [];
      this.d1.tables[table]!.push(row);
      return { success: true, meta: { changes: 1 } };
    }

    // INSERT ... ON CONFLICT DO NOTHING (researchers ensure step in batches).
    const insOnConflictNothing = q.match(
      /^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s+VALUES\s*\(([^)]*)\)\s+ON\s+CONFLICT\s*\(([^)]+)\)\s+DO\s+NOTHING/i,
    );
    if (insOnConflictNothing) {
      // No-op for our purposes — we don't read researchers.
      return { success: true, meta: { changes: 0 } };
    }

    // UPDATE <table> SET ... WHERE id = ? (handle poll state + failure).
    const updMatch = q.match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+id\s*=\s*\?$/i);
    if (updMatch) {
      const table = updMatch[1]!;
      const setClause = updMatch[2]!;
      const parts = setClause.split(',').map((p) => p.trim());
      const id = this.bindings[this.bindings.length - 1] as string;
      const rows = this.d1.tables[table] ?? [];
      const idx = rows.findIndex((r) => r['id'] === id);
      if (idx === -1) return { success: true, meta: { changes: 0 } };
      const row = { ...rows[idx]! };
      let bindIdx = 0;
      for (const part of parts) {
        const [lhs, rhsRaw] = part.split('=').map((s) => s.trim());
        const col = lhs!;
        const rhs = rhsRaw!;
        if (rhs === '?') {
          row[col] = this.bindings[bindIdx] ?? null;
          bindIdx++;
        } else if (/^NULL$/i.test(rhs)) {
          row[col] = null;
        } else if (/^'(.*)'$/.test(rhs)) {
          row[col] = rhs.slice(1, -1);
        } else {
          row[col] = rhs;
        }
      }
      rows[idx] = row;
      return { success: true, meta: { changes: 1 } };
    }

    // SELECT * FROM <table>[ WHERE ...][ ORDER BY ...][ LIMIT ?][ OFFSET ?]
    const selMatch = q.match(
      /^SELECT\s+\*\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+[^?]+?)?(?:\s+LIMIT\s+(\?|\d+))?(?:\s+OFFSET\s+(\?|\d+))?\s*$/i,
    );
    if (selMatch) {
      const table = selMatch[1]!;
      if (table === 'mocs_social_handles' && this.d1.failNextListHandles) {
        this.d1.failNextListHandles = false;
        throw new Error('simulated listHandles failure');
      }
      const whereRaw = selMatch[2];
      const limitTok = selMatch[3];
      const offsetTok = selMatch[4];
      const whereBindings = [...this.bindings];
      let limit: number | undefined;
      let offset = 0;
      if (offsetTok === '?') offset = Number(whereBindings.pop() ?? 0);
      else if (offsetTok) offset = Number(offsetTok);
      if (limitTok === '?') limit = Number(whereBindings.pop() ?? 0);
      else if (limitTok) limit = Number(limitTok);
      const rows = this.d1.tables[table] ?? [];
      const filtered = whereRaw ? this.applyWhere(rows, whereRaw, whereBindings) : rows;
      const sliced = limit !== undefined ? filtered.slice(offset, offset + limit) : filtered;
      return { success: true, results: sliced };
    }

    throw new Error(`unhandled query in fake D1: ${q}`);
  }

  private applyWhere(
    rows: Record<string, unknown>[],
    whereRaw: string,
    bindings: unknown[],
  ): Record<string, unknown>[] {
    const whereClean = whereRaw.replace(/\s+LIMIT\s+\d+\s*$/i, '').trim();
    const parts = whereClean.split(/\s+AND\s+/i);
    let bindIdx = 0;
    const predicates: ((r: Record<string, unknown>) => boolean)[] = [];
    for (const part of parts) {
      const isNullM = part.match(/^(\w+)\s+IS\s+NULL$/i);
      if (isNullM) {
        const col = isNullM[1]!;
        predicates.push((r) => r[col] === null || r[col] === undefined);
        continue;
      }
      const isNotNullM = part.match(/^(\w+)\s+IS\s+NOT\s+NULL$/i);
      if (isNotNullM) {
        const col = isNotNullM[1]!;
        predicates.push((r) => r[col] !== null && r[col] !== undefined);
        continue;
      }
      const eqPlaceholder = part.match(/^(\w+)\s*=\s*\?$/);
      if (eqPlaceholder) {
        const col = eqPlaceholder[1]!;
        const v = bindings[bindIdx];
        bindIdx++;
        predicates.push((r) => r[col] === v);
        continue;
      }
      const eqLiteralStr = part.match(/^(\w+)\s*=\s*'(.*)'$/);
      if (eqLiteralStr) {
        const col = eqLiteralStr[1]!;
        const v = eqLiteralStr[2]!;
        predicates.push((r) => r[col] === v);
        continue;
      }
      const eqLiteralNum = part.match(/^(\w+)\s*=\s*(\d+)$/);
      if (eqLiteralNum) {
        const col = eqLiteralNum[1]!;
        const v = Number(eqLiteralNum[2]!);
        predicates.push((r) => r[col] === v);
        continue;
      }
      throw new Error(`unsupported WHERE in fake D1: ${part}`);
    }
    return rows.filter((r) => predicates.every((p) => p(r)));
  }
}

const noopKv: KVLike = {
  async get() { return null; },
  async put() {},
  async list() { return { keys: [], list_complete: true }; },
  async delete() {},
};

function makeEnv(overrides: Partial<ProxyEnv> = {}): ProxyEnv {
  return {
    CONGRESS_API_KEY: 'k',
    KV_VOTER_INFO: noopKv,
    ENV_NAME: 'test',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*                       Fake adapter for unit-test paths                     */
/* -------------------------------------------------------------------------- */

/**
 * A test-only adapter assigned to the 'twitter' slug — twitter is in the
 * PlatformSlug union but isn't auto-registered by src/ingest/register, so
 * we can register our fake without colliding with the real Bluesky/Mastodon
 * adapters or being skipped (the cron only excludes 'youtube').
 */
class FakeAdapter implements SocialAdapter {
  readonly platform: PlatformSlug;
  /** Posts to return from listAuthorPosts. */
  posts: IngestedPost[] = [];
  /** When set, listAuthorPosts throws this error. */
  throwOnList: Error | null = null;
  callCount = 0;

  constructor(platform: PlatformSlug = 'twitter') {
    this.platform = platform;
  }

  async resolveAccount(handle: string): Promise<ResolvedAccount> {
    return { platformId: 'pid', handle, displayName: handle };
  }

  async listAuthorPosts(_input: ListAuthorPostsInput): Promise<ListAuthorPostsResult> {
    this.callCount++;
    if (this.throwOnList) throw this.throwOnList;
    return { posts: this.posts };
  }

  async fetchPostByUrl(): Promise<IngestedPost> {
    throw new Error('not used');
  }

  matchesUrl(): boolean { return false; }
}

function makePost(overrides: Partial<IngestedPost> = {}): IngestedPost {
  return {
    platform: 'twitter',
    platformPostId: 'tw-1',
    authorHandle: 'someone',
    authorPlatformId: 'pid',
    postedAt: '2026-04-15T12:00:00Z',
    url: 'https://example.com/p/1',
    bodyText: 'Standing with Ukraine.',
    mediaRefs: [],
    rawPayload: {},
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Fixtures                                  */
/* -------------------------------------------------------------------------- */

let d1: FakeD1;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  d1 = new FakeD1();
  // Wipe the global adapter registry so tests start from a known state.
  // The runSocialPollCron import statically imports src/ingest/register
  // which auto-registers Bluesky + Mastodon; we want full control.
  _resetRegistry();
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetRegistry();
});

/** Seed a handle row directly into the fake's table (bypasses upsertHandle's
 *  ON CONFLICT DO UPDATE form which the focused fake doesn't model). */
function seedHandle(overrides: Partial<Record<string, unknown>> = {}): string {
  const id = `id-${(d1.tables.mocs_social_handles!.length + 1).toString().padStart(4, '0')}`;
  d1.tables.mocs_social_handles!.push({
    id,
    bioguide_id: 'D000563',
    entity_name: 'Sen. Test',
    account_category: 'congress',
    platform: 'twitter',
    account_kind: 'official',
    handle: `handle-${id}`,
    platform_id: `pid-${id}`,
    display_name: 'Test',
    avatar_url: null,
    active_from: '2026-01-01',
    active_to: null,
    source: null,
    last_polled_at: null,
    last_seen_post_id: null,
    last_poll_attempted_at: null,
    last_poll_status: null,
    last_poll_error: null,
    last_poll_trace_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  });
  return id;
}

/* -------------------------------------------------------------------------- */
/*                                   Tests                                    */
/* -------------------------------------------------------------------------- */

describe('runSocialPollCron — early return + registration', () => {
  it('returns the no-op shape when D1_VOTER_INFO is absent', async () => {
    const env = makeEnv({ D1_VOTER_INFO: undefined });
    const out = await runSocialPollCron(env);
    expect(out).toEqual({
      platforms: [],
      totalHandles: 0,
      totalNew: 0,
      totalErrors: 0,
    });
  });

  it('registers the YouTube adapter on first call when YOUTUBE_API_KEY is set', async () => {
    const env = makeEnv({
      D1_VOTER_INFO: d1,
      YOUTUBE_API_KEY: 'yt-key',
    });
    expect(listPlatforms()).not.toContain('youtube');
    await runSocialPollCron(env);
    expect(listPlatforms()).toContain('youtube');
  });

  it('does not register YouTube when YOUTUBE_API_KEY is missing', async () => {
    const env = makeEnv({ D1_VOTER_INFO: d1 });
    await runSocialPollCron(env);
    expect(listPlatforms()).not.toContain('youtube');
  });

  it('skips the youtube platform when iterating registered platforms', async () => {
    // Register a fake adapter under the youtube slug — if the cron polled it,
    // callCount would go up. The skip branch keeps it at 0.
    const fakeYouTube = new FakeAdapter('youtube');
    registerAdapter(fakeYouTube);
    seedHandle({ platform: 'youtube', platform_id: 'yt-pid' });
    const env = makeEnv({ D1_VOTER_INFO: d1 });
    const out = await runSocialPollCron(env);
    expect(fakeYouTube.callCount).toBe(0);
    expect(out.platforms).toEqual([]);
  });
});

describe('runSocialPollCron — handle filtering + staleness gate', () => {
  it('returns no platform results when no handles exist for any registered platform', async () => {
    registerAdapter(new BlueskyAdapter());
    registerAdapter(new MastodonAdapter());
    const env = makeEnv({ D1_VOTER_INFO: d1 });
    const out = await runSocialPollCron(env);
    expect(out.platforms).toEqual([]);
    expect(out.totalHandles).toBe(0);
  });

  it('polls a handle that has never been polled (last_polled_at IS NULL branch)', async () => {
    const adapter = new FakeAdapter('twitter');
    registerAdapter(adapter);
    seedHandle();
    const env = makeEnv({ D1_VOTER_INFO: d1 });
    const out = await runSocialPollCron(env);
    expect(adapter.callCount).toBe(1);
    expect(out.totalHandles).toBe(1);
    expect(out.totalNew).toBe(0);
  });

  it('skips a handle polled within the staleness window (recent polledMs > cutoff)', async () => {
    const adapter = new FakeAdapter('twitter');
    registerAdapter(adapter);
    // Hourly default cron → staleness 55min. last_polled_at "now" is well
    // inside the window so the handle gets filtered.
    seedHandle({ last_polled_at: new Date().toISOString() });
    const env = makeEnv({ D1_VOTER_INFO: d1 });
    const out = await runSocialPollCron(env);
    expect(adapter.callCount).toBe(0);
    // The platform contributes nothing to results (handles.length === 0 continue branch).
    expect(out.platforms).toEqual([]);
  });

  it('includes a handle with an unparseable last_polled_at (NaN parse → include)', async () => {
    const adapter = new FakeAdapter('twitter');
    registerAdapter(adapter);
    seedHandle({ last_polled_at: 'this-is-not-a-date' });
    const env = makeEnv({ D1_VOTER_INFO: d1 });
    const out = await runSocialPollCron(env);
    expect(adapter.callCount).toBe(1);
    expect(out.totalHandles).toBe(1);
  });

  it('includes a handle polled long enough ago (polledMs <= cutoff)', async () => {
    const adapter = new FakeAdapter('twitter');
    registerAdapter(adapter);
    // 2h ago is older than the 55-min staleness window → included.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    seedHandle({ last_polled_at: old });
    const env = makeEnv({ D1_VOTER_INFO: d1 });
    const out = await runSocialPollCron(env);
    expect(adapter.callCount).toBe(1);
    expect(out.totalHandles).toBe(1);
  });
});

describe('runSocialPollCron — success accounting + enqueue', () => {
  it('counts new posts when adapter returns posts (totalNew++)', async () => {
    const adapter = new FakeAdapter('twitter');
    adapter.posts = [makePost({ platformPostId: 'p1' })];
    registerAdapter(adapter);
    seedHandle();
    const env = makeEnv({ D1_VOTER_INFO: d1 });
    const out = await runSocialPollCron(env);
    expect(out.totalHandles).toBe(1);
    expect(out.totalNew).toBe(1);
    expect(out.totalErrors).toBe(0);
    expect(out.platforms).toHaveLength(1);
    expect(out.platforms[0]!.platform).toBe('twitter');
    // Side effect: the post lands in social_post_queue.
    expect(d1.tables.social_post_queue).toHaveLength(1);
  });

  it('writes last_polled_at + last_seen_post_id back to the handle', async () => {
    const adapter = new FakeAdapter('twitter');
    adapter.posts = [
      makePost({ platformPostId: 'p1', postedAt: '2026-04-15T12:00:00Z' }),
      makePost({ platformPostId: 'p2', postedAt: '2026-04-15T13:00:00Z' }),
    ];
    registerAdapter(adapter);
    const handleId = seedHandle();
    const env = makeEnv({ D1_VOTER_INFO: d1 });
    await runSocialPollCron(env);
    const row = d1.tables.mocs_social_handles!.find((r) => r['id'] === handleId)!;
    expect(row['last_polled_at']).toMatch(/T/);
    // Newest by postedAt → p2.
    expect(row['last_seen_post_id']).toBe('p2');
    expect(row['last_poll_status']).toBe('ok');
  });
});

describe('runSocialPollCron — error paths', () => {
  it('persists per-handle failure via recordHandlePollFailure when the adapter throws', async () => {
    const adapter = new FakeAdapter('twitter');
    adapter.throwOnList = new Error('rate limited');
    registerAdapter(adapter);
    const handleId = seedHandle();
    const env = makeEnv({ D1_VOTER_INFO: d1 });
    const out = await runSocialPollCron(env);
    // pollPlatform catches inside the for-handle loop → result.errors gets an
    // entry, and the cron walks result.errors to call recordHandlePollFailure.
    expect(out.totalErrors).toBe(1);
    const row = d1.tables.mocs_social_handles!.find((r) => r['id'] === handleId)!;
    expect(row['last_poll_status']).toBe('error');
    expect(row['last_poll_error']).toBe('rate limited');
    expect(row['last_poll_trace_id']).toMatch(/^cron-twitter-/);
  });

  it('catches per-platform failures (listHandles throws) into the platform-error envelope', async () => {
    registerAdapter(new FakeAdapter('twitter'));
    seedHandle();
    d1.failNextListHandles = true;
    const env = makeEnv({ D1_VOTER_INFO: d1 });
    const out = await runSocialPollCron(env);
    // The catch arm pushes a synthetic PollResult with one wildcard error.
    expect(out.totalErrors).toBe(1);
    expect(out.platforms).toHaveLength(1);
    expect(out.platforms[0]!.errors[0]!.handle).toBe('*');
    expect(out.platforms[0]!.errors[0]!.error).toBe('simulated listHandles failure');
  });

  it('serializes non-Error throws to a string in the platform-error envelope', async () => {
    registerAdapter(new FakeAdapter('twitter'));
    seedHandle();
    // Override prepare to throw a non-Error value once for the listHandles call.
    const realPrepare = d1.prepare.bind(d1);
    let armed = true;
    d1.prepare = (q: string) => {
      if (armed && /FROM mocs_social_handles/i.test(q)) {
        armed = false;
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'string-error-not-an-Error-instance';
      }
      return realPrepare(q);
    };
    const env = makeEnv({ D1_VOTER_INFO: d1 });
    const out = await runSocialPollCron(env);
    expect(out.platforms[0]!.errors[0]!.error).toBe('string-error-not-an-Error-instance');
  });
});

describe('runSocialPollCron — keyword integration', () => {
  it('enqueues posts whose body matches an active keyword watch', async () => {
    // Seed an active keyword watch directly into the table.
    d1.tables.social_keyword_watches!.push({
      id: 'kw-1',
      watch_name: 'Ukraine',
      pattern: 'ukraine',
      is_regex: 0,
      notify: 1,
      active: 1,
      created_by: 'researcher@example.com',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });
    const adapter = new FakeAdapter('twitter');
    adapter.posts = [makePost({ bodyText: 'Standing with Ukraine.' })];
    registerAdapter(adapter);
    seedHandle();
    const env = makeEnv({ D1_VOTER_INFO: d1 });
    const out = await runSocialPollCron(env);
    expect(out.platforms[0]!.keywordMatches).toBe(1);
    // The matched keyword is persisted on the queue row.
    expect(d1.tables.social_post_queue).toHaveLength(1);
    expect(d1.tables.social_post_queue![0]!['matched_keywords']).toBe(
      JSON.stringify(['Ukraine']),
    );
  });
});
