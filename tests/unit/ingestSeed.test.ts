/**
 * Tests for proxy/services/ingest-seed.ts.
 *
 * Covers the orchestration paths of `ensureIngestSeeded` end-to-end:
 *   - skip path when D1/KV bindings are absent
 *   - roster seed (KV name-index + Congress.gov socials → mocs_social_handles batches)
 *   - Bluesky starter-pack seed
 *   - keyword seed (idempotent — second run is a no-op)
 *   - Ukraine bill stubs (insert vs already-present)
 *   - YouTube channel ID resolver (forHandle / forUsername / no-resolution)
 *
 * Mocks:
 *   - globalThis.fetch is keyed by URL pattern via vi.spyOn (mirrors
 *     importBillCongressionalRecord.test.ts style).
 *   - D1 is the same in-memory FakeD1 pattern as adminStore.test.ts but
 *     trimmed to the SQL surface ingest-seed actually issues
 *     (mocs_social_handles / bills / social_keyword_watches / researchers /
 *     audit_log + plain SELECT/INSERT/UPDATE/DELETE).
 *   - KV is a tiny inline map implementing KVLike.
 *
 * Traces: FR-59 (social ingest infrastructure).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ensureIngestSeeded, resolveYouTubeChannelIds } from '../../proxy/services/ingest-seed';
import type {
  D1Like,
  D1PreparedStatementLike,
  D1ResultLike,
  KVLike,
  ProxyEnv,
} from '../../proxy/env';

/* -------------------------------------------------------------------------- */
/*                              In-memory fake D1                             */
/* -------------------------------------------------------------------------- */

class FakeD1 implements D1Like {
  tables: Record<string, Record<string, unknown>[]> = {
    mocs_social_handles: [],
    bills: [],
    social_keyword_watches: [],
    researchers: [],
    audit_log: [],
  };
  /** Optional hook to force a prepare/run failure on a query matching a regex. */
  failOn: RegExp | null = null;

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
      throw err;
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
    if (this.d1.failOn && this.d1.failOn.test(this.query)) {
      throw new Error('forced_failure');
    }
    const q = this.query.trim();

    // ---- INSERT ----
    const insMatch = q.match(/^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s+VALUES/i);
    if (insMatch) {
      const table = insMatch[1]!;
      const cols = insMatch[2]!.split(',').map((c) => c.trim());
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => { row[c] = this.bindings[i] ?? null; });
      // Honor the ON CONFLICT … DO NOTHING shape used by ingest-seed.
      const conflictMatch = q.match(/ON\s+CONFLICT\s*\(([^)]+)\)\s+DO\s+NOTHING/i);
      if (conflictMatch) {
        const cKeys = conflictMatch[1]!.split(',').map((c) => c.trim());
        const dupe = this.d1.tables[table]!.find((r) =>
          cKeys.every((k) => r[k] === row[k]),
        );
        if (dupe) return { success: true, meta: { changes: 0 } };
      }
      this.d1.tables[table] = this.d1.tables[table] ?? [];
      this.d1.tables[table]!.push(row);
      return { success: true, meta: { changes: 1 } };
    }

    // ---- UPDATE … WHERE id = ? ----
    const updMatch = q.match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+id\s*=\s*\?/is);
    if (updMatch) {
      const table = updMatch[1]!;
      const setClause = updMatch[2]!;
      const fields = setClause.split(',').map((f) => f.split('=')[0]!.trim());
      const id = this.bindings[this.bindings.length - 1] as string;
      const rows = this.d1.tables[table] ?? [];
      const idx = rows.findIndex((r) => r['id'] === id);
      if (idx === -1) return { success: true, meta: { changes: 0 } };
      const row = { ...rows[idx]! };
      fields.forEach((f, i) => { row[f] = this.bindings[i] ?? null; });
      rows[idx] = row;
      return { success: true, meta: { changes: 1 } };
    }

    // ---- SELECT id, bioguide_id, platform, handle, platform_id FROM mocs_social_handles WHERE active_to IS NULL AND account_category = 'congress'
    if (/SELECT\s+id,\s*bioguide_id,\s*platform,\s*handle,\s*platform_id\s+FROM\s+mocs_social_handles/i.test(q)) {
      const rows = (this.d1.tables.mocs_social_handles ?? []).filter(
        (r) => r['active_to'] == null && r['account_category'] === 'congress',
      );
      return { success: true, results: rows };
    }

    // ---- SELECT id, bioguide_id, handle FROM mocs_social_handles WHERE platform = 'bluesky' AND active_to IS NULL
    if (/SELECT\s+id,\s*bioguide_id,\s*handle\s+FROM\s+mocs_social_handles\s+WHERE\s+platform\s*=\s*'bluesky'/i.test(q)) {
      const rows = (this.d1.tables.mocs_social_handles ?? []).filter(
        (r) => r['platform'] === 'bluesky' && r['active_to'] == null,
      );
      return { success: true, results: rows };
    }

    // ---- SELECT bill_id FROM bills
    if (/^SELECT\s+bill_id\s+FROM\s+bills\s*$/i.test(q)) {
      return { success: true, results: this.d1.tables.bills?.map((r) => ({ bill_id: r['bill_id'] })) ?? [] };
    }

    // ---- SELECT id, handle, platform_id FROM mocs_social_handles WHERE platform = 'youtube' AND active_to IS NULL AND platform_id NOT LIKE 'UC%' LIMIT 50
    if (/SELECT\s+id,\s*handle,\s*platform_id\s+FROM\s+mocs_social_handles\s+WHERE\s+platform\s*=\s*'youtube'/i.test(q)) {
      const rows = (this.d1.tables.mocs_social_handles ?? []).filter(
        (r) =>
          r['platform'] === 'youtube' &&
          r['active_to'] == null &&
          !String(r['platform_id'] ?? '').startsWith('UC'),
      ).slice(0, 50);
      return { success: true, results: rows };
    }

    // ---- listKeywordWatches: SELECT * FROM social_keyword_watches WHERE active = 1 ORDER BY watch_name
    if (/SELECT\s+\*\s+FROM\s+social_keyword_watches/i.test(q)) {
      return { success: true, results: this.d1.tables.social_keyword_watches ?? [] };
    }

    // Generic SELECT * FROM <table> ORDER BY ... LIMIT? — not used here, fall through.
    throw new Error(`unhandled query in fake D1: ${q}`);
  }
}

/* -------------------------------------------------------------------------- */
/*                              In-memory KVLike                              */
/* -------------------------------------------------------------------------- */

function makeKv(): KVLike & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    _store: store,
    async get(key: string, _type?: 'text' | 'json') {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async list({ prefix }: { prefix: string; cursor?: string }) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
      return { keys: keys.map((name) => ({ name })), list_complete: true };
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                              Fixtures + helpers                            */
/* -------------------------------------------------------------------------- */

/** Seed a single KV name-index shard for the letter 'd' with one member. */
function seedNameShard(kv: KVLike & { _store: Map<string, string> }, letter: string, entries: unknown[]) {
  kv._store.set(`name-index:v1:${letter}`, JSON.stringify({ entries }));
}

/** Build a minimal ProxyEnv pointing at the supplied D1 + KV. */
function makeEnv(d1: FakeD1, kv: KVLike, opts?: { youtubeKey?: string }): ProxyEnv {
  return {
    CONGRESS_API_KEY: 'TEST_KEY',
    KV_VOTER_INFO: kv,
    D1_VOTER_INFO: d1 as unknown as D1Like,
    YOUTUBE_API_KEY: opts?.youtubeKey,
    ENV_NAME: 'test',
  } as unknown as ProxyEnv;
}

/* ---------- Canned-fetch installer ---------- */

interface FetchCase {
  match: (url: string) => boolean;
  respond: (url: string) => unknown;
  status?: number;
}

function installFetch(cases: FetchCase[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    for (const c of cases) {
      if (c.match(url)) {
        const status = c.status ?? 200;
        return new Response(JSON.stringify(c.respond(url)), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    // Default: empty 200 — mirrors "no items" so loops terminate cleanly.
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

/* -------------------------------------------------------------------------- */
/*                                    Tests                                   */
/* -------------------------------------------------------------------------- */

let d1: FakeD1;
let kv: ReturnType<typeof makeKv>;

beforeEach(() => {
  d1 = new FakeD1();
  kv = makeKv();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ensureIngestSeeded — guard rails', () => {
  it('skips when D1 binding is absent and returns skipped=true', async () => {
    const env = { CONGRESS_API_KEY: 'k', KV_VOTER_INFO: kv } as unknown as ProxyEnv;
    const r = await ensureIngestSeeded(env);
    expect(r.skipped).toBe(true);
    expect(r.roster.handlesUpserted).toBe(0);
  });

  it('skips when KV binding is absent and returns skipped=true', async () => {
    const env = { CONGRESS_API_KEY: 'k', D1_VOTER_INFO: d1 as unknown as D1Like } as unknown as ProxyEnv;
    const r = await ensureIngestSeeded(env);
    expect(r.skipped).toBe(true);
  });
});

describe('ensureIngestSeeded — full seed path', () => {
  /**
   * One member shard with two MoCs covering the bluesky-name-match path
   * (Sen. Doe → matches by full name, Sen. Smith → matches by last-name
   * fallback after the prefix is stripped).
   */
  beforeEach(() => {
    seedNameShard(kv, 'd', [
      {
        bioguideId: 'D000001',
        displayName: 'Jane Doe',
        first: 'Jane',
        last: 'Doe',
        state: 'CA',
        chamber: 'Senate',
        party: 'D',
        searchKeys: ['jane doe', 'doe'],
      },
    ]);
    seedNameShard(kv, 's', [
      {
        bioguideId: 'S000002',
        displayName: 'John Smith',
        first: 'John',
        last: 'Smith',
        state: 'OH',
        chamber: 'House',
        party: 'R',
        searchKeys: ['john smith', 'smith'],
      },
    ]);
  });

  it('populates handles, keywords, bills via the full orchestration', async () => {
    installFetch([
      // Congress legislators socials.
      {
        match: (u) => u.includes('legislators-social-media.json'),
        respond: () => [
          {
            id: { bioguide: 'D000001' },
            social: {
              youtube: 'sendoeofficial',
              youtube_id: 'UCJaneDoeChannel',
              mastodon: '@jdoe@mastodon.social',
              twitter: 'janedoe',
              facebook: 'sendoeofficial',
              instagram: 'sendoe',
              threads: 'sendoe',
            },
          },
          {
            id: { bioguide: 'S000002' },
            social: { mastodon: '@jsmith@mastodon.social' },
          },
          // Entry without bioguide id — must be skipped.
          { id: {}, social: { twitter: 'noop' } },
          // Entry without socials — must be skipped.
          { id: { bioguide: 'NOSOCIAL' } },
        ],
      },
      // Bluesky resolveHandle for the pack author.
      {
        match: (u) => u.includes('com.atproto.identity.resolveHandle'),
        respond: () => ({ did: 'did:plc:packauthor' }),
      },
      // Bluesky getStarterPack.
      {
        match: (u) => u.includes('app.bsky.graph.getStarterPack'),
        respond: () => ({ starterPack: { list: { uri: 'at://did:plc:packauthor/app.bsky.graph.list/abc' } } }),
      },
      // Bluesky getList — single page, terminates immediately.
      {
        match: (u) => u.includes('app.bsky.graph.getList'),
        respond: () => ({
          items: [
            {
              subject: {
                handle: 'janedoe.bsky.social',
                did: 'did:plc:jane',
                displayName: 'Sen. Jane Doe (D-CA)',
                avatar: 'https://avatars/jane.png',
              },
            },
            {
              subject: {
                handle: 'unmatched.bsky.social',
                did: 'did:plc:unknown',
                displayName: 'Some Person',
              },
            },
          ],
        }),
      },
    ]);

    const env = makeEnv(d1, kv);
    const r = await ensureIngestSeeded(env);

    expect(r.skipped).toBe(false);
    expect(r.roster.membersScanned).toBe(2);
    // Handles inserted: D000001 has 6 platform rows; S000002 has 1 (mastodon).
    expect(r.roster.handlesUpserted).toBeGreaterThanOrEqual(7);
    expect(r.roster.mastodon).toBe(2);
    // Bluesky: only the cleaned name "Jane Doe" matches the name index.
    expect(r.roster.bluesky).toBe(1);
    // Keywords: all 12 created on first pass.
    expect(r.keywords.seeded).toBe(12);
    // Bill stubs from src/data/ukraineBills.json — at least one inserted.
    expect(r.bills.stubsInserted).toBeGreaterThan(0);
    expect(r.bills.alreadyPresent).toBe(0);

    // YouTube row's platform_id should be the channel ID, not the @handle.
    const ytRow = d1.tables.mocs_social_handles!.find(
      (h) => h['bioguide_id'] === 'D000001' && h['platform'] === 'youtube',
    );
    expect(ytRow?.['platform_id']).toBe('UCJaneDoeChannel');

    // Bluesky row uses the DID as platform_id.
    const bskyRow = d1.tables.mocs_social_handles!.find(
      (h) => h['platform'] === 'bluesky' && h['bioguide_id'] === 'D000001',
    );
    expect(bskyRow?.['platform_id']).toBe('did:plc:jane');
    expect(bskyRow?.['avatar_url']).toBe('https://avatars/jane.png');
  });

  it('updates platform_id when an existing youtube row has a stale handle-only id', async () => {
    // Pre-seed a youtube row with a handle, not a UC… channel id.
    d1.tables.mocs_social_handles!.push({
      id: 'h_pre',
      bioguide_id: 'D000001',
      account_category: 'congress',
      platform: 'youtube',
      handle: 'sendoeofficial',
      platform_id: 'sendoeofficial',
      active_to: null,
    });
    installFetch([
      {
        match: (u) => u.includes('legislators-social-media.json'),
        respond: () => [
          {
            id: { bioguide: 'D000001' },
            social: { youtube: 'sendoeofficial', youtube_id: 'UCResolvedNow' },
          },
        ],
      },
      { match: (u) => u.includes('com.atproto'), respond: () => ({ did: 'did:plc:author' }) },
      { match: (u) => u.includes('getStarterPack'), respond: () => ({ starterPack: { list: { uri: 'at://x/y/z' } } }) },
      { match: (u) => u.includes('getList'), respond: () => ({ items: [] }) },
    ]);

    await ensureIngestSeeded(makeEnv(d1, kv));
    const updated = d1.tables.mocs_social_handles!.find((h) => h['id'] === 'h_pre');
    expect(updated?.['platform_id']).toBe('UCResolvedNow');
  });

  it('keyword seed is idempotent — second run reports zero new keywords', async () => {
    installFetch([
      { match: (u) => u.includes('legislators-social-media.json'), respond: () => [] },
      { match: (u) => u.includes('resolveHandle'), respond: () => ({ did: 'did:plc:x' }) },
      { match: (u) => u.includes('getStarterPack'), respond: () => ({ starterPack: { list: { uri: 'at://x/y/z' } } }) },
      { match: (u) => u.includes('getList'), respond: () => ({ items: [] }) },
    ]);
    const env = makeEnv(d1, kv);
    const first = await ensureIngestSeeded(env);
    expect(first.keywords.seeded).toBe(12);
    const second = await ensureIngestSeeded(env);
    expect(second.keywords.seeded).toBe(0);
    // Bills should also report fully-already-present on the second pass.
    expect(second.bills.stubsInserted).toBe(0);
    expect(second.bills.alreadyPresent).toBeGreaterThan(0);
  });

  it('degrades gracefully when the congress-legislators upstream fails', async () => {
    installFetch([
      { match: (u) => u.includes('legislators-social-media.json'), respond: () => ({}), status: 503 },
      { match: (u) => u.includes('resolveHandle'), respond: () => ({ did: 'did:plc:x' }) },
      { match: (u) => u.includes('getStarterPack'), respond: () => ({ starterPack: { list: { uri: 'at://x/y/z' } } }) },
      { match: (u) => u.includes('getList'), respond: () => ({ items: [] }) },
    ]);
    const r = await ensureIngestSeeded(makeEnv(d1, kv));
    // Roster never gets upstream socials → mastodon=0, no congress-handle inserts.
    expect(r.roster.mastodon).toBe(0);
    expect(r.skipped).toBe(false);
  });

  it('degrades gracefully when Bluesky resolveHandle fails — bluesky.matched=0', async () => {
    installFetch([
      { match: (u) => u.includes('legislators-social-media.json'), respond: () => [] },
      { match: (u) => u.includes('resolveHandle'), respond: () => ({}), status: 500 },
    ]);
    const r = await ensureIngestSeeded(makeEnv(d1, kv));
    expect(r.roster.bluesky).toBe(0);
  });
});

describe('resolveYouTubeChannelIds (direct)', () => {
  it('returns 0 when no unresolved rows exist', async () => {
    const r = await resolveYouTubeChannelIds(d1 as unknown as D1Like, 'KEY', { env: 'test', traceId: 't' });
    expect(r).toBe(0);
  });

  it('resolves via forHandle and updates the row in place', async () => {
    d1.tables.mocs_social_handles!.push({
      id: 'h_yt',
      handle: 'sendoeofficial',
      platform: 'youtube',
      platform_id: 'sendoeofficial',
      active_to: null,
    });
    installFetch([
      {
        match: (u) => u.includes('forHandle='),
        respond: () => ({ items: [{ id: 'UCresolved' }] }),
      },
    ]);
    const r = await resolveYouTubeChannelIds(d1 as unknown as D1Like, 'KEY', { env: 'test', traceId: 't' });
    expect(r).toBe(1);
    expect(d1.tables.mocs_social_handles![0]!['platform_id']).toBe('UCresolved');
  });

  it('falls back to forUsername when forHandle returns no items', async () => {
    d1.tables.mocs_social_handles!.push({
      id: 'h_yt',
      handle: 'oldstylename',
      platform: 'youtube',
      platform_id: 'oldstylename',
      active_to: null,
    });
    installFetch([
      { match: (u) => u.includes('forHandle='), respond: () => ({ items: [] }) },
      { match: (u) => u.includes('forUsername='), respond: () => ({ items: [{ id: 'UCfallback' }] }) },
    ]);
    const r = await resolveYouTubeChannelIds(d1 as unknown as D1Like, 'KEY', { env: 'test', traceId: 't' });
    expect(r).toBe(1);
    expect(d1.tables.mocs_social_handles![0]!['platform_id']).toBe('UCfallback');
  });

  it('skips rows when neither endpoint returns a UC… id', async () => {
    d1.tables.mocs_social_handles!.push({
      id: 'h_yt',
      handle: 'unfindable',
      platform: 'youtube',
      platform_id: 'unfindable',
      active_to: null,
    });
    installFetch([
      { match: (u) => u.includes('forHandle='), respond: () => ({ items: [] }) },
      { match: (u) => u.includes('forUsername='), respond: () => ({ items: [{ id: 'NOTUCprefix' }] }) },
    ]);
    const r = await resolveYouTubeChannelIds(d1 as unknown as D1Like, 'KEY', { env: 'test', traceId: 't' });
    expect(r).toBe(0);
    expect(d1.tables.mocs_social_handles![0]!['platform_id']).toBe('unfindable');
  });
});
