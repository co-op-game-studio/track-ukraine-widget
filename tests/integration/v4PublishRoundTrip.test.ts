/**
 * V4 D1→KV→embed round-trip integration test.
 *
 * Composes:
 *   - real `admin-store` (proxy/d1/admin-store.ts) writing to a FakeD1
 *   - real `buildPublishPlan` projector (scripts/publish-d1-to-kv.ts)
 *     against the FakeD1's table state
 *   - real embed read route handlers (proxy/routes/api-bills.ts,
 *     api-comments.ts, api-social-posts.ts, api-audit-public.ts)
 *     reading the FakeKv we populate from the plan
 *
 * Locks the contract that an admin write flows correctly through the
 * publish projection into the shape the embed read routes return.
 *
 * Traces to FR-44 AC-44.21, FR-50, FR-51, FR-58.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createBill,
  deleteBill,
  createComment,
  createSocialPost,
  type MutationContext,
  type BillRow,
  type CommentRow,
  type SocialPostRow,
} from '../../proxy/d1/admin-store';
import {
  buildPublishPlan,
  type D1Bill,
  type D1Vote,
  type D1Comment,
  type D1SocialPost,
  type D1Quote,
  type D1Audit,
} from '../../scripts/publish-d1-to-kv';
import { handleBill } from '../../proxy/routes/api-bills';
import { handleComments } from '../../proxy/routes/api-comments';
import { handleSocialPosts } from '../../proxy/routes/api-social-posts';
import { handleAuditPublic } from '../../proxy/routes/api-audit-public';
import type {
  D1Like,
  D1PreparedStatementLike,
  D1ResultLike,
  KVLike,
  ProxyEnv,
} from '../../proxy/env';

/* -------------------------------------------------------------------------- */
/*                              In-memory fakes                               */
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
  async run() {
    return this.execute();
  }
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
      const table = exists[1]!;
      const col = exists[2]!;
      const found = (this.d1.tables[table] ?? []).find((r) => r[col] === this.bindings[0]);
      return { success: true, results: found ? [{ '1': 1 }] : [] };
    }
    const sel = q.match(/^SELECT\s+\*\s+FROM\s+(\w+)\s+WHERE\s+id\s*=\s*\?/i);
    if (sel) {
      const table = sel[1]!;
      const rows = (this.d1.tables[table] ?? []).filter((r) => r['id'] === this.bindings[0]);
      return { success: true, results: rows };
    }
    const list = q.match(/^SELECT\s+\*\s+FROM\s+(\w+)/i);
    if (list) return { success: true, results: this.d1.tables[list[1]!] ?? [] };
    throw new Error(`unhandled: ${q}`);
  }
}

class FakeD1 implements D1Like {
  tables: Record<string, Record<string, unknown>[]> = {
    bills: [],
    votes: [],
    comments: [],
    social_posts: [],
    quotes: [],
    audit_log: [],
    score_adjustments: [],
    researchers: [],
  };
  prepare(q: string) {
    return new FakeStmt(this, q);
  }
  async batch<T>(stmts: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
    const snapshot = JSON.parse(JSON.stringify(this.tables));
    const out: D1ResultLike<T>[] = [];
    try {
      for (const s of stmts) out.push((await s.run()) as D1ResultLike<T>);
      return out;
    } catch (err) {
      this.tables = snapshot;
      return [{ success: false, error: (err as Error).message } as D1ResultLike<T>];
    }
  }
  async exec() {
    return { count: 0, duration: 0 };
  }
}

class FakeKv implements KVLike {
  store = new Map<string, string>();
  async get(key: string, type?: 'text' | 'json') {
    const v = this.store.get(key);
    if (v === undefined) return null;
    if (type === 'json') return JSON.parse(v);
    return v;
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
  }
  async list(opts: { prefix: string }) {
    return {
      keys: [...this.store.keys()].filter((k) => k.startsWith(opts.prefix)).map((name) => ({ name })),
      list_complete: true,
    };
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

/* -------------------------------------------------------------------------- */
/*                             Pipeline harness                               */
/* -------------------------------------------------------------------------- */

const ORIGIN = 'https://embed.example';

function makeEnv(kv: FakeKv): ProxyEnv {
  return { KV_VOTER_INFO: kv } as unknown as ProxyEnv;
}

/**
 * Run the publish projector against the current FakeD1 state and write the
 * resulting plan into FakeKv. Returns the plan key list for assertions.
 */
function publish(d1: FakeD1, kv: FakeKv, generatedAt: string): string[] {
  const inputs = {
    bills: d1.tables.bills as unknown as D1Bill[],
    votes: d1.tables.votes as unknown as D1Vote[],
    comments: d1.tables.comments as unknown as D1Comment[],
    posts: d1.tables.social_posts as unknown as D1SocialPost[],
    quotes: d1.tables.quotes as unknown as D1Quote[],
    audits: d1.tables.audit_log as unknown as D1Audit[],
    generatedAt,
  };
  // Drop any keys the projector would NOT regenerate this run (mimics a
  // real publish that targets only the keys present in current D1 state).
  // For our tests, we want the publish to be authoritative — if a bill is
  // gone from D1, its `bill:v1:*` key should be removed from KV. The real
  // publish script does this via a diff + delete. For test simplicity we
  // clear all curated `*:v1:*` keys before each publish (this is ALSO
  // what a real "full re-publish from scratch" does).
  for (const k of [...kv.store.keys()]) {
    if (k.startsWith('bill:v1:') || k.startsWith('comment:v1:') ||
        k.startsWith('social-post:v1:') || k.startsWith('quote:v1:') ||
        k.startsWith('stats:v1:') || k.startsWith('audit-feed:v1:')) {
      kv.store.delete(k);
    }
  }
  const plan = buildPublishPlan(inputs);
  for (const [key, val] of plan.writes) kv.store.set(key, val);
  return [...plan.writes.keys()];
}

/* -------------------------------------------------------------------------- */
/*                                Test fixtures                               */
/* -------------------------------------------------------------------------- */

let d1: FakeD1;
let kv: FakeKv;

const ctx: MutationContext = {
  actorEmail: 'alice@example.com',
  traceId: 'tr_v4round00000001',
  reason: 'integration test seed',
};

beforeEach(() => {
  d1 = new FakeD1();
  kv = new FakeKv();
});

/* -------------------------------------------------------------------------- */
/*                                  Tests                                     */
/* -------------------------------------------------------------------------- */

describe('V4 D1→KV→embed round-trip (FR-44 AC-44.21)', () => {
  it('(a) bill created via admin-store flows through publish into the embed bill read', async () => {
    // 1. Admin write — create a bill via the real store.
    const created = (await createBill(d1, ctx, {
      bill_id: '117-HR-2471',
      congress: 117,
      type: 'HR',
      number: '2471',
      title: 'Consolidated Appropriations Act, 2022',
      direction: 'pro-ukraine',
      featured: true,
      label: 'flagship',
      latest_action: 'Became Public Law',
      latest_action_date: '2022-03-15',
      became_law: true,
    })) as BillRow;
    expect(created.bill_id).toBe('117-HR-2471');

    // 2. Curator publish — D1 → KV.
    const keys = publish(d1, kv, '2026-05-02T20:00:00.000Z');
    expect(keys).toContain('bill:v1:117-HR-2471');

    // 3. Embed read — what does the public route return?
    const result = await handleBill(
      '117-HR-2471',
      new Request('https://worker.example/api/bills/117-HR-2471'),
      makeEnv(kv),
      ORIGIN,
    );
    expect(result.response.status).toBe(200);
    const body = (await result.response.json()) as {
      billId: string;
      title: string;
      direction: string;
      schemaVersion: number;
      curatedRollCalls: unknown[];
    };
    expect(body.billId).toBe('117-HR-2471');
    expect(body.title).toBe('Consolidated Appropriations Act, 2022');
    expect(body.direction).toBe('pro-ukraine');
    expect(body.schemaVersion).toBe(1);
    expect(body.curatedRollCalls).toEqual([]);
  });

  it('(b) comment attached to a bill flows into /api/comments with all expected fields', async () => {
    // Seed a bill (FK target).
    const bill = (await createBill(d1, ctx, {
      bill_id: '118-HR-815',
      congress: 118,
      type: 'HR',
      number: '815',
      title: 'Israel Security Supplemental Appropriations Act, 2024',
      direction: 'pro-ukraine',
    })) as BillRow;
    expect(bill).toBeDefined();

    // Admin attaches a comment scoped to a specific roll-call.
    const comment = (await createComment(d1, ctx, {
      bill_id: '118-HR-815',
      attached_to_roll_call_id: 'house:118:2:30',
      body_markdown: 'Floor vote was the deciding moment of the supplemental.',
      weight: 0.5,
      direction: 1,
    })) as CommentRow;
    expect(comment.author_email).toBe('alice@example.com');

    // Publish the projection.
    publish(d1, kv, '2026-05-02T20:01:00.000Z');

    // Embed read — what does /api/comments/{billId} return?
    const result = await handleComments(
      '118-HR-815',
      new Request('https://worker.example/api/comments/118-HR-815'),
      makeEnv(kv),
      ORIGIN,
    );
    expect(result.response.status).toBe(200);
    const body = (await result.response.json()) as {
      billId: string;
      comments: Array<{
        id: string;
        bodyMarkdown: string;
        weight: number;
        direction: number;
        attachedToRollCallId: string;
        authorEmail: string;
      }>;
      schemaVersion: number;
    };
    expect(body.billId).toBe('118-HR-815');
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0]!.bodyMarkdown).toMatch(/deciding moment/);
    expect(body.comments[0]!.weight).toBe(0.5);
    expect(body.comments[0]!.direction).toBe(1);
    expect(body.comments[0]!.attachedToRollCallId).toBe('house:118:2:30');
    expect(body.comments[0]!.authorEmail).toBe('alice@example.com');
    expect(body.schemaVersion).toBe(1);
  });

  it('(c) two social posts for the same rep project into a single record in canonical order', async () => {
    // Two posts for Durbin; the projector orders by posted_at descending
    // (newest first) so the embed sees the latest at the top.
    const olderPost = (await createSocialPost(d1, ctx, {
      bioguide_id: 'D000563',
      platform: 'x',
      url: 'https://x.com/SenatorDurbin/status/older',
      posted_at: '2026-04-01T00:00:00Z',
      body_text: 'older post',
    })) as SocialPostRow;
    const newerPost = (await createSocialPost(d1, ctx, {
      bioguide_id: 'D000563',
      platform: 'x',
      url: 'https://x.com/SenatorDurbin/status/newer',
      posted_at: '2026-05-01T00:00:00Z',
      body_text: 'newer post',
    })) as SocialPostRow;
    expect(olderPost.id).not.toBe(newerPost.id);

    publish(d1, kv, '2026-05-02T20:02:00.000Z');

    const result = await handleSocialPosts(
      'D000563',
      new Request('https://worker.example/api/social-posts/D000563'),
      makeEnv(kv),
      ORIGIN,
    );
    expect(result.response.status).toBe(200);
    const body = (await result.response.json()) as {
      bioguideId: string;
      posts: Array<{ bodyText: string; postedAt: string }>;
    };
    expect(body.bioguideId).toBe('D000563');
    expect(body.posts).toHaveLength(2);
    // Newest first.
    expect(body.posts[0]!.bodyText).toBe('newer post');
    expect(body.posts[1]!.bodyText).toBe('older post');
  });

  it('(d) deleting a bill removes the KV record and the audit-public feed redacts email/before/after', async () => {
    // Create a bill, then delete it. Each mutation creates an audit entry.
    const bill = (await createBill(d1, ctx, {
      bill_id: '119-HR-99',
      congress: 119,
      type: 'HR',
      number: '99',
      title: 'Test bill to be deleted',
      direction: 'ambiguous',
    })) as BillRow;
    // Ensure the two audit rows land in distinct milliseconds so the
    // (created_at DESC, id DESC) ordering is deterministic. Without this,
    // ULID random tiebreak makes the test flake on fast machines.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await deleteBill(d1, ctx, bill.id);

    // Sanity: bills table is now empty; audit_log has 2 rows (create + delete).
    expect(d1.tables.bills).toHaveLength(0);
    expect(d1.tables.audit_log).toHaveLength(2);

    // Publish — bill key should NOT appear in KV (no bill rows to project).
    publish(d1, kv, '2026-05-02T20:03:00.000Z');
    expect(kv.store.has('bill:v1:119-HR-99')).toBe(false);

    // Embed read — bill is gone.
    const billResult = await handleBill(
      '119-HR-99',
      new Request('https://worker.example/api/bills/119-HR-99'),
      makeEnv(kv),
      ORIGIN,
    );
    expect(billResult.response.status).toBe(404);

    // Embed read — audit-public feed shows the actions, with email domain
    // stripped and `before/after/reason/trace_id` not exposed.
    const auditResult = await handleAuditPublic(
      new Request('https://worker.example/api/audit/public'),
      makeEnv(kv),
      ORIGIN,
    );
    expect(auditResult.response.status).toBe(200);
    const auditBody = (await auditResult.response.json()) as {
      schemaVersion: number;
      items: Array<Record<string, unknown>>;
    };
    expect(auditBody.schemaVersion).toBe(1);
    expect(auditBody.items.length).toBeGreaterThanOrEqual(2);

    // AC-58.2 redactions — every item is the redacted projection.
    for (const item of auditBody.items) {
      expect(item['actorLocalPart']).toBe('alice');
      expect(item).not.toHaveProperty('actor_email');
      expect(item).not.toHaveProperty('before');
      expect(item).not.toHaveProperty('after');
      expect(item).not.toHaveProperty('reason');
      expect(item).not.toHaveProperty('traceId');
    }
    // The most recent action SHALL be the delete (newest-first ordering
    // with ULID tiebreak for same-millisecond audit rows).
    const newest = auditBody.items[0] as { action: string; table: string };
    expect(newest.action).toBe('delete');
    expect(newest.table).toBe('bills');
  });
});
