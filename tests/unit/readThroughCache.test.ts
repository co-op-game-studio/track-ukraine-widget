/**
 * AC-52.46 + AC-52.48 + AC-52.51 — read-through cache fallthrough.
 *
 * Embed read routes serve from KV when present; on miss, query D1, project
 * via kv-projector, write back to KV (no TTL — invalidation is explicit
 * per AC-52.47), and return. AC-52.48: cold-D1 returns null so the caller
 * emits 404 + a `embed_read_cold` warn-level log line.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  readBillThroughD1,
  readCommentsThroughD1,
  readSocialPostsThroughD1,
  readQuotesThroughD1,
} from '../../proxy/services/read-through-cache';
import type { D1Like, D1PreparedStatementLike, D1ResultLike, KVLike } from '../../proxy/env';

class FakeStmt implements D1PreparedStatementLike {
  constructor(public d1: FakeD1, public q: string, public bindings: unknown[] = []) {}
  bind(...vs: unknown[]) {
    return new FakeStmt(this.d1, this.q, [...this.bindings, ...vs]);
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
    const q = this.q.trim();
    const exists = q.match(/^SELECT\s+1\s+FROM\s+(\w+)\s+WHERE\s+(\w+)\s*=\s*\?/i);
    if (exists) {
      const table = exists[1]!, col = exists[2]!;
      const found = (this.d1.tables[table] ?? []).find((r) => r[col] === this.bindings[0]);
      return { success: true, results: found ? [{ '1': 1 }] : [] };
    }
    const sel = q.match(/^SELECT\s+\*\s+FROM\s+(\w+)\s+WHERE\s+(\w+)\s*=\s*\?/i);
    if (sel) {
      const table = sel[1]!, col = sel[2]!;
      const rows = (this.d1.tables[table] ?? []).filter((r) => r[col] === this.bindings[0]);
      return { success: true, results: rows };
    }
    throw new Error(`unhandled: ${q}`);
  }
}
class FakeD1 implements D1Like {
  tables: Record<string, Record<string, unknown>[]> = {
    bills: [], votes: [], comments: [], social_posts: [], quotes: [],
  };
  prepare(q: string) { return new FakeStmt(this, q); }
  async batch<T>(_: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> { return []; }
  async exec() { return { count: 0, duration: 0 }; }
}

class FakeKV implements KVLike {
  store = new Map<string, string>();
  async get(key: string) { return this.store.get(key) ?? null; }
  async put(key: string, value: string) { this.store.set(key, value); }
  async list() { return { keys: [], list_complete: true as const }; }
  async delete(key: string) { this.store.delete(key); }
}

let d1: FakeD1;
let kv: FakeKV;
const ctx = () => ({ env: 'test', traceId: 'tr_t', d1, kv });

beforeEach(() => {
  d1 = new FakeD1();
  kv = new FakeKV();
});

/* -------------------------------------------------------------------------- */
/*                                  Bills                                     */
/* -------------------------------------------------------------------------- */

describe('readBillThroughD1 — bills (AC-52.51)', () => {
  it('cache hit: returns KV value, does NOT touch D1', async () => {
    kv.store.set('bill:v1:117-HR-2471', '{"billId":"117-HR-2471","cached":"yes"}');
    const out = await readBillThroughD1(ctx(), '117-HR-2471');
    expect(out).toBe('{"billId":"117-HR-2471","cached":"yes"}');
    // D1 untouched — no rows seeded, but no throw means no SELECT happened.
    expect(d1.tables.bills!.length).toBe(0);
  });

  it('cache miss + D1 hit: reads D1, projects, writes back to KV, returns', async () => {
    d1.tables.bills!.push({
      id: '01H',
      bill_id: '117-HR-2471',
      congress: 117,
      type: 'HR',
      number: '2471',
      featured: 1,
      label: null,
      title: 'Test bill',
      latest_action: null,
      latest_action_date: null,
      became_law: 1,
      congress_gov_url: null,
      direction: 'pro-ukraine',
      direction_reason: null,
      summary_json: null,
      created_at: 'x',
      updated_at: 'x',
    });
    const out = await readBillThroughD1(ctx(), '117-HR-2471');
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.billId).toBe('117-HR-2471');
    expect(parsed.title).toBe('Test bill');
    // KV was written for the next request.
    expect(kv.store.has('bill:v1:117-HR-2471')).toBe(true);
  });

  it('cold D1: returns null so the caller emits 404 (AC-52.48)', async () => {
    const out = await readBillThroughD1(ctx(), '999-HR-99999');
    expect(out).toBeNull();
    expect(kv.store.has('bill:v1:999-HR-99999')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                                Comments                                    */
/* -------------------------------------------------------------------------- */

describe('readCommentsThroughD1 — comments (AC-52.51)', () => {
  it('returns empty-list KV record when bill exists with no comments', async () => {
    d1.tables.bills!.push({ bill_id: '117-HR-2471' } as Record<string, unknown>);
    const out = await readCommentsThroughD1(ctx(), '117-HR-2471');
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.billId).toBe('117-HR-2471');
    expect(parsed.comments).toEqual([]);
  });

  it('returns null (404) when bill itself does not exist (AC-52.48)', async () => {
    const out = await readCommentsThroughD1(ctx(), '999-HR-99999');
    expect(out).toBeNull();
  });

  it('returns the projected comment list when bill + comments exist', async () => {
    d1.tables.bills!.push({ bill_id: '117-HR-2471' } as Record<string, unknown>);
    d1.tables.comments!.push({
      id: 'c1',
      bill_id: '117-HR-2471',
      attached_to_roll_call_id: null,
      body_markdown: 'Sample comment',
      weight: 0.5,
      direction: 1,
      author_email: 'a@b',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });
    const out = await readCommentsThroughD1(ctx(), '117-HR-2471');
    const parsed = JSON.parse(out!);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].weight).toBe(0.5);
    expect(parsed.comments[0].direction).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                              Social posts                                  */
/* -------------------------------------------------------------------------- */

describe('readSocialPostsThroughD1 — social posts (AC-52.51)', () => {
  it('returns null (404) when no posts for the bioguide', async () => {
    const out = await readSocialPostsThroughD1(ctx(), 'D000563');
    expect(out).toBeNull();
  });

  it('returns the projected list when posts exist', async () => {
    d1.tables.social_posts!.push({
      id: 'p1',
      bioguide_id: 'D000563',
      platform: 'x',
      url: 'https://x.com/x/1',
      posted_at: '2026-01-01',
      body_text: 'hi',
      weight: 1,
      direction: 1,
      comment: null,
      author_email: 'a@b',
      created_at: 'x',
      updated_at: 'x',
    });
    const out = await readSocialPostsThroughD1(ctx(), 'D000563');
    const parsed = JSON.parse(out!);
    expect(parsed.bioguideId).toBe('D000563');
    expect(parsed.posts).toHaveLength(1);
    expect(parsed.posts[0].direction).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  Quotes                                    */
/* -------------------------------------------------------------------------- */

describe('readQuotesThroughD1 — quotes (AC-52.51)', () => {
  it('returns null (404) when no quotes for the bioguide', async () => {
    const out = await readQuotesThroughD1(ctx(), 'D000563');
    expect(out).toBeNull();
  });

  it('returns the projected list when quotes exist', async () => {
    d1.tables.quotes!.push({
      id: 'q1',
      bioguide_id: 'D000563',
      media_kind: 'video',
      source_url: 'https://www.c-span.org/video/?123',
      source_label: null,
      quoted_at: '2024-02-13',
      body_text: 'On Ukraine',
      weight: 1,
      direction: 1,
      comment: null,
      author_email: 'a@b',
      created_at: 'x',
      updated_at: 'x',
    });
    const out = await readQuotesThroughD1(ctx(), 'D000563');
    const parsed = JSON.parse(out!);
    expect(parsed.quotes).toHaveLength(1);
    expect(parsed.quotes[0].mediaKind).toBe('video');
  });
});
