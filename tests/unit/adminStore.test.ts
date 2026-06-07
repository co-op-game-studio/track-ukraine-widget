/**
 * Tests for proxy/d1/admin-store.ts.
 * Traces to FR-49, FR-50 AC-50.3 / AC-50.7, FR-54.
 *
 * Uses an in-memory fake D1 that supports the subset of features
 * admin-store needs: prepare + bind + first + run + all + batch
 * (atomic-or-nothing). The fake is intentionally tiny — it walks
 * a small SQL surface (INSERT, UPDATE, DELETE, SELECT) we control.
 *
 * For the broader correctness story, integration-test against a real
 * sqlite/D1 in T-118 (publish pipeline). This unit-level fake covers
 * the contract our store relies on: ULID PKs, atomic mutation+audit,
 * trace_id stamping, validation rejections.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createBill,
  updateBill,
  deleteBill,
  getBill,
  listBills,
  createVote,
  updateVote,
  createComment,
  createSocialPost,
  createQuote,
  listAudit,
  ValidationError,
  type MutationContext,
} from '../../proxy/d1/admin-store';
import { isUlid } from '../../src/utils/ulid';
import type {
  D1Like,
  D1PreparedStatementLike,
  D1ResultLike,
} from '../../proxy/env';

/* -------------------------------------------------------------------------- */
/*                              In-memory fake D1                             */
/* -------------------------------------------------------------------------- */

/**
 * Minimal D1 fake that interprets the small SQL vocabulary admin-store
 * uses. Not a general-purpose SQLite; just enough for these tests.
 *
 * Intentionally simple: the fake matches each query against a hand-rolled
 * regex set, executes against in-memory tables, and returns the shape
 * admin-store expects.
 */
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
  /** Tracks how many statements ran in the current batch — for atomicity tests. */
  lastBatchSize = 0;
  /** When set, the next audit insert throws to simulate a partial failure. */
  failNextAuditInsert = false;

  prepare(query: string): D1PreparedStatementLike {
    return new FakeStmt(this, query, []);
  }

  async batch<T>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
    this.lastBatchSize = statements.length;
    // Snapshot every table for rollback.
    const snapshot: typeof this.tables = JSON.parse(JSON.stringify(this.tables));
    const results: D1ResultLike<T>[] = [];
    try {
      for (const s of statements) {
        const r = await s.run();
        results.push(r as D1ResultLike<T>);
      }
      return results;
    } catch (err) {
      this.tables = snapshot; // rollback
      // Surface the failure as a non-success batch entry — admin-store throws.
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
    const result = this.execute();
    return ((result.results?.[0] ?? null) as T | null);
  }

  async run(): Promise<D1ResultLike<unknown>> {
    return this.execute();
  }

  async all<T = unknown>(): Promise<D1ResultLike<T>> {
    return this.execute() as D1ResultLike<T>;
  }

  private execute(): D1ResultLike<unknown> {
    const q = this.query.trim();
    // INSERT INTO <table> (cols) VALUES (...)
    const insMatch = q.match(/^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s+VALUES/i);
    if (insMatch) {
      const table = insMatch[1]!;
      const colsRaw = insMatch[2]!;
      const cols = colsRaw.split(',').map((c) => c.trim());
      if (table === 'audit_log' && this.d1.failNextAuditInsert) {
        this.d1.failNextAuditInsert = false;
        throw new Error('forced_audit_failure');
      }
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        row[c] = this.bindings[i] ?? null;
      });
      this.d1.tables[table]!.push(row);
      return { success: true, meta: { changes: 1 } };
    }
    // UPDATE <table> SET ... WHERE id = ?
    const updMatch = q.match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+id\s*=\s*\?/is);
    if (updMatch) {
      const table = updMatch[1]!;
      const setClause = updMatch[2]!;
      const fields = setClause.split(',').map((f) => f.split('=')[0]!.trim());
      const id = this.bindings[this.bindings.length - 1] as string;
      const rows = this.d1.tables[table]!;
      const idx = rows.findIndex((r) => r['id'] === id);
      if (idx === -1) return { success: true, meta: { changes: 0 } };
      const row = { ...rows[idx]! };
      fields.forEach((f, i) => {
        row[f] = this.bindings[i] ?? null;
      });
      rows[idx] = row;
      return { success: true, meta: { changes: 1 } };
    }
    // DELETE FROM <table> WHERE id = ?
    const delMatch = q.match(/^DELETE\s+FROM\s+(\w+)\s+WHERE\s+id\s*=\s*\?/i);
    if (delMatch) {
      const table = delMatch[1]!;
      const id = this.bindings[0] as string;
      const rows = this.d1.tables[table]!;
      const idx = rows.findIndex((r) => r['id'] === id);
      if (idx >= 0) rows.splice(idx, 1);
      return { success: true, meta: { changes: idx >= 0 ? 1 : 0 } };
    }
    // SELECT 1 FROM bills WHERE bill_id = ? LIMIT 1
    const existsMatch = q.match(/^SELECT\s+1\s+FROM\s+(\w+)\s+WHERE\s+(\w+)\s*=\s*\?/i);
    if (existsMatch) {
      const table = existsMatch[1]!;
      const col = existsMatch[2]!;
      const val = this.bindings[0];
      const found = (this.d1.tables[table] ?? []).find((r) => r[col] === val);
      return { success: true, results: found ? [{ '1': 1 } as unknown] : [] };
    }
    // SELECT * FROM <table> WHERE id = ?
    const selByIdMatch = q.match(/^SELECT\s+\*\s+FROM\s+(\w+)\s+WHERE\s+id\s*=\s*\?/i);
    if (selByIdMatch) {
      const table = selByIdMatch[1]!;
      const id = this.bindings[0];
      const rows = (this.d1.tables[table] ?? []).filter((r) => r['id'] === id);
      return { success: true, results: rows };
    }
    // SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? — single-binding form.
    // (Checked BEFORE the generic selListMatch so the audit list query doesn't
    // accidentally match the LIMIT?+OFFSET? branch.)
    const auditListMatch = q.match(/^SELECT\s+\*\s+FROM\s+audit_log\s+WHERE\s+created_at\s*>=\s*\?/i);
    const auditListSimple = q.match(/^SELECT\s+\*\s+FROM\s+audit_log\s+ORDER\s+BY/i);
    if (auditListMatch || auditListSimple) {
      const sinceFiltered = auditListMatch
        ? (this.d1.tables.audit_log ?? []).filter((r) =>
            String(r['created_at']) >= String(this.bindings[0]),
          )
        : (this.d1.tables.audit_log ?? []);
      const limit = Number(this.bindings[this.bindings.length - 1] ?? 50);
      const rows = [...sinceFiltered]
        .sort((a, b) => String(b['created_at']).localeCompare(String(a['created_at'])))
        .slice(0, limit);
      return { success: true, results: rows };
    }
    // SELECT * FROM <table> ORDER BY ... LIMIT ? OFFSET ?
    const selListMatch = q.match(/^SELECT\s+\*\s+FROM\s+(\w+)\s+ORDER\s+BY/i);
    if (selListMatch) {
      const table = selListMatch[1]!;
      const limit = Number(this.bindings[this.bindings.length - 2] ?? 100);
      const offset = Number(this.bindings[this.bindings.length - 1] ?? 0);
      const rows = (this.d1.tables[table] ?? []).slice(offset, offset + limit);
      return { success: true, results: rows };
    }
    // SELECT <cols> FROM <table> WHERE col = ? AND col = ?  — used by createQuote
    // dedupe check (`SELECT id, weight, direction FROM quotes WHERE source_url = ? AND bioguide_id = ?`).
    // Filter rows by the named columns and return any matches (the real
    // store treats non-null = "duplicate"; tests want null/empty = "fresh insert").
    const selColsMatch = q.match(/^SELECT\s+([\w\s,]+)\s+FROM\s+(\w+)\s+WHERE\s+(\w+)\s*=\s*\?\s+AND\s+(\w+)\s*=\s*\?/i);
    if (selColsMatch) {
      const table = selColsMatch[2]!;
      const col1 = selColsMatch[3]!;
      const col2 = selColsMatch[4]!;
      const v1 = this.bindings[0];
      const v2 = this.bindings[1];
      const rows = (this.d1.tables[table] ?? []).filter((r) => r[col1] === v1 && r[col2] === v2);
      return { success: true, results: rows };
    }
    throw new Error(`unhandled query in fake D1: ${q}`);
  }
}

/* -------------------------------------------------------------------------- */
/*                                Test fixtures                               */
/* -------------------------------------------------------------------------- */

let d1: FakeD1;
const ctx: MutationContext = {
  actorEmail: 'alice@example.com',
  traceId: 'tr_0123456789abcdef',
};

beforeEach(() => {
  d1 = new FakeD1();
});

async function seedBill(billId = '117-HR-2471'): Promise<string> {
  const row = await createBill(d1, ctx, {
    bill_id: billId,
    congress: 117,
    type: 'HR',
    number: '2471',
    title: 'Consolidated Appropriations Act, 2022',
    direction: 'pro-ukraine',
  });
  return row.id;
}

/* -------------------------------------------------------------------------- */
/*                                    Bills                                   */
/* -------------------------------------------------------------------------- */

describe('admin-store: bills CRUD (FR-49, FR-50 AC-50.3)', () => {
  it('creates a bill with a ULID PK and emits an audit row', async () => {
    const before = await listBills(d1);
    expect(before).toHaveLength(0);
    const row = await createBill(d1, ctx, {
      bill_id: '117-HR-2471',
      congress: 117,
      type: 'HR',
      number: '2471',
      title: 'Consolidated Appropriations Act, 2022',
      direction: 'pro-ukraine',
    });
    expect(isUlid(row.id)).toBe(true);
    expect(row.title).toBe('Consolidated Appropriations Act, 2022');
    expect(row.created_at).toMatch(/\d{4}-\d{2}-\d{2}T/);
    const audits = await listAudit(d1);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('create');
    expect(audits[0]!.target_table).toBe('bills');
    expect(audits[0]!.row_id).toBe(row.id);
    expect(audits[0]!.actor_email).toBe('alice@example.com');
    expect(audits[0]!.trace_id).toBe('tr_0123456789abcdef');
  });

  it('updates a bill and audits the before/after diff', async () => {
    const id = await seedBill();
    const updated = await updateBill(d1, ctx, id, { featured: true, label: 'flagship' });
    expect(updated.featured).toBe(1);
    expect(updated.label).toBe('flagship');
    const audits = await listAudit(d1);
    expect(audits).toHaveLength(2); // create + update
    const update = audits.find((a) => a.action === 'update')!;
    expect(update.target_table).toBe('bills');
    expect(update.row_id).toBe(id);
    expect(update.trace_id).toBe('tr_0123456789abcdef');
    const before = JSON.parse(update.before_json!) as { featured: number };
    const after = JSON.parse(update.after_json!) as { featured: number; label: string };
    expect(before.featured).toBe(0);
    expect(after.featured).toBe(1);
    expect(after.label).toBe('flagship');
  });

  it('deletes a bill and audits the deletion', async () => {
    const id = await seedBill();
    await deleteBill(d1, ctx, id);
    expect(await getBill(d1, id)).toBeNull();
    const audits = await listAudit(d1);
    const del = audits.find((a) => a.action === 'delete');
    expect(del).toBeDefined();
    expect(del!.before_json).toBeTruthy();
    expect(del!.after_json).toBeNull();
  });

  it('rejects an invalid direction with a ValidationError', async () => {
    await expect(
      createBill(d1, ctx, {
        bill_id: '999-X-1',
        congress: 999,
        type: 'X',
        number: '1',
        title: 't',
        direction: 'maybe-pro',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws when updating a missing bill', async () => {
    await expect(updateBill(d1, ctx, '01HQXXXXXXXXXXXXXXXXXXXXXX', { title: 'x' }))
      .rejects.toThrow(/not found/);
  });
});

/* -------------------------------------------------------------------------- */
/*                                    Votes                                   */
/* -------------------------------------------------------------------------- */

describe('admin-store: votes CRUD (FR-54 AC-54.1)', () => {
  it('creates a vote and ULIDs the PK', async () => {
    await seedBill();
    const row = await createVote(d1, ctx, {
      bill_id: '117-HR-2471',
      chamber: 'House',
      congress: 117,
      session: 2,
      roll_call: 65,
      date: '2022-03-10T02:49:07Z',
      weight: 0.9,
      direction_multiplier: 1,
      kind: 'concur',
    });
    expect(isUlid(row.id)).toBe(true);
    expect(row.weight).toBe(0.9);
    expect(row.direction_multiplier).toBe(1);
  });

  it('clamps negative weight to 0', async () => {
    await seedBill();
    const row = await createVote(d1, ctx, {
      bill_id: '117-HR-2471',
      chamber: 'House',
      congress: 117,
      session: 2,
      roll_call: 65,
      date: '2022-03-10',
      weight: -3,
      kind: 'concur',
    });
    expect(row.weight).toBe(0);
  });

  it('rejects weight > 5 (FR-54 AC-54.1)', async () => {
    await seedBill();
    await expect(
      createVote(d1, ctx, {
        bill_id: '117-HR-2471',
        chamber: 'House',
        congress: 117,
        session: 2,
        roll_call: 65,
        date: '2022-03-10',
        weight: 9,
        kind: 'concur',
      }),
    ).rejects.toThrow(/weight must be ≤ 5/);
  });

  it('rejects an invalid direction_multiplier', async () => {
    await seedBill();
    await expect(
      createVote(d1, ctx, {
        bill_id: '117-HR-2471',
        chamber: 'House',
        congress: 117,
        session: 2,
        roll_call: 65,
        date: '2022-03-10',
        weight: 1,
        direction_multiplier: 0.5,
        kind: 'concur',
      }),
    ).rejects.toThrow(/direction must be/i);
  });

  it('rejects an unknown bill_id (FK validation)', async () => {
    await expect(
      createVote(d1, ctx, {
        bill_id: 'NOT-A-BILL',
        chamber: 'House',
        congress: 117,
        session: 2,
        roll_call: 65,
        date: '2022-03-10',
        weight: 1,
        kind: 'concur',
      }),
    ).rejects.toThrow(/unknown bill_id/);
  });

  it('rejects an invalid chamber', async () => {
    await seedBill();
    await expect(
      createVote(d1, ctx, {
        bill_id: '117-HR-2471',
        chamber: 'Tribunal',
        congress: 117,
        session: 2,
        roll_call: 65,
        date: '2022-03-10',
        weight: 1,
        kind: 'concur',
      }),
    ).rejects.toThrow(/chamber/);
  });

  it('updates weight and audits the change', async () => {
    await seedBill();
    const v = await createVote(d1, ctx, {
      bill_id: '117-HR-2471',
      chamber: 'House',
      congress: 117,
      session: 2,
      roll_call: 65,
      date: '2022-03-10',
      weight: 0.9,
      kind: 'concur',
    });
    const updated = await updateVote(d1, ctx, v.id, { weight: 2.5 });
    expect(updated.weight).toBe(2.5);
    const audits = await listAudit(d1);
    const update = audits.find((a) => a.action === 'update' && a.target_table === 'votes');
    expect(update).toBeDefined();
    const before = JSON.parse(update!.before_json!) as { weight: number };
    const after = JSON.parse(update!.after_json!) as { weight: number };
    expect(before.weight).toBe(0.9);
    expect(after.weight).toBe(2.5);
  });
});

describe('admin-store: FR-63 vote direction review', () => {
  async function seedVote(direction?: 'pro' | 'anti' | 'neutral') {
    await seedBill();
    return createVote(d1, ctx, {
      bill_id: '117-HR-2471', chamber: 'House', congress: 117, session: 2,
      roll_call: 65, date: '2022-03-10', weight: 1, kind: 'passage',
      ...(direction ? { direction } : {}),
    });
  }

  it('createVote defaults direction to neutral and leaves it unreviewed', async () => {
    const row = await seedVote();
    expect(row.direction).toBe('neutral');
    expect(row.direction_reviewed_at).toBeNull();
    expect(row.direction_reviewed_by).toBeNull();
  });

  it('createVote honors an explicit direction', async () => {
    const row = await seedVote('pro');
    expect(row.direction).toBe('pro');
  });

  it('AC-63.6: updateVote with direction stamps reviewed_at/by from the actor', async () => {
    const row = await seedVote('neutral');
    const after = await updateVote(d1, ctx, row.id, { direction: 'anti' });
    expect(after.direction).toBe('anti');
    expect(after.direction_reviewed_by).toBe('alice@example.com');
    expect(after.direction_reviewed_at).not.toBeNull();
  });

  it('updateVote without direction does NOT stamp review fields', async () => {
    const row = await seedVote('pro');
    const after = await updateVote(d1, ctx, row.id, { weight: 0.5 });
    expect(after.direction).toBe('pro');
    expect(after.direction_reviewed_at).toBeNull();
  });

  it('rejects an invalid vote direction', async () => {
    const row = await seedVote('pro');
    await expect(
      updateVote(d1, ctx, row.id, { direction: 'bogus' as 'pro' }),
    ).rejects.toThrow(/direction/i);
  });
});

/* -------------------------------------------------------------------------- */
/*                              Atomicity (AC-50.3)                           */
/* -------------------------------------------------------------------------- */

describe('admin-store: mutation+audit atomicity (FR-50 AC-50.3)', () => {
  it('rolls back the row insert when the audit insert fails', async () => {
    d1.failNextAuditInsert = true;
    await expect(
      createBill(d1, ctx, {
        bill_id: '999-X-1',
        congress: 999,
        type: 'X',
        number: '1',
        title: 'should be rolled back',
        direction: 'pro-ukraine',
      }),
    ).rejects.toThrow();
    // The bill row should NOT exist — batch rolled back.
    const bills = await listBills(d1);
    expect(bills).toHaveLength(0);
    // Audit log also empty.
    const audits = await listAudit(d1);
    expect(audits).toHaveLength(0);
  });

  it('runs ensure-researcher + mutation + audit as a 3-statement batch', async () => {
    // Updated post-FR-50: every mutation also INSERT…ON CONFLICT DO NOTHING
    // upserts the actor into `researchers` to satisfy the audit_log FK on
    // first-write of a brand-new admin user.
    await seedBill();
    expect(d1.lastBatchSize).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/*                              Comments / posts / quotes                     */
/* -------------------------------------------------------------------------- */

describe('admin-store: comments / social posts / quotes', () => {
  it('creates a comment with a known bill_id and stamps author from ctx', async () => {
    await seedBill();
    const c = await createComment(d1, ctx, {
      bill_id: '117-HR-2471',
      body_markdown: 'Floor speech ignored the procedural maneuver.',
      weight: 0.25,
      direction: -1,
    });
    expect(c.author_email).toBe('alice@example.com');
    expect(c.weight).toBe(0.25);
    expect(c.direction).toBe(-1);
    expect(c.attached_to_roll_call_id).toBeNull();
  });

  it('rejects a comment for an unknown bill_id', async () => {
    await expect(
      createComment(d1, ctx, {
        bill_id: 'NOT-A-BILL',
        body_markdown: 'orphan',
      }),
    ).rejects.toThrow(/unknown bill_id/);
  });

  it('rejects a social post with an invalid platform', async () => {
    await expect(
      createSocialPost(d1, ctx, {
        bioguide_id: 'D000563',
        platform: 'mastodon',
        url: 'https://example.com',
        body_text: 'hi',
      }),
    ).rejects.toThrow(/platform/);
  });

  it('rejects a quote with an invalid media_kind', async () => {
    await expect(
      createQuote(d1, ctx, {
        bioguide_id: 'D000563',
        media_kind: 'novel',
        source_url: 'https://example.com',
        body_text: 'long-form',
      }),
    ).rejects.toThrow(/media_kind/);
  });

  it('creates a quote and audits with trace_id', async () => {
    const q = await createQuote(d1, ctx, {
      bioguide_id: 'D000563',
      media_kind: 'video',
      source_url: 'https://www.c-span.org/video/?123',
      body_text: 'I support Ukraine.',
      weight: 0.5,
      direction: 1,
    });
    expect(q.media_kind).toBe('video');
    const audits = await listAudit(d1);
    const qa = audits.find((a) => a.target_table === 'quotes');
    expect(qa).toBeDefined();
    expect(qa!.trace_id).toBe('tr_0123456789abcdef');
  });
});

/* -------------------------------------------------------------------------- */
/*           Audit-log change-notes (reason) — FR-50 AC-50.8 / AC-58.6        */
/* -------------------------------------------------------------------------- */

describe('admin-store: audit_log.reason flows from MutationContext (FR-50 AC-50.8)', () => {
  it('persists ctx.reason into audit_log.reason on create', async () => {
    const ctxWithReason: MutationContext = {
      ...ctx,
      reason: 'seed for V4 demo flow',
    };
    await createBill(d1, ctxWithReason, {
      bill_id: '117-HR-2471',
      congress: 117,
      type: 'HR',
      number: '2471',
      title: 'Consolidated Appropriations Act, 2022',
      direction: 'pro-ukraine',
    });
    const audits = await listAudit(d1);
    const created = audits.find((a) => a.action === 'create' && a.target_table === 'bills');
    expect(created).toBeDefined();
    expect(created!.reason).toBe('seed for V4 demo flow');
  });

  it('persists ctx.reason on update', async () => {
    const id = await seedBill();
    await updateBill(
      d1,
      { ...ctx, reason: 'flag as featured per ranking review' },
      id,
      { featured: true },
    );
    const audits = await listAudit(d1);
    const update = audits.find((a) => a.action === 'update' && a.target_table === 'bills');
    expect(update).toBeDefined();
    expect(update!.reason).toBe('flag as featured per ranking review');
  });

  it('persists ctx.reason on delete', async () => {
    const id = await seedBill();
    await deleteBill(d1, { ...ctx, reason: 'duplicate of 118-HR-815' }, id);
    const audits = await listAudit(d1);
    const del = audits.find((a) => a.action === 'delete' && a.target_table === 'bills');
    expect(del).toBeDefined();
    expect(del!.reason).toBe('duplicate of 118-HR-815');
  });

  it('writes audit_log.reason as null when ctx.reason is absent (create path)', async () => {
    await createBill(d1, ctx, {
      bill_id: '117-HR-2471',
      congress: 117,
      type: 'HR',
      number: '2471',
      title: 't',
      direction: 'pro-ukraine',
    });
    const audits = await listAudit(d1);
    const created = audits[0]!;
    expect(created.reason).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*               Standing rationale on votes — FR-54 AC-54.6                  */
/* -------------------------------------------------------------------------- */

describe('admin-store: votes.weight_reason (FR-54 AC-54.6)', () => {
  it('createVote persists weight_reason when supplied', async () => {
    await seedBill();
    const v = await createVote(d1, ctx, {
      bill_id: '117-HR-2471',
      chamber: 'House',
      congress: 117,
      session: 2,
      roll_call: 65,
      date: '2022-03-10',
      weight: 2.5,
      direction_multiplier: 1,
      kind: 'concur',
      weight_reason:
        'Bumped from 0.9 → 2.5: this concurrence vote was the deciding moment of the supplemental.',
    });
    expect(v.weight_reason).toMatch(/Bumped from 0\.9/);
  });

  it('createVote stores null when weight_reason is omitted', async () => {
    await seedBill();
    const v = await createVote(d1, ctx, {
      bill_id: '117-HR-2471',
      chamber: 'House',
      congress: 117,
      session: 2,
      roll_call: 65,
      date: '2022-03-10',
      weight: 0.9,
      kind: 'concur',
    });
    expect(v.weight_reason).toBeNull();
  });

  it('updateVote can change weight_reason without touching weight', async () => {
    await seedBill();
    const v = await createVote(d1, ctx, {
      bill_id: '117-HR-2471',
      chamber: 'House',
      congress: 117,
      session: 2,
      roll_call: 65,
      date: '2022-03-10',
      weight: 0.9,
      kind: 'concur',
      weight_reason: 'initial weight from kind=concur default',
    });
    const updated = await updateVote(d1, ctx, v.id, {
      weight_reason: 'Reviewed Apr 2026: matches clerk record.',
    });
    expect(updated.weight).toBe(0.9);
    expect(updated.weight_reason).toMatch(/Reviewed Apr 2026/);
  });

  it('weight_reason is included in the audit before/after diff (AC-54.5)', async () => {
    await seedBill();
    const v = await createVote(d1, ctx, {
      bill_id: '117-HR-2471',
      chamber: 'House',
      congress: 117,
      session: 2,
      roll_call: 65,
      date: '2022-03-10',
      weight: 0.9,
      kind: 'concur',
      weight_reason: 'a',
    });
    await updateVote(d1, ctx, v.id, { weight_reason: 'b' });
    const audits = await listAudit(d1);
    const update = audits.find(
      (x) => x.action === 'update' && x.target_table === 'votes',
    );
    expect(update).toBeDefined();
    const before = JSON.parse(update!.before_json!) as { weight_reason: string };
    const after = JSON.parse(update!.after_json!) as { weight_reason: string };
    expect(before.weight_reason).toBe('a');
    expect(after.weight_reason).toBe('b');
  });
});
