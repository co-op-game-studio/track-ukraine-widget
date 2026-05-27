/**
 * Tests for proxy/d1/tags-store.ts.
 *
 * Tags are a shared categorization primitive (Settings ▸ Tags). Quotes are
 * the first consumer via the `quote_tags` join table.
 *
 * Uses an in-memory FakeD1 patterned after adminStore.test.ts. Because the
 * tag store calls `runMutationWithAudit` from admin-store, the FakeD1 must
 * support the 3-statement batch (ensureResearcher + mutation + audit) that
 * the real D1 executes atomically.
 *
 * The FakeD1 here extends the adminStore.test.ts shape with two extra query
 * branches the tag store needs that admin-store does not:
 *   - `INSERT INTO researchers ... ON CONFLICT (email) DO NOTHING`
 *   - `SELECT ... FROM tags t INNER JOIN quote_tags qt ...` (single + bulk)
 *   - `INSERT OR IGNORE INTO quote_tags ...`
 *   - `DELETE FROM quote_tags WHERE quote_id = ?`
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  listTags,
  getTag,
  createTag,
  updateTag,
  deleteTag,
  listTagsForQuote,
  listTagsForQuotes,
  setQuoteTags,
} from '../../proxy/d1/tags-store';
import type { MutationContext, TagRow } from '../../proxy/d1/admin-store';
import { isUlid } from '../../src/utils/ulid';
import type {
  D1Like,
  D1PreparedStatementLike,
  D1ResultLike,
} from '../../proxy/env';

/* -------------------------------------------------------------------------- */
/*                              In-memory fake D1                             */
/* -------------------------------------------------------------------------- */

interface QuoteTagRow {
  quote_id: string;
  tag_id: string;
  applied_at: string;
  applied_by: string;
}

class FakeD1 implements D1Like {
  tables: Record<string, Record<string, unknown>[]> = {
    tags: [],
    quote_tags: [],
    audit_log: [],
    researchers: [],
  };
  lastBatchSize = 0;
  failNextAuditInsert = false;

  prepare(query: string): D1PreparedStatementLike {
    return new FakeStmt(this, query, []);
  }

  async batch<T>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
    this.lastBatchSize = statements.length;
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

    // INSERT INTO researchers ... ON CONFLICT (email) DO NOTHING
    const researcherInsMatch = q.match(/^INSERT\s+INTO\s+researchers\s*\(([^)]+)\)\s+VALUES.*ON\s+CONFLICT/is);
    if (researcherInsMatch) {
      const cols = researcherInsMatch[1]!.split(',').map((c) => c.trim());
      const email = this.bindings[0];
      const existing = this.d1.tables.researchers!.find((r) => r['email'] === email);
      if (!existing) {
        const row: Record<string, unknown> = {};
        cols.forEach((c, i) => { row[c] = this.bindings[i] ?? null; });
        this.d1.tables.researchers!.push(row);
      }
      return { success: true, meta: { changes: existing ? 0 : 1 } };
    }

    // INSERT OR IGNORE INTO quote_tags (cols) VALUES (...)
    const qtInsMatch = q.match(/^INSERT\s+OR\s+IGNORE\s+INTO\s+(\w+)\s*\(([^)]+)\)\s+VALUES/i);
    if (qtInsMatch) {
      const table = qtInsMatch[1]!;
      const cols = qtInsMatch[2]!.split(',').map((c) => c.trim());
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => { row[c] = this.bindings[i] ?? null; });
      // Composite-PK dedupe for quote_tags: skip if (quote_id, tag_id) exists.
      if (table === 'quote_tags') {
        const dup = (this.d1.tables.quote_tags ?? []).find(
          (r) => r['quote_id'] === row['quote_id'] && r['tag_id'] === row['tag_id'],
        );
        if (dup) return { success: true, meta: { changes: 0 } };
      }
      this.d1.tables[table]!.push(row);
      return { success: true, meta: { changes: 1 } };
    }

    // INSERT INTO <table> (cols) VALUES (...)
    const insMatch = q.match(/^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s+VALUES/i);
    if (insMatch) {
      const table = insMatch[1]!;
      const cols = insMatch[2]!.split(',').map((c) => c.trim());
      if (table === 'audit_log' && this.d1.failNextAuditInsert) {
        this.d1.failNextAuditInsert = false;
        throw new Error('forced_audit_failure');
      }
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => { row[c] = this.bindings[i] ?? null; });
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
      fields.forEach((f, i) => { row[f] = this.bindings[i] ?? null; });
      rows[idx] = row;
      return { success: true, meta: { changes: 1 } };
    }

    // DELETE FROM quote_tags WHERE quote_id = ?
    const delQtMatch = q.match(/^DELETE\s+FROM\s+quote_tags\s+WHERE\s+quote_id\s*=\s*\?/i);
    if (delQtMatch) {
      const quoteId = this.bindings[0];
      const before = this.d1.tables.quote_tags!.length;
      this.d1.tables.quote_tags = this.d1.tables.quote_tags!.filter((r) => r['quote_id'] !== quoteId);
      return { success: true, meta: { changes: before - this.d1.tables.quote_tags!.length } };
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

    // SELECT t.* FROM tags t INNER JOIN quote_tags qt ON qt.tag_id = t.id
    //   WHERE qt.quote_id = ? ORDER BY t.label
    const joinSingleMatch = q.match(/^SELECT\s+t\.\*\s+FROM\s+tags\s+t\s+INNER\s+JOIN\s+quote_tags\s+qt[^?]*WHERE\s+qt\.quote_id\s*=\s*\?/is);
    if (joinSingleMatch) {
      const quoteId = this.bindings[0];
      const tagIds = (this.d1.tables.quote_tags ?? [])
        .filter((qt) => qt['quote_id'] === quoteId)
        .map((qt) => qt['tag_id']);
      const rows = (this.d1.tables.tags ?? [])
        .filter((t) => tagIds.includes(t['id']))
        .sort((a, b) => String(a['label']).localeCompare(String(b['label'])));
      return { success: true, results: rows };
    }

    // SELECT qt.quote_id, t.* FROM tags t INNER JOIN quote_tags qt ...
    //   WHERE qt.quote_id IN (?, ?, ...) ORDER BY t.label
    const joinBulkMatch = q.match(/^SELECT\s+qt\.quote_id,\s*t\.\*\s+FROM\s+tags\s+t\s+INNER\s+JOIN\s+quote_tags\s+qt[^?]*WHERE\s+qt\.quote_id\s+IN\s*\(([^)]+)\)/is);
    if (joinBulkMatch) {
      const quoteIds = this.bindings as string[];
      const out: Record<string, unknown>[] = [];
      for (const qt of (this.d1.tables.quote_tags ?? []) as unknown as QuoteTagRow[]) {
        if (!quoteIds.includes(qt.quote_id)) continue;
        const tag = (this.d1.tables.tags ?? []).find((t) => t['id'] === qt.tag_id);
        if (tag) out.push({ quote_id: qt.quote_id, ...tag });
      }
      out.sort((a, b) => String(a['label']).localeCompare(String(b['label'])));
      return { success: true, results: out };
    }

    // SELECT * FROM <table> WHERE id = ?
    const selByIdMatch = q.match(/^SELECT\s+\*\s+FROM\s+(\w+)\s+WHERE\s+id\s*=\s*\?/i);
    if (selByIdMatch) {
      const table = selByIdMatch[1]!;
      const id = this.bindings[0];
      const rows = (this.d1.tables[table] ?? []).filter((r) => r['id'] === id);
      return { success: true, results: rows };
    }

    // SELECT * FROM tags ORDER BY label
    const selListMatch = q.match(/^SELECT\s+\*\s+FROM\s+(\w+)\s+ORDER\s+BY\s+(\w+)/i);
    if (selListMatch) {
      const table = selListMatch[1]!;
      const col = selListMatch[2]!;
      const rows = [...(this.d1.tables[table] ?? [])].sort((a, b) =>
        String(a[col]).localeCompare(String(b[col])),
      );
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
  actorEmail: 'researcher@example.com',
  traceId: 'tr_tagstore_0123456789ab',
};

beforeEach(() => {
  d1 = new FakeD1();
});

async function seedTag(overrides: Partial<{ slug: string; label: string; color: string }> = {}): Promise<TagRow> {
  return createTag(
    d1,
    {
      slug: overrides.slug ?? 'foreign-policy',
      label: overrides.label ?? 'Foreign Policy',
      color: overrides.color ?? '#ef4444',
    },
    ctx,
  );
}

/* -------------------------------------------------------------------------- */
/*                                  createTag                                 */
/* -------------------------------------------------------------------------- */

describe('tags-store: createTag', () => {
  it('inserts a tag with a ULID PK and audits with trace_id', async () => {
    const tag = await seedTag();
    expect(isUlid(tag.id)).toBe(true);
    expect(tag.slug).toBe('foreign-policy');
    expect(tag.label).toBe('Foreign Policy');
    expect(tag.color).toBe('#ef4444');
    expect(tag.description).toBeNull();
    expect(tag.created_by).toBe('researcher@example.com');
    expect(tag.updated_by).toBe('researcher@example.com');
    expect(tag.created_at).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(tag.updated_at).toBe(tag.created_at);

    const audits = d1.tables.audit_log;
    expect(audits).toHaveLength(1);
    expect(audits![0]!['action']).toBe('create');
    expect(audits![0]!['target_table']).toBe('tags');
    expect(audits![0]!['row_id']).toBe(tag.id);
    expect(audits![0]!['trace_id']).toBe('tr_tagstore_0123456789ab');
    expect(audits![0]!['actor_email']).toBe('researcher@example.com');
  });

  it('runs a 3-statement batch (ensureResearcher + insert + audit)', async () => {
    await seedTag();
    expect(d1.lastBatchSize).toBe(3);
  });

  it('trims label and description', async () => {
    const tag = await createTag(
      d1,
      { slug: 'aid', label: '  Military Aid  ', color: '#2563eb', description: '  funded weapons  ' },
      ctx,
    );
    expect(tag.label).toBe('Military Aid');
    expect(tag.description).toBe('funded weapons');
  });

  it('coerces empty/whitespace description to null', async () => {
    const tag = await createTag(
      d1,
      { slug: 'a', label: 'A', color: '#000000', description: '   ' },
      ctx,
    );
    expect(tag.description).toBeNull();
  });

  it('rejects an empty slug', async () => {
    await expect(
      createTag(d1, { slug: '', label: 'X', color: '#abcdef' }, ctx),
    ).rejects.toThrow(/invalid_slug/);
  });

  it('rejects a slug starting with a dash', async () => {
    await expect(
      createTag(d1, { slug: '-foo', label: 'X', color: '#abcdef' }, ctx),
    ).rejects.toThrow(/invalid_slug/);
  });

  it('rejects an uppercase slug', async () => {
    await expect(
      createTag(d1, { slug: 'Foo', label: 'X', color: '#abcdef' }, ctx),
    ).rejects.toThrow(/invalid_slug/);
  });

  it('rejects a slug with spaces', async () => {
    await expect(
      createTag(d1, { slug: 'foo bar', label: 'X', color: '#abcdef' }, ctx),
    ).rejects.toThrow(/invalid_slug/);
  });

  it('rejects a slug longer than 64 characters', async () => {
    const tooLong = 'a' + 'b'.repeat(64); // 65 chars
    await expect(
      createTag(d1, { slug: tooLong, label: 'X', color: '#abcdef' }, ctx),
    ).rejects.toThrow(/invalid_slug/);
  });

  it('rejects a color missing the leading hash', async () => {
    await expect(
      createTag(d1, { slug: 'ok', label: 'X', color: 'abcdef' }, ctx),
    ).rejects.toThrow(/invalid_color/);
  });

  it('rejects a 3-digit hex color', async () => {
    await expect(
      createTag(d1, { slug: 'ok', label: 'X', color: '#abc' }, ctx),
    ).rejects.toThrow(/invalid_color/);
  });

  it('rejects a color with non-hex characters', async () => {
    await expect(
      createTag(d1, { slug: 'ok', label: 'X', color: '#zzzzzz' }, ctx),
    ).rejects.toThrow(/invalid_color/);
  });

  it('rejects an empty/whitespace label', async () => {
    await expect(
      createTag(d1, { slug: 'ok', label: '   ', color: '#abcdef' }, ctx),
    ).rejects.toThrow(/invalid_label/);
  });

  it('accepts both upper- and lower-case hex digits', async () => {
    const tag = await createTag(
      d1,
      { slug: 'mix', label: 'Mix', color: '#aBcDeF' },
      ctx,
    );
    expect(tag.color).toBe('#aBcDeF');
  });
});

/* -------------------------------------------------------------------------- */
/*                                  listTags                                  */
/* -------------------------------------------------------------------------- */

describe('tags-store: listTags / getTag', () => {
  it('listTags returns [] when empty', async () => {
    expect(await listTags(d1)).toEqual([]);
  });

  it('listTags returns all tags ordered by label', async () => {
    await seedTag({ slug: 'zebra', label: 'Zebra', color: '#000001' });
    await seedTag({ slug: 'apple', label: 'Apple', color: '#000002' });
    await seedTag({ slug: 'mango', label: 'Mango', color: '#000003' });
    const rows = await listTags(d1);
    expect(rows.map((r) => r.label)).toEqual(['Apple', 'Mango', 'Zebra']);
  });

  it('getTag returns the row when present', async () => {
    const t = await seedTag();
    const fetched = await getTag(d1, t.id);
    expect(fetched?.id).toBe(t.id);
    expect(fetched?.slug).toBe('foreign-policy');
  });

  it('getTag returns null for a missing id', async () => {
    expect(await getTag(d1, '01HQXXXXXXXXXXXXXXXXXXXXXX')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                                  updateTag                                 */
/* -------------------------------------------------------------------------- */

describe('tags-store: updateTag', () => {
  it('returns null when the tag does not exist', async () => {
    const result = await updateTag(d1, '01HQMISSINGXXXXXXXXXXXXXXX', { label: 'whatever' }, ctx);
    expect(result).toBeNull();
  });

  it('updates only the patched field, preserves the rest', async () => {
    const before = await seedTag({ slug: 'orig', label: 'Original', color: '#111111' });
    const after = await updateTag(d1, before.id, { label: 'Renamed' }, ctx);
    expect(after).not.toBeNull();
    expect(after!.label).toBe('Renamed');
    expect(after!.slug).toBe('orig');
    expect(after!.color).toBe('#111111');
    expect(after!.created_at).toBe(before.created_at);
    expect(after!.created_by).toBe(before.created_by);
    expect(after!.updated_by).toBe('researcher@example.com');
  });

  it('persists the update to the row store', async () => {
    const before = await seedTag();
    await updateTag(d1, before.id, { color: '#222222' }, ctx);
    const fetched = await getTag(d1, before.id);
    expect(fetched?.color).toBe('#222222');
  });

  it('audits the update with before/after diff', async () => {
    const before = await seedTag({ label: 'Old' });
    await updateTag(d1, before.id, { label: 'New' }, ctx);
    const updateRow = d1.tables.audit_log!.find(
      (a) => a['action'] === 'update' && a['target_table'] === 'tags',
    );
    expect(updateRow).toBeDefined();
    const beforeJson = JSON.parse(updateRow!['before_json'] as string) as { label: string };
    const afterJson = JSON.parse(updateRow!['after_json'] as string) as { label: string };
    expect(beforeJson.label).toBe('Old');
    expect(afterJson.label).toBe('New');
  });

  it('rejects an invalid slug after merge', async () => {
    const before = await seedTag();
    await expect(updateTag(d1, before.id, { slug: 'BAD SLUG' }, ctx)).rejects.toThrow(/invalid_slug/);
  });

  it('rejects an invalid color after merge', async () => {
    const before = await seedTag();
    await expect(updateTag(d1, before.id, { color: 'red' }, ctx)).rejects.toThrow(/invalid_color/);
  });

  it('rejects clearing the label to empty', async () => {
    const before = await seedTag();
    await expect(updateTag(d1, before.id, { label: '   ' }, ctx)).rejects.toThrow(/invalid_label/);
  });

  it('allows explicitly clearing the description by passing null', async () => {
    const before = await createTag(
      d1,
      { slug: 'd', label: 'D', color: '#abcdef', description: 'first desc' },
      ctx,
    );
    expect(before.description).toBe('first desc');
    const after = await updateTag(d1, before.id, { description: null }, ctx);
    expect(after!.description).toBeNull();
  });

  it('preserves description when patch omits it', async () => {
    const before = await createTag(
      d1,
      { slug: 'd', label: 'D', color: '#abcdef', description: 'keep me' },
      ctx,
    );
    const after = await updateTag(d1, before.id, { label: 'D2' }, ctx);
    expect(after!.description).toBe('keep me');
  });
});

/* -------------------------------------------------------------------------- */
/*                                  deleteTag                                 */
/* -------------------------------------------------------------------------- */

describe('tags-store: deleteTag', () => {
  it('returns false when the tag does not exist', async () => {
    expect(await deleteTag(d1, '01HQNOPEXXXXXXXXXXXXXXXXXX', ctx)).toBe(false);
  });

  it('returns true and removes the row on success', async () => {
    const t = await seedTag();
    expect(await deleteTag(d1, t.id, ctx)).toBe(true);
    expect(await getTag(d1, t.id)).toBeNull();
  });

  it('audits the delete with before set and after null', async () => {
    const t = await seedTag({ label: 'ToDelete' });
    await deleteTag(d1, t.id, ctx);
    const del = d1.tables.audit_log!.find(
      (a) => a['action'] === 'delete' && a['target_table'] === 'tags',
    );
    expect(del).toBeDefined();
    expect(del!['after_json']).toBeNull();
    const beforeJson = JSON.parse(del!['before_json'] as string) as { label: string };
    expect(beforeJson.label).toBe('ToDelete');
  });
});

/* -------------------------------------------------------------------------- */
/*                          listTagsForQuote / Quotes                         */
/* -------------------------------------------------------------------------- */

describe('tags-store: listTagsForQuote', () => {
  it('returns [] when the quote has no tags', async () => {
    const rows = await listTagsForQuote(d1, 'q_empty');
    expect(rows).toEqual([]);
  });

  it('returns the joined tags ordered by label', async () => {
    const t1 = await seedTag({ slug: 'zebra', label: 'Zebra', color: '#000001' });
    const t2 = await seedTag({ slug: 'apple', label: 'Apple', color: '#000002' });
    await setQuoteTags(d1, 'q_1', [t1.id, t2.id], ctx.actorEmail);
    const rows = await listTagsForQuote(d1, 'q_1');
    expect(rows.map((r) => r.label)).toEqual(['Apple', 'Zebra']);
  });

  it('only returns tags for the requested quote', async () => {
    const t1 = await seedTag({ slug: 't1', label: 'Tag One', color: '#000001' });
    const t2 = await seedTag({ slug: 't2', label: 'Tag Two', color: '#000002' });
    await setQuoteTags(d1, 'q_a', [t1.id], ctx.actorEmail);
    await setQuoteTags(d1, 'q_b', [t2.id], ctx.actorEmail);
    const aRows = await listTagsForQuote(d1, 'q_a');
    expect(aRows.map((r) => r.slug)).toEqual(['t1']);
  });
});

/* -------------------------------------------------------------------------- */
/*                              listTagsForQuotes                             */
/* -------------------------------------------------------------------------- */

describe('tags-store: listTagsForQuotes', () => {
  it('returns an empty Map for an empty input array (no query issued)', async () => {
    const map = await listTagsForQuotes(d1, []);
    expect(map.size).toBe(0);
  });

  it('returns a Map keyed by quote_id with each quote\'s tags', async () => {
    const t1 = await seedTag({ slug: 't1', label: 'Alpha', color: '#000001' });
    const t2 = await seedTag({ slug: 't2', label: 'Beta', color: '#000002' });
    const t3 = await seedTag({ slug: 't3', label: 'Gamma', color: '#000003' });
    await setQuoteTags(d1, 'q_a', [t1.id, t2.id], ctx.actorEmail);
    await setQuoteTags(d1, 'q_b', [t3.id], ctx.actorEmail);

    const map = await listTagsForQuotes(d1, ['q_a', 'q_b', 'q_c']);
    expect(map.get('q_a')?.map((t) => t.label).sort()).toEqual(['Alpha', 'Beta']);
    expect(map.get('q_b')?.map((t) => t.label)).toEqual(['Gamma']);
    expect(map.has('q_c')).toBe(false);
  });

  it('does not include the quote_id field on tag rows in the map values', async () => {
    const t1 = await seedTag({ slug: 't1', label: 'Solo', color: '#000001' });
    await setQuoteTags(d1, 'q_a', [t1.id], ctx.actorEmail);
    const map = await listTagsForQuotes(d1, ['q_a']);
    const row = map.get('q_a')![0]!;
    expect((row as unknown as { quote_id?: string }).quote_id).toBeUndefined();
    expect(row.id).toBe(t1.id);
  });
});

/* -------------------------------------------------------------------------- */
/*                                setQuoteTags                                */
/* -------------------------------------------------------------------------- */

describe('tags-store: setQuoteTags', () => {
  it('inserts new join rows when the quote previously had none', async () => {
    const t1 = await seedTag({ slug: 't1', label: 'T1', color: '#000001' });
    const t2 = await seedTag({ slug: 't2', label: 'T2', color: '#000002' });
    await setQuoteTags(d1, 'q_new', [t1.id, t2.id], 'curator@example.com');
    const joins = d1.tables.quote_tags!.filter((qt) => qt['quote_id'] === 'q_new');
    expect(joins).toHaveLength(2);
    expect(joins.every((qt) => qt['applied_by'] === 'curator@example.com')).toBe(true);
    expect(joins[0]!['applied_at']).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('REPLACES the prior set: pre-existing tags get cleared', async () => {
    const t1 = await seedTag({ slug: 't1', label: 'T1', color: '#000001' });
    const t2 = await seedTag({ slug: 't2', label: 'T2', color: '#000002' });
    const t3 = await seedTag({ slug: 't3', label: 'T3', color: '#000003' });
    await setQuoteTags(d1, 'q_x', [t1.id, t2.id], ctx.actorEmail);
    expect(d1.tables.quote_tags!.filter((qt) => qt['quote_id'] === 'q_x')).toHaveLength(2);

    await setQuoteTags(d1, 'q_x', [t3.id], ctx.actorEmail);
    const after = d1.tables.quote_tags!.filter((qt) => qt['quote_id'] === 'q_x');
    expect(after).toHaveLength(1);
    expect(after[0]!['tag_id']).toBe(t3.id);
  });

  it('clears all tags when called with an empty array', async () => {
    const t1 = await seedTag({ slug: 't1', label: 'T1', color: '#000001' });
    await setQuoteTags(d1, 'q_x', [t1.id], ctx.actorEmail);
    await setQuoteTags(d1, 'q_x', [], ctx.actorEmail);
    expect(d1.tables.quote_tags!.filter((qt) => qt['quote_id'] === 'q_x')).toHaveLength(0);
  });

  it('does not affect tags on other quotes', async () => {
    const t1 = await seedTag({ slug: 't1', label: 'T1', color: '#000001' });
    const t2 = await seedTag({ slug: 't2', label: 'T2', color: '#000002' });
    await setQuoteTags(d1, 'q_a', [t1.id], ctx.actorEmail);
    await setQuoteTags(d1, 'q_b', [t2.id], ctx.actorEmail);
    await setQuoteTags(d1, 'q_a', [], ctx.actorEmail);
    expect(d1.tables.quote_tags!.filter((qt) => qt['quote_id'] === 'q_b')).toHaveLength(1);
  });
});
