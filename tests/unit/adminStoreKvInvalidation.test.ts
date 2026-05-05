/**
 * AC-52.47 — KV invalidation hook on every D1 mutation in admin-store.
 *
 * After each create/update/delete, the affected KV keys SHALL be deleted so
 * the next embed read repopulates from D1. KV deletes are best-effort: a
 * KV failure does NOT roll back the D1 mutation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createBill,
  updateBill,
  deleteBill,
  createVote,
  updateVote,
  deleteVote,
  createComment,
  updateComment,
  deleteComment,
  createSocialPost,
  updateSocialPost,
  deleteSocialPost,
  createQuote,
  updateQuote,
  deleteQuote,
  type MutationContext,
} from '../../proxy/d1/admin-store';
import type { D1Like, D1PreparedStatementLike, D1ResultLike, KVLike } from '../../proxy/env';

/* -------------------------------------------------------------------------- */
/*                              Minimal fake D1                               */
/* -------------------------------------------------------------------------- */

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
    const ins = q.match(/^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)/i);
    if (ins) {
      const table = ins[1]!;
      const cols = ins[2]!.split(',').map((c) => c.trim());
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => { row[c] = this.bindings[i] ?? null; });
      this.d1.tables[table]!.push(row);
      return { success: true, meta: { changes: 1 } };
    }
    const upd = q.match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+id\s*=\s*\?/is);
    if (upd) {
      const table = upd[1]!;
      const fields = upd[2]!.split(',').map((f) => f.split('=')[0]!.trim());
      const id = this.bindings[this.bindings.length - 1] as string;
      const rows = this.d1.tables[table]!;
      const idx = rows.findIndex((r) => r['id'] === id);
      if (idx === -1) return { success: true, meta: { changes: 0 } };
      const row = { ...rows[idx]! };
      fields.forEach((f, i) => { row[f] = this.bindings[i] ?? null; });
      rows[idx] = row;
      return { success: true, meta: { changes: 1 } };
    }
    const del = q.match(/^DELETE\s+FROM\s+(\w+)\s+WHERE\s+id\s*=\s*\?/i);
    if (del) {
      const table = del[1]!;
      const id = this.bindings[0] as string;
      const rows = this.d1.tables[table]!;
      const idx = rows.findIndex((r) => r['id'] === id);
      if (idx >= 0) rows.splice(idx, 1);
      return { success: true, meta: { changes: idx >= 0 ? 1 : 0 } };
    }
    const exists = q.match(/^SELECT\s+1\s+FROM\s+(\w+)\s+WHERE\s+(\w+)\s*=\s*\?/i);
    if (exists) {
      const table = exists[1]!, col = exists[2]!;
      const found = (this.d1.tables[table] ?? []).find((r) => r[col] === this.bindings[0]);
      return { success: true, results: found ? [{ '1': 1 }] : [] };
    }
    const sel = q.match(/^SELECT\s+\*\s+FROM\s+(\w+)\s+WHERE\s+id\s*=\s*\?/i);
    if (sel) {
      const table = sel[1]!;
      const rows = (this.d1.tables[table] ?? []).filter((r) => r['id'] === this.bindings[0]);
      return { success: true, results: rows };
    }
    // SELECT <cols> FROM <table> WHERE col = ? AND col = ?  — quote dedupe path.
    const selCols = q.match(/^SELECT\s+[\w\s,]+\s+FROM\s+(\w+)\s+WHERE\s+(\w+)\s*=\s*\?\s+AND\s+(\w+)\s*=\s*\?/i);
    if (selCols) {
      const table = selCols[1]!, c1 = selCols[2]!, c2 = selCols[3]!;
      const rows = (this.d1.tables[table] ?? []).filter((r) => r[c1] === this.bindings[0] && r[c2] === this.bindings[1]);
      return { success: true, results: rows };
    }
    throw new Error(`unhandled: ${q}`);
  }
}

class FakeD1 implements D1Like {
  tables: Record<string, Record<string, unknown>[]> = {
    bills: [], votes: [], comments: [], social_posts: [], quotes: [],
    audit_log: [], score_adjustments: [], researchers: [],
  };
  prepare(q: string) { return new FakeStmt(this, q); }
  async batch<T>(stmts: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
    const out: D1ResultLike<T>[] = [];
    for (const s of stmts) out.push(await s.run() as D1ResultLike<T>);
    return out;
  }
  async exec() { return { count: 0, duration: 0 }; }
}

/* -------------------------------------------------------------------------- */
/*                              Fake KV                                       */
/* -------------------------------------------------------------------------- */

class FakeKV implements KVLike {
  store = new Map<string, string>();
  deleteCalls: string[] = [];
  async get(key: string) { return this.store.get(key) ?? null; }
  async put(key: string, value: string) { this.store.set(key, value); }
  async list(_opts: { prefix: string; cursor?: string }) {
    return { keys: [], list_complete: true };
  }
  async delete(key: string) {
    this.deleteCalls.push(key);
    this.store.delete(key);
  }
}

/* -------------------------------------------------------------------------- */
/*                                 Fixtures                                   */
/* -------------------------------------------------------------------------- */

let d1: FakeD1;
let kv: FakeKV;
let ctx: MutationContext;

beforeEach(() => {
  d1 = new FakeD1();
  kv = new FakeKV();
  ctx = {
    actorEmail: 'alice@example.com',
    traceId: 'tr_0123456789abcdef',
    kv,
  };
});

async function seedBill(billId = '117-HR-2471'): Promise<{ id: string; bill_id: string }> {
  const row = await createBill(d1, ctx, {
    bill_id: billId,
    congress: 117,
    type: 'HR',
    number: '2471',
    title: 'Test bill',
    direction: 'pro-ukraine',
  });
  // Reset deleteCalls so subsequent assertions are scoped to the test.
  kv.deleteCalls = [];
  return { id: row.id, bill_id: row.bill_id };
}

/* -------------------------------------------------------------------------- */
/*                                  Tests                                     */
/* -------------------------------------------------------------------------- */

describe('admin-store KV invalidation (AC-52.47) — bills', () => {
  it('createBill invalidates bill:v1:{bill_id}', async () => {
    await createBill(d1, ctx, {
      bill_id: '119-HR-99',
      congress: 119,
      type: 'HR',
      number: '99',
      title: 'New bill',
      direction: 'pro-ukraine',
    });
    expect(kv.deleteCalls).toContain('bill:v1:119-HR-99');
  });

  it('updateBill invalidates bill:v1:{bill_id}', async () => {
    const { id, bill_id } = await seedBill();
    await updateBill(d1, ctx, id, { title: 'Updated' });
    expect(kv.deleteCalls).toContain(`bill:v1:${bill_id}`);
  });

  it('deleteBill invalidates bill + comments KV keys (cascading)', async () => {
    const { id, bill_id } = await seedBill();
    await deleteBill(d1, ctx, id);
    expect(kv.deleteCalls).toContain(`bill:v1:${bill_id}`);
    expect(kv.deleteCalls).toContain(`comment:v1:${bill_id}`);
  });
});

describe('admin-store KV invalidation (AC-52.47) — votes', () => {
  it('createVote invalidates the parent bill:v1:{bill_id}', async () => {
    const { bill_id } = await seedBill();
    await createVote(d1, ctx, {
      bill_id,
      chamber: 'House',
      congress: 117,
      session: 2,
      roll_call: 65,
      date: '2022-03-10',
      weight: 1,
      kind: 'concur',
    });
    expect(kv.deleteCalls).toEqual([`bill:v1:${bill_id}`]);
  });

  it('updateVote + deleteVote both invalidate parent bill', async () => {
    const { bill_id } = await seedBill();
    const v = await createVote(d1, ctx, {
      bill_id,
      chamber: 'House',
      congress: 117,
      session: 2,
      roll_call: 65,
      date: '2022-03-10',
      weight: 1,
      kind: 'concur',
    });
    kv.deleteCalls = [];
    await updateVote(d1, ctx, v.id, { weight: 2 });
    expect(kv.deleteCalls).toContain(`bill:v1:${bill_id}`);

    kv.deleteCalls = [];
    await deleteVote(d1, ctx, v.id);
    expect(kv.deleteCalls).toContain(`bill:v1:${bill_id}`);
  });
});

describe('admin-store KV invalidation (AC-52.47) — comments', () => {
  it('createComment invalidates comment:v1:{bill_id}', async () => {
    const { bill_id } = await seedBill();
    await createComment(d1, ctx, {
      bill_id,
      body_markdown: 'note',
      weight: 1,
      direction: 1,
    });
    expect(kv.deleteCalls).toEqual([`comment:v1:${bill_id}`]);
  });

  it('update + delete comment both invalidate comment:v1:{bill_id}', async () => {
    const { bill_id } = await seedBill();
    const c = await createComment(d1, ctx, { bill_id, body_markdown: 'a', weight: 1, direction: 1 });
    kv.deleteCalls = [];
    await updateComment(d1, ctx, c.id, { body_markdown: 'b' });
    expect(kv.deleteCalls).toContain(`comment:v1:${bill_id}`);
    kv.deleteCalls = [];
    await deleteComment(d1, ctx, c.id);
    expect(kv.deleteCalls).toContain(`comment:v1:${bill_id}`);
  });
});

describe('admin-store KV invalidation (AC-52.47) — social posts', () => {
  it('all three CUD ops invalidate social-post:v1:{bioguide_id}', async () => {
    const p = await createSocialPost(d1, ctx, {
      bioguide_id: 'D000563',
      platform: 'x',
      url: 'https://x.com/x/1',
      body_text: 'hello',
      weight: 0,
      direction: 0,
    });
    expect(kv.deleteCalls).toContain('social-post:v1:D000563');
    kv.deleteCalls = [];
    await updateSocialPost(d1, ctx, p.id, { body_text: 'edit' });
    expect(kv.deleteCalls).toContain('social-post:v1:D000563');
    kv.deleteCalls = [];
    await deleteSocialPost(d1, ctx, p.id);
    expect(kv.deleteCalls).toContain('social-post:v1:D000563');
  });
});

describe('admin-store KV invalidation (AC-52.47) — quotes', () => {
  it('all three CUD ops invalidate quote:v1:{bioguide_id}', async () => {
    const q = await createQuote(d1, ctx, {
      bioguide_id: 'D000563',
      media_kind: 'video',
      source_url: 'https://www.c-span.org/video/?123',
      body_text: 'on Ukraine',
      weight: 0,
      direction: 0,
    });
    expect(kv.deleteCalls).toContain('quote:v1:D000563');
    kv.deleteCalls = [];
    await updateQuote(d1, ctx, q.id, { body_text: 'edit' });
    expect(kv.deleteCalls).toContain('quote:v1:D000563');
    kv.deleteCalls = [];
    await deleteQuote(d1, ctx, q.id);
    expect(kv.deleteCalls).toContain('quote:v1:D000563');
  });
});

describe('admin-store KV invalidation (AC-52.47) — best-effort posture', () => {
  it('KV.delete failure does NOT throw or roll back the D1 mutation', async () => {
    const { bill_id } = await seedBill();
    // Make every KV delete throw.
    kv.delete = async () => { throw new Error('KV throttled'); };
    await expect(
      createComment(d1, ctx, {
        bill_id,
        body_markdown: 'still works',
        weight: 1,
        direction: 1,
      }),
    ).resolves.toMatchObject({ body_markdown: 'still works' });
    // D1 row is present despite KV failure.
    expect(d1.tables.comments).toHaveLength(1);
  });

  it('mutation skipped when ctx.kv is undefined (legacy callers)', async () => {
    const noKvCtx: MutationContext = { actorEmail: 'a@b', traceId: 'tr_0' };
    const r = await createBill(d1, noKvCtx, {
      bill_id: '119-HR-1',
      congress: 119,
      type: 'HR',
      number: '1',
      title: 't',
      direction: 'pro-ukraine',
    });
    expect(r.bill_id).toBe('119-HR-1');
    // No KV instance to record against; the test passes if no throw happened.
  });
});
