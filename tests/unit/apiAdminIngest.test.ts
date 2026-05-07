/**
 * Tests for proxy/routes/api-admin-ingest.ts — admin social ingest API.
 *
 * Covers every sub-route exposed by `handleIngest`:
 *   - GET/POST/PATCH/DELETE /handles
 *   - GET /handle-status (+ ?bioguideId, ?status filter)
 *   - GET/POST/PATCH /queue (+ dedup path)
 *   - GET/POST/PATCH /keywords (+ ReDoS / length / regex pattern guards)
 *   - POST /poll
 *   - POST /poll-handle (success, missing id, 404, staleness skip, rate-limit error)
 *   - POST /fetch-post (success + adapter throws)
 *   - POST /search (success, no_handle, adapter throws, invalid filter_terms)
 *   - GET /platforms (cache hit + ?refresh=true bypass + healthCheck failure)
 *   - POST /seed (success + thrown error)
 *   - POST /resolve-youtube (no key, success, error)
 *   - GET /roster-meta (success, no kv)
 *   - GET /categories
 *   - 404 unknown resource
 *   - 503 when D1 binding is missing
 *
 * Conventions:
 *   - No `vi.mock` for the SUT. The seed + youtube-resolver helpers live in
 *     proxy/services/ingest-seed.ts (dependencies, not SUT) and ARE mocked so
 *     these tests don't have to stand up the upstream world.
 *   - DI everywhere else: fake D1, fake KV, fake adapters via the real
 *     adapter-factory registry (see src/ingest/factory.ts).
 *
 * Traces: FR-59 (social ingest infrastructure) + FR-50 AC-50.7 (trace IDs).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the seed service (dependency, not SUT). The real implementation
// reaches out to congress-legislators + Bluesky public APIs; not what we're
// testing here.
vi.mock('../../proxy/services/ingest-seed', () => ({
  ensureIngestSeeded: vi.fn(),
  resolveYouTubeChannelIds: vi.fn(),
}));

import { handleIngest } from '../../proxy/routes/api-admin-ingest';
import {
  registerAdapter,
  _resetRegistry,
} from '../../src/ingest/factory';
import type {
  SocialAdapter,
  IngestedPost,
  PlatformSlug,
} from '../../src/ingest/types';
import { ensureIngestSeeded, resolveYouTubeChannelIds } from '../../proxy/services/ingest-seed';
import { KV_PREFIXES } from '../../proxy/kv/prefixes';
import type {
  ProxyEnv,
  D1Like,
  D1PreparedStatementLike,
  D1ResultLike,
  KVLike,
} from '../../proxy/env';

/* -------------------------------------------------------------------------- */
/*                              In-memory fake D1                             */
/* -------------------------------------------------------------------------- */
/* Vendored / extended from tests/unit/ingestStore.test.ts so this test file  */
/* doesn't depend on the production SQL surface evolving lock-step.           */

class FakeD1 implements D1Like {
  tables: Record<string, Record<string, unknown>[]> = {
    mocs_social_handles: [],
    social_post_queue: [],
    social_keyword_watches: [],
    audit_log: [],
    researchers: [],
  };
  failNextQueueInsertWithUnique = false;

  prepare(query: string): D1PreparedStatementLike {
    return new FakeStmt(this, query, []);
  }

  async batch<T>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
    const snapshot: typeof this.tables = JSON.parse(JSON.stringify(this.tables));
    const results: D1ResultLike<T>[] = [];
    try {
      for (const s of statements) {
        const r = await s.run();
        results.push(r as D1ResultLike<T>);
      }
      return results;
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
  async run() { return this.execute(); }
  async all<T = unknown>(): Promise<D1ResultLike<T>> {
    return this.execute() as D1ResultLike<T>;
  }

  private execute(): D1ResultLike<unknown> {
    const q = this.query.trim();

    // INSERT ... ON CONFLICT (cols) DO UPDATE SET ... (upsertHandle)
    const upsertMatch = q.match(
      /^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s+VALUES\s*\(([^)]*)\)\s+ON\s+CONFLICT\s*\(([^)]+)\)\s+DO\s+UPDATE\s+SET\s+(.+)$/is,
    );
    if (upsertMatch) {
      const table = upsertMatch[1]!;
      const cols = upsertMatch[2]!.split(',').map((c) => c.trim());
      const conflictCols = upsertMatch[4]!.split(',').map((c) => c.trim());
      const setFields = upsertMatch[5]!.split(',').map((kv) => {
        const [lhs, rhs] = kv.split('=').map((s) => s.trim());
        const ex = rhs!.match(/excluded\.(\w+)/i);
        return { col: lhs!, fromExcluded: ex ? ex[1]! : null };
      });
      const newRow: Record<string, unknown> = {};
      cols.forEach((c, i) => { newRow[c] = this.bindings[i] ?? null; });
      const rows = this.d1.tables[table] ?? (this.d1.tables[table] = []);
      const conflictIdx = rows.findIndex((r) =>
        conflictCols.every((c) => r[c] === newRow[c]),
      );
      if (conflictIdx === -1) {
        rows.push(newRow);
      } else {
        const merged = { ...rows[conflictIdx]! };
        for (const f of setFields) if (f.fromExcluded) merged[f.col] = newRow[f.fromExcluded];
        rows[conflictIdx] = merged;
      }
      return { success: true, meta: { changes: 1 } };
    }

    // INSERT ... ON CONFLICT (col) DO NOTHING (researchers ensure)
    const insOnConflictNothingMatch = q.match(
      /^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s+VALUES\s*\(([^)]*)\)\s+ON\s+CONFLICT\s*\(([^)]+)\)\s+DO\s+NOTHING/is,
    );
    if (insOnConflictNothingMatch) {
      const table = insOnConflictNothingMatch[1]!;
      const cols = insOnConflictNothingMatch[2]!.split(',').map((c) => c.trim());
      const conflictCol = insOnConflictNothingMatch[4]!.trim();
      const newRow: Record<string, unknown> = {};
      cols.forEach((c, i) => { newRow[c] = this.bindings[i] ?? null; });
      const rows = this.d1.tables[table] ?? (this.d1.tables[table] = []);
      const exists = rows.some((r) => r[conflictCol] === newRow[conflictCol]);
      if (!exists) rows.push(newRow);
      return { success: true, meta: { changes: exists ? 0 : 1 } };
    }

    // Plain INSERT INTO <table> (cols) VALUES (...)
    const insMatch = q.match(/^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s+VALUES/i);
    if (insMatch) {
      const table = insMatch[1]!;
      const cols = insMatch[2]!.split(',').map((c) => c.trim());
      if (table === 'social_post_queue' && this.d1.failNextQueueInsertWithUnique) {
        this.d1.failNextQueueInsertWithUnique = false;
        throw new Error('UNIQUE constraint failed: social_post_queue.platform, platform_post_id');
      }
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => { row[c] = this.bindings[i] ?? null; });
      this.d1.tables[table] = this.d1.tables[table] ?? [];
      this.d1.tables[table]!.push(row);
      return { success: true, meta: { changes: 1 } };
    }

    // UPDATE <table> SET ... WHERE id = ?
    const updMatch = q.match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+id\s*=\s*\?/is);
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

    // SELECT COUNT(*) as cnt FROM <table> [WHERE ...]
    const countMatch = q.match(
      /^SELECT\s+COUNT\(\*\)\s+as\s+cnt\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/is,
    );
    if (countMatch) {
      const table = countMatch[1]!;
      const where = countMatch[2];
      const rows = this.d1.tables[table] ?? [];
      const filtered = where ? this.applyWhere(rows, where, this.bindings) : rows;
      return { success: true, results: [{ cnt: filtered.length }] };
    }

    const selMatch = q.match(
      /^SELECT\s+\*\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+[^?]+?)?(?:\s+LIMIT\s+(\?|\d+))?(?:\s+OFFSET\s+(\?|\d+))?\s*$/is,
    );
    if (selMatch) {
      const table = selMatch[1]!;
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
      throw new Error(`unsupported WHERE fragment in fake D1: ${part}`);
    }
    return rows.filter((r) => predicates.every((p) => p(r)));
  }
}

/* -------------------------------------------------------------------------- */
/*                                Fake KV                                     */
/* -------------------------------------------------------------------------- */

class FakeKV implements KVLike {
  store = new Map<string, string>();
  async get(key: string, type?: 'text' | 'json'): Promise<string | null | unknown> {
    const v = this.store.get(key);
    if (v === undefined) return null;
    if (type === 'json') {
      try { return JSON.parse(v); } catch { return null; }
    }
    return v;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async list(opts: { prefix: string; cursor?: string }) {
    void opts.cursor;
    const keys = [...this.store.keys()]
      .filter((k) => k.startsWith(opts.prefix))
      .map((name) => ({ name }));
    return { keys, list_complete: true };
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/* -------------------------------------------------------------------------- */
/*                              Fake adapters                                 */
/* -------------------------------------------------------------------------- */

interface FakeAdapterOpts {
  posts?: IngestedPost[];
  fetchPost?: IngestedPost | (() => Promise<IngestedPost>);
  /** Throw on listAuthorPosts. */
  listThrows?: Error;
  /** Throw on fetchPostByUrl. */
  fetchThrows?: Error;
  /** healthCheck implementation. Omit for "no health check" (always-available). */
  healthCheck?: () => Promise<void>;
  matches?: (u: string) => boolean;
}

function makeAdapter(platform: PlatformSlug, opts: FakeAdapterOpts = {}): SocialAdapter {
  const a: SocialAdapter = {
    platform,
    matchesUrl: opts.matches ?? ((u: string) => u.includes(platform)),
    resolveAccount: async () => ({ platformId: 'pid', handle: 'h', displayName: 'h' }),
    listAuthorPosts: async () => {
      if (opts.listThrows) throw opts.listThrows;
      return { posts: opts.posts ?? [] };
    },
    fetchPostByUrl: async (url: string) => {
      if (opts.fetchThrows) throw opts.fetchThrows;
      if (typeof opts.fetchPost === 'function') return opts.fetchPost();
      return opts.fetchPost ?? ({
        platform,
        platformPostId: 'pid-1',
        authorHandle: 'h',
        authorPlatformId: 'apid',
        postedAt: '2026-05-01T00:00:00Z',
        url,
        bodyText: 'hello',
        mediaRefs: [],
        rawPayload: {},
      } as IngestedPost);
    },
  };
  if (opts.healthCheck) {
    (a as SocialAdapter & { healthCheck: () => Promise<void> }).healthCheck = opts.healthCheck;
  }
  return a;
}

/* -------------------------------------------------------------------------- */
/*                                Helpers                                     */
/* -------------------------------------------------------------------------- */

function makeEnv(opts: {
  d1?: FakeD1 | null;
  kv?: FakeKV | null;
  youtubeKey?: string;
  envName?: string;
  socialPollCron?: string;
} = {}): ProxyEnv {
  const env: Record<string, unknown> = {
    CONGRESS_API_KEY: 'k',
    ENV_NAME: opts.envName ?? 'test',
  };
  if (opts.d1 !== null) env.D1_VOTER_INFO = opts.d1 ?? new FakeD1();
  if (opts.kv !== null) env.KV_VOTER_INFO = opts.kv ?? new FakeKV();
  if (opts.youtubeKey) env.YOUTUBE_API_KEY = opts.youtubeKey;
  if (opts.socialPollCron) env.SOCIAL_POLL_CRON = opts.socialPollCron;
  return env as unknown as ProxyEnv;
}

const CTX = { email: 'curator@example.com', traceId: 'tr_test_0001' };

async function call(
  env: ProxyEnv,
  method: string,
  subpath: string,
  body?: unknown,
): Promise<{ status: number; json: any; trace?: string | null }> {
  const queryIdx = subpath.indexOf('?');
  const subpathOnly = queryIdx >= 0 ? subpath.slice(0, queryIdx) : subpath;
  const init: RequestInit = {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  const req = new Request(`https://worker.example/api/admin/ingest/${subpath}`, init);
  const result = await handleIngest(subpathOnly, req, env, CTX);
  const text = await result.response.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  return {
    status: result.response.status,
    json,
    trace: result.response.headers.get('X-Trace-Id'),
  };
}

/** Seed a handle row directly via the upsert SQL form so we don't have to
 *  wire up the upstream upsertHandle helper through the test. */
function seedHandleRow(
  d1: FakeD1,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  const row = {
    id: overrides['id'] ?? 'hid_' + Math.random().toString(36).slice(2, 10),
    bioguide_id: 'D000563',
    entity_name: 'Sen. Durbin',
    account_category: 'congress',
    platform: 'bluesky',
    account_kind: 'official',
    handle: 'durbin.bsky.social',
    platform_id: 'did:plc:abc',
    display_name: 'Dick Durbin',
    avatar_url: null,
    active_from: '2026-01-01',
    active_to: null,
    source: 'manual',
    last_polled_at: null,
    last_seen_post_id: null,
    last_poll_attempted_at: null,
    last_poll_status: null,
    last_poll_error: null,
    last_poll_trace_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
  d1.tables.mocs_social_handles!.push(row);
  return row;
}

beforeEach(() => {
  _resetRegistry();
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/*                                  /handles                                  */
/* -------------------------------------------------------------------------- */

describe('handleIngest: /handles', () => {
  it('GET returns empty list initially', async () => {
    const env = makeEnv();
    const r = await call(env, 'GET', 'handles');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ items: [] });
    expect(r.trace).toBe(CTX.traceId);
  });

  it('GET filters by bioguideId, platform, includeInactive', async () => {
    const d1 = new FakeD1();
    seedHandleRow(d1, { id: 'a', bioguide_id: 'X1', platform: 'bluesky', platform_id: 'pidA' });
    seedHandleRow(d1, { id: 'b', bioguide_id: 'X2', platform: 'mastodon', platform_id: 'pidB' });
    const env = makeEnv({ d1 });
    const r = await call(env, 'GET', 'handles?bioguideId=X1&platform=bluesky&includeInactive=true');
    expect(r.status).toBe(200);
    expect((r.json as { items: unknown[] }).items).toHaveLength(1);
  });

  it('POST creates a handle (201, returns row)', async () => {
    const env = makeEnv();
    const r = await call(env, 'POST', 'handles', {
      bioguide_id: 'A000370',
      entity_name: 'Rep. X',
      account_category: 'congress',
      platform: 'bluesky',
      handle: 'x.bsky',
      platform_id: 'did:plc:x',
    });
    expect(r.status).toBe(201);
    expect((r.json as { row: { handle: string } }).row.handle).toBe('x.bsky');
  });

  it('PATCH updates a handle by id', async () => {
    const d1 = new FakeD1();
    seedHandleRow(d1, { id: 'h1' });
    const env = makeEnv({ d1 });
    const r = await call(env, 'PATCH', 'handles/h1', { display_name: 'Updated' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ updated: true });
  });

  it('DELETE deactivates a handle', async () => {
    const d1 = new FakeD1();
    seedHandleRow(d1, { id: 'h1' });
    const env = makeEnv({ d1 });
    const r = await call(env, 'DELETE', 'handles/h1');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ deactivated: true });
  });
});

/* -------------------------------------------------------------------------- */
/*                              /handle-status                                */
/* -------------------------------------------------------------------------- */

describe('handleIngest: /handle-status', () => {
  it('returns mapped status records (no filter)', async () => {
    const d1 = new FakeD1();
    seedHandleRow(d1, { id: 'h1', last_poll_status: 'ok' });
    seedHandleRow(d1, { id: 'h2', last_poll_status: 'error', platform_id: 'pid2' });
    const env = makeEnv({ d1 });
    const r = await call(env, 'GET', 'handle-status');
    expect(r.status).toBe(200);
    expect((r.json as { items: unknown[] }).items).toHaveLength(2);
  });

  it('filters by status=error', async () => {
    const d1 = new FakeD1();
    seedHandleRow(d1, { id: 'h1', last_poll_status: 'ok' });
    seedHandleRow(d1, { id: 'h2', last_poll_status: 'error', platform_id: 'pid2' });
    const env = makeEnv({ d1 });
    const r = await call(env, 'GET', 'handle-status?status=error');
    expect(r.status).toBe(200);
    const items = (r.json as { items: Array<{ handle_id: string }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.handle_id).toBe('h2');
  });
});

/* -------------------------------------------------------------------------- */
/*                                  /queue                                    */
/* -------------------------------------------------------------------------- */

describe('handleIngest: /queue', () => {
  it('GET returns paginated result', async () => {
    const env = makeEnv();
    const r = await call(env, 'GET', 'queue?status=pending&platform=bluesky&keywordMatch=true&limit=10&offset=0');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ items: [], total: 0 });
  });

  it('POST enqueues a new post (201, deduped:false)', async () => {
    const env = makeEnv();
    const r = await call(env, 'POST', 'queue', {
      bioguide_id: 'D000563',
      platform: 'bluesky',
      platform_post_id: 'p1',
      author_handle: 'h',
      posted_at: '2026-01-01T00:00:00Z',
      url: 'https://x',
      body_text: 'hello',
    });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ deduped: false });
  });

  it('POST returns existing row + deduped:true on UNIQUE collision', async () => {
    const d1 = new FakeD1();
    // Seed the existing row so findQueueByPlatformPostId returns it.
    d1.tables.social_post_queue!.push({
      id: 'q1',
      bioguide_id: null,
      platform: 'bluesky',
      platform_post_id: 'dupP',
      author_handle: 'h',
      posted_at: '2026-01-01T00:00:00Z',
      url: 'https://x',
      body_text: 'hello',
      media_refs_json: '[]',
      raw_payload_json: '{}',
      ingested_at: '2026-01-01T00:00:00Z',
      status: 'pending',
      matched_keywords: null,
      reviewed_by: null,
      reviewed_at: null,
    });
    d1.failNextQueueInsertWithUnique = true;
    const env = makeEnv({ d1 });
    const r = await call(env, 'POST', 'queue', {
      platform: 'bluesky',
      platform_post_id: 'dupP',
      author_handle: 'h',
      posted_at: '2026-01-01T00:00:00Z',
      url: 'https://x',
      body_text: 'hello',
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ deduped: true });
    expect((r.json as { row: { id: string } }).row.id).toBe('q1');
  });

  it('PATCH updates queue status by id', async () => {
    const d1 = new FakeD1();
    d1.tables.social_post_queue!.push({ id: 'q1', status: 'pending' });
    const env = makeEnv({ d1 });
    const r = await call(env, 'PATCH', 'queue/q1', { status: 'curated' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ updated: true });
  });
});

/* -------------------------------------------------------------------------- */
/*                                /keywords                                   */
/* -------------------------------------------------------------------------- */

describe('handleIngest: /keywords', () => {
  it('GET returns empty initially', async () => {
    const env = makeEnv();
    const r = await call(env, 'GET', 'keywords');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ items: [] });
  });

  it('GET respects ?includeInactive=true', async () => {
    const env = makeEnv();
    const r = await call(env, 'GET', 'keywords?includeInactive=true');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ items: [] });
  });

  it('POST creates a keyword (201) for plain string', async () => {
    const env = makeEnv();
    const r = await call(env, 'POST', 'keywords', {
      watch_name: 'Ukraine',
      pattern: 'ukraine',
      is_regex: false,
      reason: 'add core',
    });
    expect(r.status).toBe(201);
    expect((r.json as { row: { pattern: string } }).row.pattern).toBe('ukraine');
  });

  it('POST creates a regex keyword', async () => {
    const env = makeEnv();
    const r = await call(env, 'POST', 'keywords', {
      watch_name: 'Russia',
      pattern: 'russia|kremlin',
      is_regex: true,
    });
    expect(r.status).toBe(201);
  });

  it('POST rejects empty pattern (400 invalid_pattern)', async () => {
    const env = makeEnv();
    const r = await call(env, 'POST', 'keywords', {
      watch_name: 'x',
      pattern: '',
      is_regex: false,
    });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'invalid_pattern' });
  });

  it('POST rejects pattern over the 200-char cap', async () => {
    const env = makeEnv();
    const r = await call(env, 'POST', 'keywords', {
      watch_name: 'x',
      pattern: 'a'.repeat(201),
      is_regex: false,
    });
    expect(r.status).toBe(400);
    expect((r.json as { detail: string }).detail).toContain('200');
  });

  it('POST rejects invalid regex syntax', async () => {
    const env = makeEnv();
    const r = await call(env, 'POST', 'keywords', {
      watch_name: 'x',
      pattern: '(unclosed',
      is_regex: true,
    });
    expect(r.status).toBe(400);
    expect((r.json as { detail: string }).detail).toMatch(/invalid regex/);
  });

  it('PATCH toggles active by id', async () => {
    const d1 = new FakeD1();
    d1.tables.social_keyword_watches!.push({
      id: 'k1', watch_name: 'Ukraine', pattern: 'u', is_regex: 0, active: 1,
      notify: 1, created_by: 'x', created_at: 'now',
    });
    const env = makeEnv({ d1 });
    const r = await call(env, 'PATCH', 'keywords/k1', { active: false, reason: 'mute' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ updated: true });
  });
});

/* -------------------------------------------------------------------------- */
/*                                  /poll                                     */
/* -------------------------------------------------------------------------- */

describe('handleIngest: /poll', () => {
  it('runs the poll loop for the default platform (bluesky)', async () => {
    const d1 = new FakeD1();
    seedHandleRow(d1, { id: 'h1', platform: 'bluesky' });
    // Seed an active keyword so the bulk-poll kwList map callback runs.
    d1.tables.social_keyword_watches!.push({
      id: 'k1', watch_name: 'Ukraine', pattern: 'ukraine', is_regex: 1, active: 1,
      notify: 1, created_by: 'x', created_at: 'now',
    });
    registerAdapter(makeAdapter('bluesky', {
      posts: [{
        platform: 'bluesky',
        platformPostId: 'p1',
        authorHandle: 'durbin.bsky.social',
        authorPlatformId: 'did:plc:abc',
        postedAt: '2026-05-01T00:00:00Z',
        url: 'https://bsky.app/profile/x/post/p1',
        bodyText: 'standing with ukraine',
        mediaRefs: [],
        rawPayload: {},
      }],
    }));
    const env = makeEnv({ d1 });
    const r = await call(env, 'POST', 'poll', {});
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ platform: 'bluesky', handlesPolled: 1 });
  });

  it('runs the poll loop with explicit platform parameter', async () => {
    const d1 = new FakeD1();
    seedHandleRow(d1, { id: 'h2', platform: 'mastodon', platform_id: 'pid2' });
    registerAdapter(makeAdapter('mastodon'));
    const env = makeEnv({ d1 });
    const r = await call(env, 'POST', 'poll', { platform: 'mastodon' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ platform: 'mastodon' });
  });
});

/* -------------------------------------------------------------------------- */
/*                                /poll-handle                                */
/* -------------------------------------------------------------------------- */

describe('handleIngest: /poll-handle', () => {
  it('returns 400 when handle_id is missing', async () => {
    const env = makeEnv();
    const r = await call(env, 'POST', 'poll-handle', {});
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'missing_handle_id' });
  });

  it('returns 404 when handle not found', async () => {
    const env = makeEnv();
    const r = await call(env, 'POST', 'poll-handle', { handle_id: 'no-such' });
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ error: 'handle_not_found' });
  });

  it('skips when polled inside the staleness window (no force)', async () => {
    const d1 = new FakeD1();
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5min ago
    seedHandleRow(d1, { id: 'h1', platform: 'bluesky', last_polled_at: recent });
    // Default cron = hourly → staleness 55min, so 5min < 55min triggers skip.
    registerAdapter(makeAdapter('bluesky'));
    const env = makeEnv({ d1 });
    const r = await call(env, 'POST', 'poll-handle', { handle_id: 'h1' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ skipped: true });
    expect((r.json as { skipReason: string }).skipReason).toMatch(/gate/);
  });

  it('force=true bypasses staleness gate and polls', async () => {
    const d1 = new FakeD1();
    const recent = new Date(Date.now() - 60 * 1000).toISOString();
    seedHandleRow(d1, { id: 'h1', platform: 'bluesky', last_polled_at: recent });
    registerAdapter(makeAdapter('bluesky'));
    const env = makeEnv({ d1 });
    const r = await call(env, 'POST', 'poll-handle', { handle_id: 'h1', force: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ skipped: false });
  });

  it('runs poll path when never polled before (last_polled_at=null)', async () => {
    const d1 = new FakeD1();
    seedHandleRow(d1, { id: 'h1', platform: 'bluesky' });
    registerAdapter(makeAdapter('bluesky'));
    const env = makeEnv({ d1 });
    const r = await call(env, 'POST', 'poll-handle', { handle_id: 'h1' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      skipped: false,
      newPosts: 0,
      duplicates: 0,
      keywordMatches: 0,
      error: null,
    });
  });

  it('exercises enqueue + keyword mapping callback paths', async () => {
    const d1 = new FakeD1();
    seedHandleRow(d1, { id: 'h1', platform: 'bluesky' });
    // Seed an active keyword so kwList.map runs over a real row.
    d1.tables.social_keyword_watches!.push({
      id: 'k1', watch_name: 'Ukraine', pattern: 'ukraine', is_regex: 0, active: 1,
      notify: 1, created_by: 'x', created_at: 'now',
    });
    registerAdapter(makeAdapter('bluesky', {
      posts: [
        {
          platform: 'bluesky', platformPostId: 'newp',
          authorHandle: 'durbin.bsky.social', authorPlatformId: 'did:plc:abc',
          postedAt: '2026-05-01T00:00:00Z', url: 'https://x',
          bodyText: 'standing with ukraine', mediaRefs: [], rawPayload: {},
        },
      ],
    }));
    const env = makeEnv({ d1 });
    const r = await call(env, 'POST', 'poll-handle', { handle_id: 'h1' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ skipped: false, newPosts: 1, keywordMatches: 1 });
  });

  it('counts duplicates when enqueuePost returns null (UNIQUE collision)', async () => {
    const d1 = new FakeD1();
    seedHandleRow(d1, { id: 'h1', platform: 'bluesky' });
    d1.failNextQueueInsertWithUnique = true;
    registerAdapter(makeAdapter('bluesky', {
      posts: [{
        platform: 'bluesky', platformPostId: 'dup',
        authorHandle: 'h', authorPlatformId: 'apid',
        postedAt: '2026-05-01T00:00:00Z', url: 'https://x',
        bodyText: 'plain', mediaRefs: [], rawPayload: {},
      }],
    }));
    const env = makeEnv({ d1 });
    const r = await call(env, 'POST', 'poll-handle', { handle_id: 'h1' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ skipped: false, duplicates: 1, newPosts: 0 });
  });

  it('records error + parses transient rate-limit signal from message', async () => {
    const d1 = new FakeD1();
    seedHandleRow(d1, { id: 'h1', platform: 'bluesky' });
    registerAdapter(makeAdapter('bluesky', {
      listThrows: new Error(
        'bluesky rate-limited (429, transient): too many — retry-after: 60',
      ),
    }));
    const env = makeEnv({ d1 });
    const r = await call(env, 'POST', 'poll-handle', { handle_id: 'h1' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      rateLimited: true,
      rateLimitKind: 'transient',
      retryAfterSec: 60,
    });
    expect((r.json as { error: string }).error).toMatch(/rate-limited/);
  });

  it('records non-rate-limit error with rateLimited=false', async () => {
    const d1 = new FakeD1();
    seedHandleRow(d1, { id: 'h1', platform: 'bluesky' });
    registerAdapter(makeAdapter('bluesky', {
      listThrows: new Error('upstream broke'),
    }));
    const env = makeEnv({ d1 });
    const r = await call(env, 'POST', 'poll-handle', { handle_id: 'h1' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      rateLimited: false,
      rateLimitKind: null,
      retryAfterSec: null,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                                /fetch-post                                 */
/* -------------------------------------------------------------------------- */

describe('handleIngest: /fetch-post', () => {
  it('returns 400 when url is missing', async () => {
    const env = makeEnv();
    const r = await call(env, 'POST', 'fetch-post', {});
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'missing_url' });
  });

  it('fetches a post and matches author to a known handle', async () => {
    const d1 = new FakeD1();
    seedHandleRow(d1, {
      id: 'h1',
      platform: 'bluesky',
      platform_id: 'did:plc:abc',
      handle: 'durbin.bsky.social',
    });
    registerAdapter(makeAdapter('bluesky', {
      matches: (u) => u.includes('bsky.app'),
      fetchPost: {
        platform: 'bluesky',
        platformPostId: 'pid-1',
        authorHandle: 'durbin.bsky.social',
        authorPlatformId: 'did:plc:abc',
        postedAt: '2026-05-01T00:00:00Z',
        url: 'https://bsky.app/profile/x/post/p1',
        bodyText: 'hi',
        mediaRefs: [],
        rawPayload: {},
      },
    }));
    const env = makeEnv({ d1 });
    const r = await call(env, 'POST', 'fetch-post', { url: 'https://bsky.app/profile/x/post/p1' });
    expect(r.status).toBe(200);
    expect((r.json as { moc: { bioguideId: string } | null }).moc?.bioguideId).toBe('D000563');
  });

  it('returns null moc when author is not in roster', async () => {
    registerAdapter(makeAdapter('bluesky', {
      matches: (u) => u.includes('bsky.app'),
    }));
    const env = makeEnv();
    const r = await call(env, 'POST', 'fetch-post', { url: 'https://bsky.app/profile/x/post/p1' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ moc: null });
  });

  it('returns 422 when adapter throws (fetch_failed envelope)', async () => {
    registerAdapter(makeAdapter('bluesky', {
      matches: (u) => u.includes('bsky.app'),
      fetchThrows: new Error('not_found upstream'),
    }));
    const env = makeEnv();
    const r = await call(env, 'POST', 'fetch-post', { url: 'https://bsky.app/profile/x/post/p1' });
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ error: 'fetch_failed' });
  });

  it('returns 422 when no adapter recognises the URL', async () => {
    const env = makeEnv();
    const r = await call(env, 'POST', 'fetch-post', { url: 'https://nope.example/' });
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ error: 'fetch_failed' });
  });
});

/* -------------------------------------------------------------------------- */
/*                                  /search                                   */
/* -------------------------------------------------------------------------- */

describe('handleIngest: /search', () => {
  it('returns no_handle for platforms with no roster entry', async () => {
    registerAdapter(makeAdapter('bluesky'));
    const env = makeEnv();
    const r = await call(env, 'POST', 'search', {
      bioguide_id: 'X1',
      platforms: ['bluesky'],
      max_posts: 5,
    });
    expect(r.status).toBe(200);
    const results = (r.json as { results: Record<string, { error?: string }> }).results;
    expect(results.bluesky?.error).toBe('no_handle');
  });

  it('returns posts for a matched handle', async () => {
    const d1 = new FakeD1();
    seedHandleRow(d1, { id: 'h1', platform: 'bluesky' });
    registerAdapter(makeAdapter('bluesky', {
      posts: [{
        platform: 'bluesky',
        platformPostId: 'p1',
        authorHandle: 'durbin.bsky.social',
        authorPlatformId: 'did:plc:abc',
        postedAt: '2026-05-01T00:00:00Z',
        url: 'https://x',
        bodyText: 'standing with ukraine',
        mediaRefs: [],
        rawPayload: {},
      }],
    }));
    const env = makeEnv({ d1 });
    const r = await call(env, 'POST', 'search', { bioguide_id: 'D000563', platforms: ['bluesky'] });
    expect(r.status).toBe(200);
    const results = (r.json as { results: Record<string, { posts: unknown[] }> }).results;
    expect(results.bluesky?.posts).toHaveLength(1);
  });

  it('applies filter_terms regex client-side', async () => {
    const d1 = new FakeD1();
    seedHandleRow(d1, { id: 'h1', platform: 'bluesky' });
    registerAdapter(makeAdapter('bluesky', {
      posts: [
        {
          platform: 'bluesky', platformPostId: 'a',
          authorHandle: 'h', authorPlatformId: 'apid',
          postedAt: '2026-05-01T00:00:00Z',
          url: 'u', bodyText: 'about ukraine', mediaRefs: [], rawPayload: {},
        },
        {
          platform: 'bluesky', platformPostId: 'b',
          authorHandle: 'h', authorPlatformId: 'apid',
          postedAt: '2026-05-01T00:00:00Z',
          url: 'u', bodyText: 'about taxes', mediaRefs: [], rawPayload: {},
        },
      ],
    }));
    const env = makeEnv({ d1 });
    const r = await call(env, 'POST', 'search', {
      bioguide_id: 'D000563',
      platforms: ['bluesky'],
      filter_terms: 'ukraine',
    });
    expect(r.status).toBe(200);
    const posts = (r.json as { results: Record<string, { posts: unknown[] }> }).results.bluesky!.posts;
    expect(posts).toHaveLength(1);
  });

  it('returns 400 invalid_filter_terms when filter_terms is invalid regex', async () => {
    const env = makeEnv();
    const r = await call(env, 'POST', 'search', {
      bioguide_id: 'X',
      platforms: ['bluesky'],
      filter_terms: '(unclosed',
    });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'invalid_filter_terms' });
  });

  it('records adapter error in per-platform results without aborting', async () => {
    const d1 = new FakeD1();
    seedHandleRow(d1, { id: 'h1', platform: 'bluesky' });
    registerAdapter(makeAdapter('bluesky', {
      listThrows: new Error('upstream-broke'),
    }));
    const env = makeEnv({ d1 });
    const r = await call(env, 'POST', 'search', { bioguide_id: 'D000563', platforms: ['bluesky'] });
    expect(r.status).toBe(200);
    expect((r.json as { results: Record<string, { error?: string }> }).results.bluesky?.error).toBe('upstream-broke');
  });

  it('uses listPlatforms() default when platforms array omitted', async () => {
    registerAdapter(makeAdapter('bluesky'));
    const env = makeEnv();
    const r = await call(env, 'POST', 'search', { bioguide_id: 'X' });
    expect(r.status).toBe(200);
    const results = (r.json as { results: Record<string, unknown> }).results;
    expect(Object.keys(results)).toContain('bluesky');
  });
});

/* -------------------------------------------------------------------------- */
/*                                /platforms                                  */
/* -------------------------------------------------------------------------- */

describe('handleIngest: /platforms', () => {
  it('returns liveness for all registered adapters (no health check = available)', async () => {
    registerAdapter(makeAdapter('bluesky'));
    registerAdapter(makeAdapter('mastodon'));
    const env = makeEnv();
    const r = await call(env, 'GET', 'platforms?refresh=true');
    expect(r.status).toBe(200);
    const platforms = (r.json as { platforms: Array<{ slug: string; available: boolean; bulkEligible: boolean }> }).platforms;
    expect(platforms).toHaveLength(2);
    expect(platforms.every((p) => p.available)).toBe(true);
    expect(platforms.find((p) => p.slug === 'bluesky')?.bulkEligible).toBe(true);
  });

  it('marks adapter as unavailable when healthCheck throws', async () => {
    registerAdapter(makeAdapter('youtube', {
      healthCheck: async () => { throw new Error('bad-key'); },
    }));
    const env = makeEnv();
    const r = await call(env, 'GET', 'platforms?refresh=true');
    expect(r.status).toBe(200);
    const platforms = (r.json as { platforms: Array<{ slug: string; available: boolean; error?: string; bulkEligible: boolean }> }).platforms;
    const yt = platforms.find((p) => p.slug === 'youtube')!;
    expect(yt.available).toBe(false);
    expect(yt.error).toContain('bad-key');
    expect(yt.bulkEligible).toBe(false);
  });

  it('runs a successful healthCheck path', async () => {
    registerAdapter(makeAdapter('youtube', { healthCheck: async () => { /* ok */ } }));
    const env = makeEnv();
    const r = await call(env, 'GET', 'platforms?refresh=true');
    expect(r.status).toBe(200);
    const platforms = (r.json as { platforms: Array<{ slug: string; available: boolean }> }).platforms;
    expect(platforms.find((p) => p.slug === 'youtube')?.available).toBe(true);
  });

  it('serves cached liveness when refresh is omitted (second call hits cache)', async () => {
    let calls = 0;
    registerAdapter(makeAdapter('youtube', {
      healthCheck: async () => { calls++; },
    }));
    const env = makeEnv();
    // First call (?refresh=true) seeds the cache.
    await call(env, 'GET', 'platforms?refresh=true');
    expect(calls).toBe(1);
    // Second call without refresh should hit the cache.
    await call(env, 'GET', 'platforms');
    expect(calls).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  /seed                                     */
/* -------------------------------------------------------------------------- */

describe('handleIngest: /seed', () => {
  it('returns 200 with the seed result on success', async () => {
    const seedResult = {
      roster: { membersScanned: 5, handlesUpserted: 5, mastodon: 1, bluesky: 4 },
      keywords: { seeded: 12 },
      bills: { stubsInserted: 0, alreadyPresent: 0 },
      skipped: false,
    };
    (ensureIngestSeeded as unknown as { mockResolvedValueOnce: (v: unknown) => void })
      .mockResolvedValueOnce(seedResult);
    const env = makeEnv();
    const r = await call(env, 'POST', 'seed', {});
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ skipped: false });
  });

  it('returns 500 seed_failed when ensureIngestSeeded throws', async () => {
    (ensureIngestSeeded as unknown as { mockRejectedValueOnce: (e: unknown) => void })
      .mockRejectedValueOnce(new Error('boom'));
    const env = makeEnv();
    const r = await call(env, 'POST', 'seed', {});
    expect(r.status).toBe(500);
    expect(r.json).toMatchObject({ error: 'seed_failed', detail: 'boom' });
  });
});

/* -------------------------------------------------------------------------- */
/*                              /resolve-youtube                              */
/* -------------------------------------------------------------------------- */

describe('handleIngest: /resolve-youtube', () => {
  it('returns 503 when YOUTUBE_API_KEY is unset', async () => {
    const env = makeEnv();
    const r = await call(env, 'POST', 'resolve-youtube', {});
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ error: 'no_youtube_api_key' });
  });

  it('returns 200 with resolved count on success', async () => {
    (resolveYouTubeChannelIds as unknown as { mockResolvedValueOnce: (v: unknown) => void })
      .mockResolvedValueOnce(7);
    const env = makeEnv({ youtubeKey: 'yt-key' });
    const r = await call(env, 'POST', 'resolve-youtube', {});
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ resolved: 7 });
  });

  it('returns 500 resolve_failed when resolver throws', async () => {
    (resolveYouTubeChannelIds as unknown as { mockRejectedValueOnce: (e: unknown) => void })
      .mockRejectedValueOnce(new Error('quota exceeded'));
    const env = makeEnv({ youtubeKey: 'yt-key' });
    const r = await call(env, 'POST', 'resolve-youtube', {});
    expect(r.status).toBe(500);
    expect(r.json).toMatchObject({ error: 'resolve_failed', detail: 'quota exceeded' });
  });
});

/* -------------------------------------------------------------------------- */
/*                              /roster-meta                                  */
/* -------------------------------------------------------------------------- */

describe('handleIngest: /roster-meta', () => {
  it('returns 503 when KV binding is missing', async () => {
    const env = makeEnv({ kv: null });
    const r = await call(env, 'GET', 'roster-meta');
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ error: 'kv_unavailable' });
  });

  it('aggregates name-index shards into members[], dedupes by bioguideId, strips searchKeys', async () => {
    const kv = new FakeKV();
    await kv.put(KV_PREFIXES.nameIndex + 'a', JSON.stringify({
      entries: [
        { bioguideId: 'A1', displayName: 'Alice', first: 'A', last: 'L', state: 'IL', chamber: 'Senate', party: 'D', searchKeys: ['alice'] },
      ],
    }));
    await kv.put(KV_PREFIXES.nameIndex + 'b', JSON.stringify({
      entries: [
        { bioguideId: 'A1', displayName: 'Alice DUPE', first: 'A', last: 'L', state: 'IL', chamber: 'Senate', party: 'D', searchKeys: ['alice'] },
        { bioguideId: 'B1', displayName: 'Bob', first: 'B', last: 'O', state: 'CA', chamber: 'House', party: 'R', searchKeys: ['bob'] },
      ],
    }));
    const env = makeEnv({ kv });
    const r = await call(env, 'GET', 'roster-meta');
    expect(r.status).toBe(200);
    const members = (r.json as { members: Array<{ bioguideId: string; searchKeys: string[] }> }).members;
    expect(members.map((m) => m.bioguideId).sort()).toEqual(['A1', 'B1']);
    expect(members.every((m) => m.searchKeys.length === 0)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*                              /categories                                   */
/* -------------------------------------------------------------------------- */

describe('handleIngest: /categories', () => {
  it('returns the static category list', async () => {
    const env = makeEnv();
    const r = await call(env, 'GET', 'categories');
    expect(r.status).toBe(200);
    const cats = (r.json as { categories: Array<{ id: string; label: string }> }).categories;
    expect(cats.length).toBeGreaterThanOrEqual(9);
    expect(cats.find((c) => c.id === 'congress')).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/*                              top-level dispatch                            */
/* -------------------------------------------------------------------------- */

describe('handleIngest: dispatch + env guards', () => {
  it('returns 503 when D1 binding is missing', async () => {
    const env = makeEnv({ d1: null });
    const r = await call(env, 'GET', 'handles');
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ error: 'd1_unavailable' });
  });

  it('returns 404 for unknown resource', async () => {
    const env = makeEnv();
    const r = await call(env, 'GET', 'flibberty');
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ error: 'not_found' });
  });

  it('returns 404 when method does not match a resource branch', async () => {
    const env = makeEnv();
    // PATCH on /handles without an id falls through every branch.
    const r = await call(env, 'PATCH', 'handles', { handle: 'x' });
    expect(r.status).toBe(404);
  });

  it('staleness uses env.SOCIAL_POLL_CRON when set (every 15min → 10min gate)', async () => {
    const d1 = new FakeD1();
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5min ago
    seedHandleRow(d1, { id: 'h1', platform: 'bluesky', last_polled_at: recent });
    registerAdapter(makeAdapter('bluesky'));
    // 15min cron → 10min gate; 5min < 10min → skipped.
    const env = makeEnv({ d1, socialPollCron: '*/15 * * * *' });
    const r = await call(env, 'POST', 'poll-handle', { handle_id: 'h1' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ skipped: true });
  });
});
