/**
 * Tests for proxy/d1/ingest-store.ts.
 *
 * Uses an in-memory FakeD1 patterned after tests/unit/adminStore.test.ts
 * (copy-pasted intentionally — the SQL surface is narrow and not a maintenance
 * burden). The fake interprets the small SQL vocabulary the ingest store uses:
 * INSERT (incl. ON CONFLICT DO UPDATE), UPDATE, SELECT (single, COUNT, list with
 * WHERE/ORDER/LIMIT/OFFSET), and batched mutation+audit via runMutationWithAudit.
 *
 * Traces: FR-59 (ingest infrastructure), FR-50 AC-50.3 (audit atomicity).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  listHandles,
  upsertHandle,
  updateHandlePollState,
  recordHandlePollFailure,
  setHandlePollTrace,
  updateHandle,
  deactivateHandle,
  enqueuePost,
  findQueueByPlatformPostId,
  listQueue,
  updateQueueStatus,
  listKeywordWatches,
  createKeywordWatch,
  toggleKeywordWatch,
  type SocialHandleRow,
  type QueueRow,
  type KeywordWatchRow,
} from '../../proxy/d1/ingest-store';
import type {
  D1Like,
  D1PreparedStatementLike,
  D1ResultLike,
} from '../../proxy/env';

/* -------------------------------------------------------------------------- */
/*                              In-memory fake D1                             */
/* -------------------------------------------------------------------------- */

/**
 * Minimal D1 fake — extended from the adminStore.test.ts version with
 * additional SQL forms used by ingest-store:
 *   - INSERT ... ON CONFLICT DO UPDATE (upsertHandle)
 *   - SELECT COUNT(*) (listQueue)
 *   - SELECT * with WHERE col = ? (AND col = ?){0,N} (ORDER BY ...)? (LIMIT ?)? (OFFSET ?)?
 *   - UPDATE with multi-column SET, including literal SET fragments (NULL, 'ok')
 *   - UNIQUE-collision simulation for enqueuePost
 */
class FakeD1 implements D1Like {
  tables: Record<string, Record<string, unknown>[]> = {
    mocs_social_handles: [],
    social_post_queue: [],
    social_keyword_watches: [],
    audit_log: [],
    researchers: [],
  };
  /** When set, the next INSERT into social_post_queue throws a UNIQUE error. */
  failNextQueueInsertWithUnique = false;
  lastBatchSize = 0;

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

    /* ----------------------------- INSERT family ---------------------------- */

    // INSERT ... ON CONFLICT (cols) DO UPDATE SET ... (upsertHandle)
    const upsertMatch = q.match(
      /^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s+VALUES\s*\(([^)]*)\)\s+ON\s+CONFLICT\s*\(([^)]+)\)\s+DO\s+UPDATE\s+SET\s+(.+)$/is,
    );
    if (upsertMatch) {
      const table = upsertMatch[1]!;
      const cols = upsertMatch[2]!.split(',').map((c) => c.trim());
      const conflictCols = upsertMatch[4]!.split(',').map((c) => c.trim());
      const setClause = upsertMatch[5]!;
      const setFields = setClause
        .split(',')
        .map((kv) => {
          const [lhs, rhs] = kv.split('=').map((s) => s.trim());
          // Handles `excluded.<col>` form — pull from the new row's value.
          const ex = rhs!.match(/excluded\.(\w+)/i);
          return { col: lhs!, fromExcluded: ex ? ex[1]! : null };
        });
      const newRow: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        newRow[c] = this.bindings[i] ?? null;
      });
      const rows = this.d1.tables[table]!;
      const conflictIdx = rows.findIndex((r) =>
        conflictCols.every((c) => r[c] === newRow[c]),
      );
      if (conflictIdx === -1) {
        rows.push(newRow);
      } else {
        const merged = { ...rows[conflictIdx]! };
        for (const f of setFields) {
          if (f.fromExcluded) {
            merged[f.col] = newRow[f.fromExcluded];
          }
        }
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
      cols.forEach((c, i) => {
        newRow[c] = this.bindings[i] ?? null;
      });
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
      if (
        table === 'social_post_queue' &&
        this.d1.failNextQueueInsertWithUnique
      ) {
        this.d1.failNextQueueInsertWithUnique = false;
        throw new Error('UNIQUE constraint failed: social_post_queue.platform, platform_post_id');
      }
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        row[c] = this.bindings[i] ?? null;
      });
      this.d1.tables[table] = this.d1.tables[table] ?? [];
      this.d1.tables[table]!.push(row);
      return { success: true, meta: { changes: 1 } };
    }

    /* ----------------------------- UPDATE family ---------------------------- */

    // UPDATE <table> SET ... WHERE id = ?
    const updMatch = q.match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+id\s*=\s*\?/is);
    if (updMatch) {
      const table = updMatch[1]!;
      const setClause = updMatch[2]!;
      // Parse each comma-separated assignment into { col, value? } where value
      // is either a literal (NULL / 'ok') or a placeholder consuming the next
      // binding.
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
          // Unknown literal — leave as-is.
          row[col] = rhs;
        }
      }
      rows[idx] = row;
      return { success: true, meta: { changes: 1 } };
    }

    /* ----------------------------- SELECT family ---------------------------- */

    // SELECT COUNT(*) as cnt FROM <table> [WHERE ...]
    const countMatch = q.match(
      /^SELECT\s+COUNT\(\*\)\s+as\s+cnt\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/is,
    );
    if (countMatch) {
      const table = countMatch[1]!;
      const where = countMatch[2];
      const rows = this.d1.tables[table] ?? [];
      const filtered = where
        ? this.applyWhere(rows, where, this.bindings)
        : rows;
      return { success: true, results: [{ cnt: filtered.length }] };
    }

    // SELECT * FROM <table>[ WHERE ...][ ORDER BY ...][ LIMIT ?][ OFFSET ?]
    // (Catches everything from list/find/select-by-id since it's the most
    // generic shape — must come AFTER COUNT.)
    const selMatch = q.match(
      /^SELECT\s+\*\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+[^?]+?)?(?:\s+LIMIT\s+(\?|\d+))?(?:\s+OFFSET\s+(\?|\d+))?\s*$/is,
    );
    if (selMatch) {
      const table = selMatch[1]!;
      const whereRaw = selMatch[2];
      const limitTok = selMatch[3];
      const offsetTok = selMatch[4];

      // Bindings layout: [...whereParams, limit?, offset?]
      const whereBindings = [...this.bindings];
      let limit: number | undefined;
      let offset = 0;
      if (offsetTok === '?') {
        offset = Number(whereBindings.pop() ?? 0);
      } else if (offsetTok) {
        offset = Number(offsetTok);
      }
      if (limitTok === '?') {
        limit = Number(whereBindings.pop() ?? 0);
      } else if (limitTok) {
        limit = Number(limitTok);
      }
      const rows = this.d1.tables[table] ?? [];
      const filtered = whereRaw
        ? this.applyWhere(rows, whereRaw, whereBindings)
        : rows;
      const sliced = limit !== undefined ? filtered.slice(offset, offset + limit) : filtered;
      return { success: true, results: sliced };
    }

    throw new Error(`unhandled query in fake D1: ${q}`);
  }

  /**
   * Tiny WHERE evaluator. Supports AND-joined clauses of the form:
   *   col = ?
   *   col IS NULL
   *   col IS NOT NULL
   *   col = '<literal>'
   *   col >= ?  (lexicographic — used by audit-log style filters; not by ingest-store today)
   * Also supports a trailing LIMIT N inside the WHERE string (for `LIMIT 1`).
   */
  private applyWhere(
    rows: Record<string, unknown>[],
    whereRaw: string,
    bindings: unknown[],
  ): Record<string, unknown>[] {
    // Strip trailing `LIMIT n` if present in the where string capture.
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
/*                                  Fixtures                                  */
/* -------------------------------------------------------------------------- */

let d1: FakeD1;
const ctx = {
  actorEmail: 'curator@example.com',
  traceId: 'tr_test_00000001',
};

beforeEach(() => {
  d1 = new FakeD1();
});

function baseHandleInput(overrides: Partial<Parameters<typeof upsertHandle>[1]> = {}) {
  return {
    bioguideId: 'D000563',
    entityName: 'Sen. Dick Durbin',
    accountCategory: 'congress',
    platform: 'twitter',
    accountKind: 'official',
    handle: 'SenatorDurbin',
    platformId: '12345',
    displayName: 'Dick Durbin',
    avatarUrl: 'https://example.com/d.png',
    source: 'manual',
    ...overrides,
  };
}

async function seedHandle(overrides = {}): Promise<SocialHandleRow> {
  return upsertHandle(d1, baseHandleInput(overrides));
}

function baseQueueInput(overrides: Partial<Parameters<typeof enqueuePost>[1]> = {}) {
  return {
    bioguideId: 'D000563',
    platform: 'twitter',
    platformPostId: 'tweet-1',
    authorHandle: 'SenatorDurbin',
    postedAt: '2026-04-15T12:00:00Z',
    url: 'https://twitter.com/SenatorDurbin/status/1',
    bodyText: 'Standing with Ukraine.',
    mediaRefsJson: '[]',
    rawPayloadJson: '{}',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*                                   Handles                                  */
/* -------------------------------------------------------------------------- */

describe('ingest-store: listHandles', () => {
  it('returns [] when the table is empty', async () => {
    expect(await listHandles(d1)).toEqual([]);
  });

  it('returns all active handles by default (active_to IS NULL filter)', async () => {
    const a = await seedHandle({ platformId: 'a', handle: 'a' });
    await seedHandle({ platformId: 'b', handle: 'b' });
    // Soft-delete one — it should disappear from default list.
    await deactivateHandle(d1, a.id);
    const rows = await listHandles(d1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.platform_id).toBe('b');
  });

  it('filters by bioguideId', async () => {
    await seedHandle({ bioguideId: 'D000563', platformId: 'a' });
    await seedHandle({ bioguideId: 'M000355', platformId: 'b', handle: 'McConnell' });
    const rows = await listHandles(d1, { bioguideId: 'M000355' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bioguide_id).toBe('M000355');
  });

  it('filters by platform', async () => {
    await seedHandle({ platform: 'twitter', platformId: 'a' });
    await seedHandle({ platform: 'mastodon', platformId: 'b', handle: 'b' });
    const rows = await listHandles(d1, { platform: 'mastodon' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.platform).toBe('mastodon');
  });

  it('filters by accountCategory', async () => {
    await seedHandle({ accountCategory: 'congress', platformId: 'a' });
    await seedHandle({ accountCategory: 'agency', platformId: 'b', handle: 'b' });
    const rows = await listHandles(d1, { accountCategory: 'agency' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.account_category).toBe('agency');
  });

  it('combines bioguideId + platform + accountCategory filters', async () => {
    await seedHandle({ bioguideId: 'X', platform: 'twitter', accountCategory: 'congress', platformId: 'a' });
    await seedHandle({ bioguideId: 'X', platform: 'mastodon', accountCategory: 'congress', platformId: 'b', handle: 'b' });
    await seedHandle({ bioguideId: 'Y', platform: 'twitter', accountCategory: 'congress', platformId: 'c', handle: 'c' });
    const rows = await listHandles(d1, { bioguideId: 'X', platform: 'twitter', accountCategory: 'congress' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.platform_id).toBe('a');
  });

  it('with activeOnly=false includes soft-deleted rows', async () => {
    const a = await seedHandle({ platformId: 'a' });
    await deactivateHandle(d1, a.id);
    const rows = await listHandles(d1, { activeOnly: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.active_to).not.toBeNull();
  });
});

describe('ingest-store: upsertHandle', () => {
  it('inserts a fresh row with sensible defaults', async () => {
    const row = await upsertHandle(d1, {
      platform: 'twitter',
      handle: 'foo',
      platformId: 'pid-1',
    });
    expect(row.account_category).toBe('congress');
    expect(row.account_kind).toBe('official');
    expect(row.bioguide_id).toBeNull();
    expect(row.entity_name).toBeNull();
    expect(row.display_name).toBeNull();
    expect(row.avatar_url).toBeNull();
    expect(row.source).toBeNull();
    expect(row.active_to).toBeNull();
    expect(row.last_polled_at).toBeNull();
    expect(row.last_seen_post_id).toBeNull();
    expect(row.active_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row.created_at).toMatch(/T/);
    const all = await listHandles(d1);
    expect(all).toHaveLength(1);
    expect(all[0]!.handle).toBe('foo');
  });

  it('persists every supplied optional field', async () => {
    const row = await upsertHandle(d1, baseHandleInput());
    expect(row.bioguide_id).toBe('D000563');
    expect(row.entity_name).toBe('Sen. Dick Durbin');
    expect(row.display_name).toBe('Dick Durbin');
    expect(row.avatar_url).toBe('https://example.com/d.png');
    expect(row.source).toBe('manual');
  });

  it('updates the existing row on (platform, platform_id, active_from) conflict', async () => {
    const first = await upsertHandle(d1, baseHandleInput({ handle: 'OldHandle', displayName: 'Old' }));
    const second = await upsertHandle(
      d1,
      baseHandleInput({ handle: 'NewHandle', displayName: 'New', entityName: 'Updated' }),
    );
    // Both inputs return their own row shape, but the DB should have ONE row
    // post-conflict resolution, with the new values applied.
    expect(first.id).not.toBe(second.id);
    const all = await listHandles(d1);
    expect(all).toHaveLength(1);
    expect(all[0]!.handle).toBe('NewHandle');
    expect(all[0]!.display_name).toBe('New');
    expect(all[0]!.entity_name).toBe('Updated');
  });
});

describe('ingest-store: updateHandlePollState', () => {
  it('writes last_polled_at + last_seen_post_id, sets status=ok, clears error', async () => {
    const seeded = await seedHandle();
    // Pre-set an error to confirm clearing.
    await recordHandlePollFailure(d1, seeded.id, 'prior boom', 'tr_old');
    await updateHandlePollState(d1, seeded.id, '2026-05-01T10:00:00Z', 'post-99');
    const row = (await listHandles(d1))[0]!;
    expect(row.last_polled_at).toBe('2026-05-01T10:00:00Z');
    expect(row.last_seen_post_id).toBe('post-99');
    expect(row.last_poll_status).toBe('ok');
    expect(row.last_poll_error).toBeNull();
    expect(row.last_poll_attempted_at).toBe('2026-05-01T10:00:00Z');
    expect(row.last_poll_trace_id).toBeNull();
  });

  it('accepts null last_seen_post_id (no new posts seen)', async () => {
    const seeded = await seedHandle();
    await updateHandlePollState(d1, seeded.id, '2026-05-01T10:00:00Z', null);
    const row = (await listHandles(d1))[0]!;
    expect(row.last_seen_post_id).toBeNull();
    expect(row.last_poll_status).toBe('ok');
  });
});

describe('ingest-store: recordHandlePollFailure', () => {
  it('sets last_poll_attempted_at + status=error + error text + trace_id; does NOT touch last_polled_at', async () => {
    const seeded = await seedHandle();
    // First record a successful poll so last_polled_at has a known value.
    await updateHandlePollState(d1, seeded.id, '2026-04-01T00:00:00Z', 'post-1');
    const before = (await listHandles(d1))[0]!;
    expect(before.last_polled_at).toBe('2026-04-01T00:00:00Z');

    await recordHandlePollFailure(d1, seeded.id, 'rate limited', 'tr_fail_1');
    const after = (await listHandles(d1))[0]!;
    expect(after.last_polled_at).toBe('2026-04-01T00:00:00Z'); // pinned to last success
    expect(after.last_poll_status).toBe('error');
    expect(after.last_poll_error).toBe('rate limited');
    expect(after.last_poll_trace_id).toBe('tr_fail_1');
    expect(after.last_poll_attempted_at).toMatch(/T/);
    expect(after.last_poll_attempted_at).not.toBe(after.last_polled_at);
  });

  it('truncates error text longer than 1000 characters', async () => {
    const seeded = await seedHandle();
    const long = 'x'.repeat(1500);
    await recordHandlePollFailure(d1, seeded.id, long, 'tr_long');
    const row = (await listHandles(d1))[0]!;
    expect(row.last_poll_error).toHaveLength(1000);
    expect(row.last_poll_error).toBe('x'.repeat(1000));
  });

  it('preserves error text shorter than the cap unchanged', async () => {
    const seeded = await seedHandle();
    await recordHandlePollFailure(d1, seeded.id, 'short', 'tr_s');
    const row = (await listHandles(d1))[0]!;
    expect(row.last_poll_error).toBe('short');
  });
});

describe('ingest-store: setHandlePollTrace', () => {
  it('writes only the trace ID and leaves other poll fields alone', async () => {
    const seeded = await seedHandle();
    await updateHandlePollState(d1, seeded.id, '2026-04-01T00:00:00Z', 'post-1');
    await setHandlePollTrace(d1, seeded.id, 'tr_in_flight');
    const row = (await listHandles(d1))[0]!;
    expect(row.last_poll_trace_id).toBe('tr_in_flight');
    expect(row.last_polled_at).toBe('2026-04-01T00:00:00Z');
    expect(row.last_poll_status).toBe('ok');
    expect(row.last_seen_post_id).toBe('post-1');
  });
});

describe('ingest-store: updateHandle', () => {
  it('patches only the supplied fields', async () => {
    const seeded = await seedHandle();
    await updateHandle(d1, seeded.id, {
      handle: 'RenamedHandle',
      displayName: 'Renamed Display',
    });
    const row = (await listHandles(d1))[0]!;
    expect(row.handle).toBe('RenamedHandle');
    expect(row.display_name).toBe('Renamed Display');
    // Untouched:
    expect(row.platform_id).toBe(seeded.platform_id);
    expect(row.entity_name).toBe(seeded.entity_name);
    expect(row.account_category).toBe(seeded.account_category);
    expect(row.platform).toBe(seeded.platform);
  });

  it('can update every editable field at once', async () => {
    const seeded = await seedHandle();
    await updateHandle(d1, seeded.id, {
      handle: 'h2',
      platformId: 'pid-2',
      displayName: 'd2',
      entityName: 'e2',
      accountCategory: 'agency',
      platform: 'mastodon',
    });
    // Default activeOnly excludes nothing here (active_to still null), but the
    // category changed so we need to disable that filter.
    const row = (await listHandles(d1, { activeOnly: false }))[0]!;
    expect(row.handle).toBe('h2');
    expect(row.platform_id).toBe('pid-2');
    expect(row.display_name).toBe('d2');
    expect(row.entity_name).toBe('e2');
    expect(row.account_category).toBe('agency');
    expect(row.platform).toBe('mastodon');
  });

  it('is a no-op when no fields are supplied', async () => {
    const seeded = await seedHandle();
    await updateHandle(d1, seeded.id, {});
    const row = (await listHandles(d1))[0]!;
    expect(row.handle).toBe(seeded.handle);
    expect(row.updated_at).toBe(seeded.updated_at);
  });
});

describe('ingest-store: deactivateHandle', () => {
  it('soft-deletes by setting active_to to today (YYYY-MM-DD)', async () => {
    const seeded = await seedHandle();
    await deactivateHandle(d1, seeded.id);
    const all = await listHandles(d1, { activeOnly: false });
    expect(all).toHaveLength(1);
    expect(all[0]!.active_to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Default listHandles (active-only) hides it.
    expect(await listHandles(d1)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*                                    Queue                                   */
/* -------------------------------------------------------------------------- */

describe('ingest-store: enqueuePost', () => {
  it('inserts a pending row with stamped ingested_at', async () => {
    const row = await enqueuePost(d1, baseQueueInput());
    expect(row).not.toBeNull();
    expect(row!.status).toBe('pending');
    expect(row!.ingested_at).toMatch(/T/);
    expect(row!.reviewed_by).toBeNull();
    expect(row!.reviewed_at).toBeNull();
    expect(row!.matched_keywords).toBeNull();
    const found = await findQueueByPlatformPostId(d1, 'twitter', 'tweet-1');
    expect(found?.id).toBe(row!.id);
  });

  it('serializes matchedKeywords as a JSON array when supplied', async () => {
    const row = await enqueuePost(d1, baseQueueInput({ matchedKeywords: ['ukraine', 'aid'] }));
    expect(row!.matched_keywords).toBe(JSON.stringify(['ukraine', 'aid']));
  });

  it('writes null matched_keywords when array is empty', async () => {
    const row = await enqueuePost(d1, baseQueueInput({ matchedKeywords: [] }));
    expect(row!.matched_keywords).toBeNull();
  });

  it('returns null when the UNIQUE (platform, platform_post_id) collides', async () => {
    d1.failNextQueueInsertWithUnique = true;
    const dup = await enqueuePost(d1, baseQueueInput());
    expect(dup).toBeNull();
  });

  it('rethrows non-UNIQUE errors', async () => {
    // Patch prepare to throw a generic error on the next queue insert.
    const origPrepare = d1.prepare.bind(d1);
    d1.prepare = (q: string) => {
      if (/INSERT\s+INTO\s+social_post_queue/i.test(q)) {
        d1.prepare = origPrepare;
        return {
          bind() { return this; },
          async run() { throw new Error('disk full'); },
          async first() { throw new Error('disk full'); },
          async all() { throw new Error('disk full'); },
        } as unknown as D1PreparedStatementLike;
      }
      return origPrepare(q);
    };
    await expect(enqueuePost(d1, baseQueueInput())).rejects.toThrow(/disk full/);
  });

  it('preserves null bioguideId (e.g. agency posts not tied to a member)', async () => {
    const row = await enqueuePost(d1, baseQueueInput({ bioguideId: null }));
    expect(row!.bioguide_id).toBeNull();
  });
});

describe('ingest-store: findQueueByPlatformPostId', () => {
  it('returns null when no row matches', async () => {
    const r = await findQueueByPlatformPostId(d1, 'twitter', 'nope');
    expect(r).toBeNull();
  });

  it('returns the matching row by (platform, platform_post_id)', async () => {
    await enqueuePost(d1, baseQueueInput({ platformPostId: 'a' }));
    const wanted = await enqueuePost(d1, baseQueueInput({ platformPostId: 'b' }));
    const found = await findQueueByPlatformPostId(d1, 'twitter', 'b');
    expect(found?.id).toBe(wanted!.id);
  });
});

describe('ingest-store: listQueue', () => {
  beforeEach(async () => {
    await enqueuePost(d1, baseQueueInput({ platformPostId: 'p1', bioguideId: 'A' }));
    await enqueuePost(d1, baseQueueInput({
      platformPostId: 'p2',
      bioguideId: 'B',
      platform: 'mastodon',
      matchedKeywords: ['ukraine'],
    }));
    await enqueuePost(d1, baseQueueInput({
      platformPostId: 'p3',
      bioguideId: 'A',
      matchedKeywords: ['aid'],
    }));
  });

  it('returns all rows + total when no filters', async () => {
    const r = await listQueue(d1);
    expect(r.total).toBe(3);
    expect(r.items).toHaveLength(3);
  });

  it('filters by platform', async () => {
    const r = await listQueue(d1, { platform: 'mastodon' });
    expect(r.total).toBe(1);
    expect(r.items[0]!.platform_post_id).toBe('p2');
  });

  it('filters by bioguideId', async () => {
    const r = await listQueue(d1, { bioguideId: 'A' });
    expect(r.total).toBe(2);
    for (const it of r.items) expect(it.bioguide_id).toBe('A');
  });

  it('filters by status', async () => {
    // Promote one to curated.
    const all = await listQueue(d1);
    await updateQueueStatus(d1, all.items[0]!.id, 'curated', 'reviewer@example.com');
    const r = await listQueue(d1, { status: 'curated' });
    expect(r.total).toBe(1);
    expect(r.items[0]!.status).toBe('curated');
  });

  it('filters by keywordMatch (matched_keywords IS NOT NULL)', async () => {
    const r = await listQueue(d1, { keywordMatch: true });
    expect(r.total).toBe(2);
    for (const it of r.items) expect(it.matched_keywords).not.toBeNull();
  });

  it('combines status + keywordMatch filters', async () => {
    const r = await listQueue(d1, { status: 'pending', keywordMatch: true });
    expect(r.total).toBe(2);
  });

  it('respects limit + offset for pagination', async () => {
    const page1 = await listQueue(d1, { limit: 2, offset: 0 });
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(3);
    const page2 = await listQueue(d1, { limit: 2, offset: 2 });
    expect(page2.items).toHaveLength(1);
    expect(page2.total).toBe(3);
  });

  it('returns total=0 + empty items when no rows match', async () => {
    const r = await listQueue(d1, { platform: 'truth-social' });
    expect(r.total).toBe(0);
    expect(r.items).toEqual([]);
  });
});

describe('ingest-store: updateQueueStatus', () => {
  it('records reviewer + reviewed_at on curated', async () => {
    const row = await enqueuePost(d1, baseQueueInput());
    await updateQueueStatus(d1, row!.id, 'curated', 'rev@example.com');
    const found = await findQueueByPlatformPostId(d1, 'twitter', 'tweet-1');
    expect(found!.status).toBe('curated');
    expect(found!.reviewed_by).toBe('rev@example.com');
    expect(found!.reviewed_at).toMatch(/T/);
  });

  it('records dismissed status as well', async () => {
    const row = await enqueuePost(d1, baseQueueInput());
    await updateQueueStatus(d1, row!.id, 'dismissed', 'rev@example.com');
    const found = await findQueueByPlatformPostId(d1, 'twitter', 'tweet-1');
    expect(found!.status).toBe('dismissed');
  });
});

/* -------------------------------------------------------------------------- */
/*                              Keyword watches                               */
/* -------------------------------------------------------------------------- */

describe('ingest-store: listKeywordWatches', () => {
  it('returns [] when none exist', async () => {
    expect(await listKeywordWatches(d1)).toEqual([]);
  });

  it('returns active rows by default', async () => {
    const w = await createKeywordWatch(d1, ctx, { watchName: 'Ukraine', pattern: 'ukraine' });
    const list = await listKeywordWatches(d1);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(w.id);
  });

  it('with activeOnly=false includes inactive rows', async () => {
    const w = await createKeywordWatch(d1, ctx, { watchName: 'A', pattern: 'a' });
    await toggleKeywordWatch(d1, ctx, w.id, false);
    const onlyActive = await listKeywordWatches(d1, true);
    expect(onlyActive).toHaveLength(0);
    const all = await listKeywordWatches(d1, false);
    expect(all).toHaveLength(1);
    expect(all[0]!.active).toBe(0);
  });
});

describe('ingest-store: createKeywordWatch', () => {
  it('inserts with sane defaults (active=1, notify=1, is_regex=0)', async () => {
    const w = await createKeywordWatch(d1, ctx, { watchName: 'Aid', pattern: 'aid' });
    expect(w.active).toBe(1);
    expect(w.notify).toBe(1);
    expect(w.is_regex).toBe(0);
    expect(w.created_by).toBe('curator@example.com');
    expect(w.created_at).toMatch(/T/);
  });

  it('honors isRegex=true and notify=false', async () => {
    const w = await createKeywordWatch(d1, ctx, {
      watchName: 'Re',
      pattern: '^ukraine',
      isRegex: true,
      notify: false,
    });
    expect(w.is_regex).toBe(1);
    expect(w.notify).toBe(0);
  });

  it('writes an audit_log row alongside the insert (atomic via batch)', async () => {
    await createKeywordWatch(d1, ctx, { watchName: 'X', pattern: 'x' });
    const audits = d1.tables.audit_log!;
    expect(audits).toHaveLength(1);
    expect(audits[0]!['target_table']).toBe('social_keyword_watches');
    expect(audits[0]!['action']).toBe('create');
    expect(audits[0]!['actor_email']).toBe('curator@example.com');
    expect(audits[0]!['trace_id']).toBe('tr_test_00000001');
    // 3-statement batch: ensureResearcher + insert + audit
    expect(d1.lastBatchSize).toBe(3);
  });
});

describe('ingest-store: toggleKeywordWatch', () => {
  it('flips active to 0 then back to 1, with audit rows', async () => {
    const w = await createKeywordWatch(d1, ctx, { watchName: 'T', pattern: 't' });
    await toggleKeywordWatch(d1, ctx, w.id, false);
    let all = await listKeywordWatches(d1, false);
    expect(all[0]!.active).toBe(0);
    await toggleKeywordWatch(d1, ctx, w.id, true);
    all = await listKeywordWatches(d1, false);
    expect(all[0]!.active).toBe(1);
    // create + 2 toggles = 3 audit rows
    expect(d1.tables.audit_log).toHaveLength(3);
  });

  it('still records an audit row even when the target row is missing (before=null)', async () => {
    await toggleKeywordWatch(d1, ctx, '01HZZZZZZZZZZZZZZZZZZZZZZZ', false);
    const audits = d1.tables.audit_log!;
    expect(audits).toHaveLength(1);
    expect(audits[0]!['action']).toBe('update');
    expect(audits[0]!['target_table']).toBe('social_keyword_watches');
    expect(audits[0]!['before_json']).toBeNull();
    expect(audits[0]!['after_json']).toBeNull();
  });
});

/* Type-only assertion: prove the public types are reachable from this file. */
const _typeProbe = ((): SocialHandleRow | QueueRow | KeywordWatchRow | null => null)();
void _typeProbe;
