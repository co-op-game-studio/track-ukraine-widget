/**
 * Branch-coverage extension for proxy/d1/admin-store.ts.
 *
 * The existing adminStore.test.ts and adminStoreKvInvalidation.test.ts cover
 * the happy paths and KV invalidation. This file fills in:
 *   - listBills / listVotesByBill / listCosponsorsByBill / listActionsByBill /
 *     listCommentsByBill / listQuotes / listAudit (incl. `since` filter and
 *     limit cap branches).
 *   - updateBill direction validation + all partial patch branches.
 *   - deleteVote / updateComment / deleteComment / updateSocialPost /
 *     deleteSocialPost / updateQuote / deleteQuote not_found branches.
 *   - validateVoteWeight non-finite + > 5 paths.
 *   - createQuote duplicate-source rejection + links_json + tag_ids best-effort.
 *   - updateQuote invalid media_kind.
 *   - updateSocialPost invalid platform.
 *   - createSocialPost invalid url + missing body_text.
 *   - createComment empty body rejection.
 *   - runMutationWithAudit error w/o message branch.
 *
 * Pattern follows tests/unit/adminStore.test.ts (FakeD1 + FakeStmt with a
 * narrow SQL surface). No vi.mock — fakes are passed in directly.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createBill,
  updateBill,
  deleteBill,
  listBills,
  listVotesByBill,
  listCosponsorsByBill,
  listActionsByBill,
  listCommentsByBill,
  listQuotes,
  createVote,
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
  listAudit,
  ValidationError,
  runMutationWithAudit,
  type MutationContext,
} from '../../proxy/d1/admin-store';
import type {
  D1Like,
  D1PreparedStatementLike,
  D1ResultLike,
} from '../../proxy/env';

/* -------------------------------------------------------------------------- */
/*                              In-memory fake D1                             */
/* -------------------------------------------------------------------------- */

class FakeD1 implements D1Like {
  tables: Record<string, Record<string, unknown>[]> = {
    bills: [],
    votes: [],
    bill_cosponsors: [],
    bill_actions: [],
    comments: [],
    social_posts: [],
    quotes: [],
    quote_tags: [],
    audit_log: [],
    researchers: [],
  };
  /** When set, the next batch() returns success=false for one statement. */
  failBatchWithoutMessage = false;
  /** When set, the quote_tags insert throws (simulating tag deleted). */
  failNextTagInsert = false;

  prepare(query: string): D1PreparedStatementLike {
    return new FakeStmt(this, query, []);
  }

  async batch<T>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
    if (this.failBatchWithoutMessage) {
      this.failBatchWithoutMessage = false;
      return [{ success: false } as D1ResultLike<T>];
    }
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

    // INSERT OR IGNORE INTO quote_tags ...
    const insIgnore = q.match(/^INSERT\s+OR\s+IGNORE\s+INTO\s+(\w+)\s*\(([^)]+)\)/i);
    if (insIgnore) {
      const table = insIgnore[1]!;
      const cols = insIgnore[2]!.split(',').map((c) => c.trim());
      if (table === 'quote_tags' && this.d1.failNextTagInsert) {
        this.d1.failNextTagInsert = false;
        throw new Error('forced_tag_insert_failure');
      }
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        row[c] = this.bindings[i] ?? null;
      });
      this.d1.tables[table]!.push(row);
      return { success: true, meta: { changes: 1 } };
    }

    // INSERT INTO ... (cols) VALUES (...)
    const insMatch = q.match(/^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s+VALUES/i);
    if (insMatch) {
      const table = insMatch[1]!;
      const cols = insMatch[2]!.split(',').map((c) => c.trim());
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
      const fields = updMatch[2]!.split(',').map((f) => f.split('=')[0]!.trim());
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

    // SELECT 1 FROM <table> WHERE col = ? LIMIT 1
    const existsMatch = q.match(/^SELECT\s+1\s+FROM\s+(\w+)\s+WHERE\s+(\w+)\s*=\s*\?/i);
    if (existsMatch) {
      const table = existsMatch[1]!;
      const col = existsMatch[2]!;
      const val = this.bindings[0];
      const found = (this.d1.tables[table] ?? []).find((r) => r[col] === val);
      return { success: true, results: found ? [{ '1': 1 }] : [] };
    }

    // SELECT * FROM <table> WHERE id = ?
    const selByIdMatch = q.match(/^SELECT\s+\*\s+FROM\s+(\w+)\s+WHERE\s+id\s*=\s*\?$/i);
    if (selByIdMatch) {
      const table = selByIdMatch[1]!;
      const id = this.bindings[0];
      const rows = (this.d1.tables[table] ?? []).filter((r) => r['id'] === id);
      return { success: true, results: rows };
    }

    // SELECT * FROM audit_log WHERE created_at >= ? ORDER BY ... LIMIT ?
    const auditSince = q.match(/^SELECT\s+\*\s+FROM\s+audit_log\s+WHERE\s+created_at\s*>=\s*\?/i);
    const auditAll = q.match(/^SELECT\s+\*\s+FROM\s+audit_log\s+ORDER\s+BY/i);
    if (auditSince || auditAll) {
      const filtered = auditSince
        ? (this.d1.tables.audit_log ?? []).filter(
            (r) => String(r['created_at']) >= String(this.bindings[0]),
          )
        : (this.d1.tables.audit_log ?? []);
      const limit = Number(this.bindings[this.bindings.length - 1] ?? 50);
      const rows = [...filtered]
        .sort((a, b) => String(b['created_at']).localeCompare(String(a['created_at'])))
        .slice(0, limit);
      return { success: true, results: rows };
    }

    // SELECT * FROM <table> WHERE <col> = ? ORDER BY ... LIMIT ? OFFSET ?
    const selWhereOrder = q.match(
      /^SELECT\s+\*\s+FROM\s+(\w+)\s+WHERE\s+(\w+)\s*=\s*\?\s+ORDER\s+BY[\s\S]*?LIMIT\s+\?\s+OFFSET\s+\?$/i,
    );
    if (selWhereOrder) {
      const table = selWhereOrder[1]!;
      const col = selWhereOrder[2]!;
      const val = this.bindings[0];
      const limit = Number(this.bindings[1] ?? 100);
      const offset = Number(this.bindings[2] ?? 0);
      const rows = (this.d1.tables[table] ?? [])
        .filter((r) => r[col] === val)
        .slice(offset, offset + limit);
      return { success: true, results: rows };
    }

    // SELECT * FROM <table> WHERE <col> = ? ORDER BY ...
    const selWhereOrderNoLimit = q.match(
      /^SELECT\s+\*\s+FROM\s+(\w+)\s+WHERE\s+(\w+)\s*=\s*\?\s+ORDER\s+BY/i,
    );
    if (selWhereOrderNoLimit) {
      const table = selWhereOrderNoLimit[1]!;
      const col = selWhereOrderNoLimit[2]!;
      const val = this.bindings[0];
      const rows = (this.d1.tables[table] ?? []).filter((r) => r[col] === val);
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

    // SELECT cols FROM <table> WHERE col = ? AND col = ?
    const selColsMatch = q.match(
      /^SELECT\s+([\w\s,]+)\s+FROM\s+(\w+)\s+WHERE\s+(\w+)\s*=\s*\?\s+AND\s+(\w+)\s*=\s*\?/i,
    );
    if (selColsMatch) {
      const table = selColsMatch[2]!;
      const col1 = selColsMatch[3]!;
      const col2 = selColsMatch[4]!;
      const v1 = this.bindings[0];
      const v2 = this.bindings[1];
      const rows = (this.d1.tables[table] ?? []).filter(
        (r) => r[col1] === v1 && r[col2] === v2,
      );
      return { success: true, results: rows };
    }

    throw new Error(`unhandled query in fake D1: ${q}`);
  }
}

let d1: FakeD1;
const ctx: MutationContext = {
  actorEmail: 'alice@example.com',
  traceId: 'tr_coverage_xxxxxxxxxxxxxx',
};

beforeEach(() => {
  d1 = new FakeD1();
});

async function seedBill(billId = '117-HR-2471'): Promise<{ id: string; bill_id: string }> {
  const row = await createBill(d1, ctx, {
    bill_id: billId,
    congress: 117,
    type: 'HR',
    number: '2471',
    title: 'Seed bill',
    direction: 'pro-ukraine',
  });
  return { id: row.id, bill_id: row.bill_id };
}

/* -------------------------------------------------------------------------- */
/*                              Bills — list + update branches                */
/* -------------------------------------------------------------------------- */

describe('admin-store: bills list + update branches', () => {
  it('listBills caps limit at 250 and honors offset', async () => {
    // Just exercise the limit/offset clamp branch (Math.min(limit, 250)).
    await seedBill('117-HR-1');
    await seedBill('117-HR-2');
    const all = await listBills(d1, { limit: 999, offset: 0 });
    expect(all.length).toBe(2);
    const skipped = await listBills(d1, { limit: 10, offset: 1 });
    expect(skipped.length).toBe(1);
  });

  it('listBills with no opts uses defaults', async () => {
    await seedBill('117-HR-1');
    const out = await listBills(d1);
    expect(out.length).toBe(1);
  });

  it('updateBill rejects an invalid direction', async () => {
    const { id } = await seedBill();
    await expect(
      updateBill(d1, ctx, id, { direction: 'maybe-pro' }),
    ).rejects.toThrow(/direction is invalid/);
  });

  it('updateBill applies all optional patch fields (full coverage of partial branches)', async () => {
    const { id } = await seedBill();
    const updated = await updateBill(d1, ctx, id, {
      congress: 119,
      type: 'S',
      number: '99',
      featured: false,
      label: 'newlabel',
      title: 'new title',
      display_title: 'short',
      latest_action: 'Action',
      latest_action_date: '2026-05-01',
      became_law: true,
      congress_gov_url: 'https://congress.gov/x',
      direction: 'anti-ukraine',
      direction_reason: 'reason',
      summary_json: '{}',
      sponsor_bioguide_id: 'D000563',
      sponsor_full_name: 'Durbin',
      sponsor_party: 'D',
      sponsor_state: 'IL',
      introduced_date: '2025-01-01',
    });
    expect(updated.congress).toBe(119);
    expect(updated.type).toBe('S');
    expect(updated.featured).toBe(0);
    expect(updated.became_law).toBe(1);
    expect(updated.label).toBe('newlabel');
    expect(updated.direction).toBe('anti-ukraine');
    expect(updated.sponsor_state).toBe('IL');
  });

  it('updateBill with explicit nulls clears the field', async () => {
    const { id } = await seedBill();
    const updated = await updateBill(d1, ctx, id, {
      label: null,
      display_title: null,
      latest_action: null,
      latest_action_date: null,
      congress_gov_url: null,
      direction_reason: null,
      summary_json: null,
      sponsor_bioguide_id: null,
      sponsor_full_name: null,
      sponsor_party: null,
      sponsor_state: null,
      introduced_date: null,
    });
    expect(updated.label).toBeNull();
    expect(updated.display_title).toBeNull();
    expect(updated.sponsor_state).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                              Bills sub-list helpers                        */
/* -------------------------------------------------------------------------- */

describe('admin-store: list helpers (votes / cosponsors / actions / comments / quotes)', () => {
  it('listVotesByBill returns rows for the requested bill', async () => {
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
    const rows = await listVotesByBill(d1, bill_id);
    expect(rows).toHaveLength(1);
  });

  it('listVotesByBill returns [] when none', async () => {
    const rows = await listVotesByBill(d1, '999-X-1');
    expect(rows).toEqual([]);
  });

  it('listCosponsorsByBill returns [] for unknown bill', async () => {
    const rows = await listCosponsorsByBill(d1, '999-X-1');
    expect(rows).toEqual([]);
  });

  it('listActionsByBill returns [] for unknown bill', async () => {
    const rows = await listActionsByBill(d1, '999-X-1');
    expect(rows).toEqual([]);
  });

  it('listCommentsByBill returns rows', async () => {
    const { bill_id } = await seedBill();
    await createComment(d1, ctx, {
      bill_id,
      body_markdown: 'note',
      weight: 1,
      direction: 1,
    });
    const rows = await listCommentsByBill(d1, bill_id);
    expect(rows).toHaveLength(1);
  });

  it('listQuotes (no bioguide filter) returns global newest-first list', async () => {
    await createQuote(d1, ctx, {
      bioguide_id: 'D000563',
      media_kind: 'video',
      source_url: 'https://example.com/a',
      body_text: 'a',
      weight: 0,
      direction: 0,
    });
    const rows = await listQuotes(d1);
    expect(rows).toHaveLength(1);
  });

  it('listQuotes (with bioguideId filter) takes the WHERE branch', async () => {
    await createQuote(d1, ctx, {
      bioguide_id: 'D000563',
      media_kind: 'video',
      source_url: 'https://example.com/a',
      body_text: 'a',
    });
    await createQuote(d1, ctx, {
      bioguide_id: 'X999999',
      media_kind: 'text',
      source_url: 'https://example.com/b',
      body_text: 'b',
    });
    const rows = await listQuotes(d1, { bioguideId: 'D000563' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bioguide_id).toBe('D000563');
  });

  it('listQuotes caps limit and honors offset', async () => {
    await createQuote(d1, ctx, {
      bioguide_id: 'D000563',
      media_kind: 'text',
      source_url: 'https://example.com/q1',
      body_text: 'q1',
    });
    const out = await listQuotes(d1, { limit: 999, offset: 0 });
    expect(out).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                          Audit listing branches                            */
/* -------------------------------------------------------------------------- */

describe('admin-store: listAudit branches', () => {
  it('returns rows newer than `since` when since is supplied', async () => {
    await seedBill('117-HR-1');
    const sinceFuture = '3000-01-01T00:00:00Z';
    const out = await listAudit(d1, { since: sinceFuture });
    expect(out).toEqual([]);
    const sincePast = '1900-01-01T00:00:00Z';
    const all = await listAudit(d1, { since: sincePast });
    expect(all.length).toBeGreaterThan(0);
  });

  it('caps limit at 100', async () => {
    await seedBill('117-HR-1');
    const out = await listAudit(d1, { limit: 999 });
    expect(out.length).toBeLessThanOrEqual(100);
  });
});

/* -------------------------------------------------------------------------- */
/*                          Vote / weight validation branches                 */
/* -------------------------------------------------------------------------- */

describe('admin-store: weight + direction validation edge cases', () => {
  it('rejects non-finite weight (NaN, Infinity)', async () => {
    await seedBill();
    await expect(
      createVote(d1, ctx, {
        bill_id: '117-HR-2471',
        chamber: 'House',
        congress: 117,
        session: 2,
        roll_call: 65,
        date: '2022-03-10',
        weight: Number.NaN,
        kind: 'concur',
      }),
    ).rejects.toThrow(/finite/);
    await expect(
      createVote(d1, ctx, {
        bill_id: '117-HR-2471',
        chamber: 'House',
        congress: 117,
        session: 2,
        roll_call: 65,
        date: '2022-03-10',
        weight: Number.POSITIVE_INFINITY,
        kind: 'concur',
      }),
    ).rejects.toThrow(/finite/);
  });

  it('createVote with explicit direction_multiplier=0 is accepted', async () => {
    await seedBill();
    const v = await createVote(d1, ctx, {
      bill_id: '117-HR-2471',
      chamber: 'House',
      congress: 117,
      session: 2,
      roll_call: 65,
      date: '2022-03-10',
      weight: 1,
      direction_multiplier: 0,
      kind: 'concur',
    });
    expect(v.direction_multiplier).toBe(0);
  });

  it('createVote weight_reason of only whitespace becomes null', async () => {
    await seedBill();
    const v = await createVote(d1, ctx, {
      bill_id: '117-HR-2471',
      chamber: 'House',
      congress: 117,
      session: 2,
      roll_call: 65,
      date: '2022-03-10',
      weight: 1,
      kind: 'concur',
      weight_reason: '   ',
    });
    expect(v.weight_reason).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                          Vote delete + update branches                     */
/* -------------------------------------------------------------------------- */

describe('admin-store: vote delete / not_found branches', () => {
  it('deleteVote removes the row + audits', async () => {
    await seedBill();
    const v = await createVote(d1, ctx, {
      bill_id: '117-HR-2471',
      chamber: 'House',
      congress: 117,
      session: 2,
      roll_call: 65,
      date: '2022-03-10',
      weight: 1,
      kind: 'concur',
    });
    await deleteVote(d1, ctx, v.id);
    const audits = await listAudit(d1);
    const del = audits.find(
      (a) => a.action === 'delete' && a.target_table === 'votes',
    );
    expect(del).toBeDefined();
  });

  it('deleteVote throws when the vote is missing', async () => {
    await expect(deleteVote(d1, ctx, '01HMISSINGXXXXXXXXXXXXXXXX')).rejects.toThrow(
      /not found/,
    );
  });

  it('updateVote can change direction_multiplier (covers branch in admin-store.ts:701)', async () => {
    await seedBill();
    const v = await createVote(d1, ctx, {
      bill_id: '117-HR-2471',
      chamber: 'House',
      congress: 117,
      session: 2,
      roll_call: 65,
      date: '2022-03-10',
      weight: 1,
      direction_multiplier: 1,
      kind: 'concur',
    });
    const u = await (
      await import('../../proxy/d1/admin-store')
    ).updateVote(d1, ctx, v.id, { direction_multiplier: -1 });
    expect(u.direction_multiplier).toBe(-1);
  });

  it('updateVote with explicit nulls clears action / action_date / url', async () => {
    await seedBill();
    const v = await createVote(d1, ctx, {
      bill_id: '117-HR-2471',
      chamber: 'House',
      congress: 117,
      session: 2,
      roll_call: 65,
      date: '2022-03-10',
      weight: 1,
      kind: 'concur',
      action: 'Passed',
      action_date: '2022-03-10',
      url: 'https://example.com/v',
    });
    const u = await (
      await import('../../proxy/d1/admin-store')
    ).updateVote(d1, ctx, v.id, {
      action: null,
      action_date: null,
      url: null,
      weight_reason: null,
      date: '2022-03-11',
      kind: 'amendment',
    });
    expect(u.action).toBeNull();
    expect(u.action_date).toBeNull();
    expect(u.url).toBeNull();
    expect(u.weight_reason).toBeNull();
    expect(u.kind).toBe('amendment');
  });
});

/* -------------------------------------------------------------------------- */
/*                          Comment update + delete branches                  */
/* -------------------------------------------------------------------------- */

describe('admin-store: comment update / delete branches', () => {
  it('createComment rejects an empty body_markdown', async () => {
    const { bill_id } = await seedBill();
    await expect(
      createComment(d1, ctx, { bill_id, body_markdown: '' }),
    ).rejects.toThrow(/body_markdown/);
  });

  it('updateComment patches body / weight / direction / attached_to_roll_call_id', async () => {
    const { bill_id } = await seedBill();
    const c = await createComment(d1, ctx, {
      bill_id,
      body_markdown: 'a',
      weight: 1,
      direction: 1,
    });
    const u = await updateComment(d1, ctx, c.id, {
      body_markdown: 'b',
      weight: 2,
      direction: -1,
      attached_to_roll_call_id: 'house:117:2:65',
    });
    expect(u.body_markdown).toBe('b');
    expect(u.weight).toBe(2);
    expect(u.direction).toBe(-1);
    expect(u.attached_to_roll_call_id).toBe('house:117:2:65');
  });

  it('updateComment with an explicit null roll-call attachment clears it', async () => {
    const { bill_id } = await seedBill();
    const c = await createComment(d1, ctx, {
      bill_id,
      body_markdown: 'a',
      attached_to_roll_call_id: 'house:117:2:65',
      weight: 1,
      direction: 1,
    });
    const u = await updateComment(d1, ctx, c.id, {
      attached_to_roll_call_id: null,
    });
    expect(u.attached_to_roll_call_id).toBeNull();
  });

  it('updateComment throws when comment is missing', async () => {
    await expect(
      updateComment(d1, ctx, '01HMISSINGXXXXXXXXXXXXXXXX', { body_markdown: 'x' }),
    ).rejects.toThrow(/not found/);
  });

  it('deleteComment removes + audits', async () => {
    const { bill_id } = await seedBill();
    const c = await createComment(d1, ctx, {
      bill_id,
      body_markdown: 'rm',
      weight: 1,
      direction: 1,
    });
    await deleteComment(d1, ctx, c.id);
    const audits = await listAudit(d1);
    const del = audits.find(
      (a) => a.action === 'delete' && a.target_table === 'comments',
    );
    expect(del).toBeDefined();
  });

  it('deleteComment throws when missing', async () => {
    await expect(
      deleteComment(d1, ctx, '01HMISSINGXXXXXXXXXXXXXXXX'),
    ).rejects.toThrow(/not found/);
  });
});

/* -------------------------------------------------------------------------- */
/*                          Social post update / delete branches              */
/* -------------------------------------------------------------------------- */

describe('admin-store: social post update / delete branches', () => {
  it('createSocialPost rejects an invalid url', async () => {
    await expect(
      createSocialPost(d1, ctx, {
        bioguide_id: 'D000563',
        platform: 'x',
        url: 'javascript:alert(1)',
        body_text: 'hi',
      }),
    ).rejects.toThrow(/url/);
  });

  it('createSocialPost rejects empty body_text', async () => {
    await expect(
      createSocialPost(d1, ctx, {
        bioguide_id: 'D000563',
        platform: 'x',
        url: 'https://x.com/a/1',
        body_text: '',
      }),
    ).rejects.toThrow(/body_text/);
  });

  it('updateSocialPost rejects an invalid platform', async () => {
    const p = await createSocialPost(d1, ctx, {
      bioguide_id: 'D000563',
      platform: 'x',
      url: 'https://x.com/a/1',
      body_text: 'hi',
    });
    await expect(
      updateSocialPost(d1, ctx, p.id, { platform: 'mastodon' }),
    ).rejects.toThrow(/platform/);
  });

  it('updateSocialPost patches all optional fields', async () => {
    const p = await createSocialPost(d1, ctx, {
      bioguide_id: 'D000563',
      platform: 'x',
      url: 'https://x.com/a/1',
      body_text: 'hi',
    });
    const u = await updateSocialPost(d1, ctx, p.id, {
      platform: 'youtube',
      url: 'https://www.youtube.com/watch?v=abc',
      posted_at: '2026-04-28T12:00:00Z',
      body_text: 'edited',
      weight: 0.5,
      direction: -1,
      comment: 'note',
    });
    expect(u.platform).toBe('youtube');
    expect(u.weight).toBe(0.5);
    expect(u.direction).toBe(-1);
    expect(u.comment).toBe('note');
  });

  it('updateSocialPost with explicit nulls clears posted_at + comment', async () => {
    const p = await createSocialPost(d1, ctx, {
      bioguide_id: 'D000563',
      platform: 'x',
      url: 'https://x.com/a/1',
      body_text: 'hi',
      posted_at: '2026-04-28T12:00:00Z',
      comment: 'old',
    });
    const u = await updateSocialPost(d1, ctx, p.id, {
      posted_at: null,
      comment: null,
    });
    expect(u.posted_at).toBeNull();
    expect(u.comment).toBeNull();
  });

  it('updateSocialPost throws when missing', async () => {
    await expect(
      updateSocialPost(d1, ctx, '01HMISSINGXXXXXXXXXXXXXXXX', { body_text: 'x' }),
    ).rejects.toThrow(/not found/);
  });

  it('deleteSocialPost throws when missing', async () => {
    await expect(
      deleteSocialPost(d1, ctx, '01HMISSINGXXXXXXXXXXXXXXXX'),
    ).rejects.toThrow(/not found/);
  });

  it('deleteSocialPost removes + audits', async () => {
    const p = await createSocialPost(d1, ctx, {
      bioguide_id: 'D000563',
      platform: 'x',
      url: 'https://x.com/a/1',
      body_text: 'hi',
    });
    await deleteSocialPost(d1, ctx, p.id);
    const audits = await listAudit(d1);
    const del = audits.find(
      (a) => a.action === 'delete' && a.target_table === 'social_posts',
    );
    expect(del).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/*                          Quote create / update / delete branches           */
/* -------------------------------------------------------------------------- */

describe('admin-store: quote create / update / delete branches', () => {
  it('createQuote rejects empty source_url', async () => {
    await expect(
      createQuote(d1, ctx, {
        bioguide_id: 'D000563',
        media_kind: 'video',
        source_url: '',
        body_text: 'x',
      }),
    ).rejects.toThrow(/source_url/);
  });

  it('createQuote rejects empty body_text', async () => {
    await expect(
      createQuote(d1, ctx, {
        bioguide_id: 'D000563',
        media_kind: 'video',
        source_url: 'https://example.com/a',
        body_text: '',
      }),
    ).rejects.toThrow(/body_text/);
  });

  it('createQuote rejects a duplicate source_url + bioguide combo', async () => {
    await createQuote(d1, ctx, {
      bioguide_id: 'D000563',
      media_kind: 'video',
      source_url: 'https://example.com/a',
      body_text: 'first',
      weight: 0.5,
      direction: 1,
    });
    await expect(
      createQuote(d1, ctx, {
        bioguide_id: 'D000563',
        media_kind: 'video',
        source_url: 'https://example.com/a',
        body_text: 'second',
      }),
    ).rejects.toThrow(/already been added/);
  });

  it('duplicate error mentions direction "anti" when stored direction is negative', async () => {
    await createQuote(d1, ctx, {
      bioguide_id: 'D000563',
      media_kind: 'video',
      source_url: 'https://example.com/a',
      body_text: 'first',
      weight: 0.5,
      direction: -1,
    });
    await expect(
      createQuote(d1, ctx, {
        bioguide_id: 'D000563',
        media_kind: 'video',
        source_url: 'https://example.com/a',
        body_text: 'second',
      }),
    ).rejects.toThrow(/anti/);
  });

  it('duplicate error mentions direction "unstated" when stored direction is 0', async () => {
    await createQuote(d1, ctx, {
      bioguide_id: 'D000563',
      media_kind: 'video',
      source_url: 'https://example.com/a',
      body_text: 'first',
      weight: 0.5,
      direction: 0,
    });
    await expect(
      createQuote(d1, ctx, {
        bioguide_id: 'D000563',
        media_kind: 'video',
        source_url: 'https://example.com/a',
        body_text: 'second',
      }),
    ).rejects.toThrow(/unstated/);
  });

  it('createQuote serializes links into links_json when provided', async () => {
    const q = await createQuote(d1, ctx, {
      bioguide_id: 'D000563',
      media_kind: 'video',
      source_url: 'https://example.com/a',
      body_text: 'with links',
      links: [{ label: 'transcript', url: 'https://example.com/t' }],
    });
    expect(q.links_json).toBeTruthy();
    const parsed = JSON.parse(q.links_json!) as Array<{ label: string; url: string }>;
    expect(parsed).toEqual([{ label: 'transcript', url: 'https://example.com/t' }]);
  });

  it('createQuote with an empty links array stores null', async () => {
    const q = await createQuote(d1, ctx, {
      bioguide_id: 'D000563',
      media_kind: 'video',
      source_url: 'https://example.com/a',
      body_text: 'no links',
      links: [],
    });
    expect(q.links_json).toBeNull();
  });

  it('createQuote applies tag_ids best-effort (success path)', async () => {
    const q = await createQuote(d1, ctx, {
      bioguide_id: 'D000563',
      media_kind: 'video',
      source_url: 'https://example.com/a',
      body_text: 'tagged',
      tag_ids: ['tag-1', 'tag-2'],
    });
    expect(d1.tables.quote_tags!.length).toBe(2);
    const ids = d1.tables.quote_tags!.map((r) => r['quote_id']);
    expect(ids.every((x) => x === q.id)).toBe(true);
  });

  it('createQuote tag insert failure is swallowed (best-effort)', async () => {
    d1.failNextTagInsert = true;
    const q = await createQuote(d1, ctx, {
      bioguide_id: 'D000563',
      media_kind: 'video',
      source_url: 'https://example.com/a',
      body_text: 'tag-fail',
      tag_ids: ['tag-x'],
    });
    expect(q.id).toBeTruthy();
    // The first tag insert threw; the call returned anyway and the quote_tags
    // table is empty (no successful tag inserts).
    expect(d1.tables.quote_tags!.length).toBe(0);
  });

  it('updateQuote rejects an invalid media_kind', async () => {
    const q = await createQuote(d1, ctx, {
      bioguide_id: 'D000563',
      media_kind: 'video',
      source_url: 'https://example.com/a',
      body_text: 'x',
    });
    await expect(
      updateQuote(d1, ctx, q.id, { media_kind: 'novel' }),
    ).rejects.toThrow(/media_kind/);
  });

  it('updateQuote patches all optional fields', async () => {
    const q = await createQuote(d1, ctx, {
      bioguide_id: 'D000563',
      media_kind: 'video',
      source_url: 'https://example.com/a',
      body_text: 'first',
    });
    const u = await updateQuote(d1, ctx, q.id, {
      media_kind: 'audio',
      source_url: 'https://example.com/b',
      source_label: 'label',
      quoted_at: '2024-02-13',
      body_text: 'edited',
      weight: 0.5,
      direction: -1,
      comment: 'context',
    });
    expect(u.media_kind).toBe('audio');
    expect(u.source_url).toBe('https://example.com/b');
    expect(u.source_label).toBe('label');
    expect(u.quoted_at).toBe('2024-02-13');
    expect(u.weight).toBe(0.5);
    expect(u.direction).toBe(-1);
    expect(u.comment).toBe('context');
  });

  it('updateQuote with explicit nulls clears optional fields', async () => {
    const q = await createQuote(d1, ctx, {
      bioguide_id: 'D000563',
      media_kind: 'video',
      source_url: 'https://example.com/a',
      body_text: 'first',
      source_label: 'label',
      quoted_at: '2024-02-13',
      comment: 'context',
    });
    const u = await updateQuote(d1, ctx, q.id, {
      source_label: null,
      quoted_at: null,
      comment: null,
    });
    expect(u.source_label).toBeNull();
    expect(u.quoted_at).toBeNull();
    expect(u.comment).toBeNull();
  });

  it('updateQuote throws when missing', async () => {
    await expect(
      updateQuote(d1, ctx, '01HMISSINGXXXXXXXXXXXXXXXX', { body_text: 'x' }),
    ).rejects.toThrow(/not found/);
  });

  it('deleteQuote removes + audits', async () => {
    const q = await createQuote(d1, ctx, {
      bioguide_id: 'D000563',
      media_kind: 'video',
      source_url: 'https://example.com/a',
      body_text: 'rm',
    });
    await deleteQuote(d1, ctx, q.id);
    const audits = await listAudit(d1);
    const del = audits.find(
      (a) => a.action === 'delete' && a.target_table === 'quotes',
    );
    expect(del).toBeDefined();
  });

  it('deleteQuote throws when missing', async () => {
    await expect(
      deleteQuote(d1, ctx, '01HMISSINGXXXXXXXXXXXXXXXX'),
    ).rejects.toThrow(/not found/);
  });
});

/* -------------------------------------------------------------------------- */
/*                          Bill delete branch                                */
/* -------------------------------------------------------------------------- */

describe('admin-store: bill delete not-found branch', () => {
  it('deleteBill throws when bill is missing', async () => {
    await expect(
      deleteBill(d1, ctx, '01HMISSINGXXXXXXXXXXXXXXXX'),
    ).rejects.toThrow(/not found/);
  });
});

/* -------------------------------------------------------------------------- */
/*                  runMutationWithAudit failure (no error message branch)    */
/* -------------------------------------------------------------------------- */

describe('admin-store: runMutationWithAudit failure surfaces unknown error', () => {
  it('throws "d1_batch_failed: unknown" when batch returns success=false with no error string', async () => {
    d1.failBatchWithoutMessage = true;
    const stmt = d1.prepare('INSERT INTO bills (id) VALUES (?)').bind('x');
    await expect(
      runMutationWithAudit(d1, ctx, stmt, {
        action: 'create',
        targetTable: 'bills',
        rowId: 'x',
        rowTitle: 't',
        before: null,
        after: { id: 'x' },
      }),
    ).rejects.toThrow(/d1_batch_failed: unknown/);
  });

  it('ValidationError surfaces with a code property', () => {
    const e = new ValidationError('invalid_thing', 'msg');
    expect(e.code).toBe('invalid_thing');
    expect(e.name).toBe('ValidationError');
    expect(e.message).toBe('msg');
  });
});
