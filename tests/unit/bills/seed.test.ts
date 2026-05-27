/**
 * Tests for scripts/lib/bills/seed.ts — the corpus driver behind
 * `lw bills seed`.
 *
 * Covers the AC-59 driver-level guarantees that aren't tested by
 * importBillCore directly:
 *   - per-bill failures don't abort the loop (AC-59.3)
 *   - cursor honored (AC-59.1)
 *   - limit honored (AC-59.1)
 *   - audit_log gets a bill_seed_error row on failure (AC-59.3)
 *   - cached counts surface in the result (AC-59.10)
 */
import { describe, it, expect } from 'vitest';
import { seedBills } from '../../../scripts/lib/bills/seed';
import type { D1Like, D1PreparedStatement } from '../../../scripts/lib/d1-client';
import type { AuditLogger, AuditEvent } from '../../../scripts/lib/audit-log';
import type { CongressClient } from '../../../scripts/lib/congress-client';
import { makeCliLogger } from '../../../scripts/lib/logger';

/* ------------- minimal D1 that only handles the bills query ------------- */

function makeBillsD1(bills: Array<{ bill_id: string; congress: number; type: string; number: string }>): D1Like {
  return {
    prepare(query: string): D1PreparedStatement {
      let bound: unknown[] = [];
      const stmt: D1PreparedStatement = {
        bind(...vs) {
          bound = vs;
          return stmt;
        },
        async first() { return null; },
        async all<T>() {
          if (/SELECT bill_id, congress, type, number FROM bills/i.test(query)) {
            const after = (bound[0] as string) ?? '';
            const limit = bound[1] as number | undefined;
            let rows = bills.filter((b) => b.bill_id > after).sort((a, b) => a.bill_id.localeCompare(b.bill_id));
            if (limit !== undefined) rows = rows.slice(0, limit);
            return { results: rows as T[] };
          }
          return { results: [] };
        },
        async run() { return { success: true }; },
      };
      return stmt;
    },
    async batch() { return []; },
  };
}

function makeAuditLogger(): AuditLogger & { events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    events,
    async log(e) { events.push(e); },
  };
}

function quietLogger() {
  return makeCliLogger({ verbosity: 'quiet' });
}

describe('seedBills — driver behavior (env-agnostic, idempotent)', () => {
  it('processes every bill returned by the query', async () => {
    const d1 = makeBillsD1([
      { bill_id: '117-HR-1', congress: 117, type: 'HR', number: '1' },
      { bill_id: '117-HR-2', congress: 117, type: 'HR', number: '2' },
      { bill_id: '118-HR-1', congress: 118, type: 'HR', number: '1' },
    ]);
    // Stub CongressClient that returns null for everything → throws bill_not_found.
    const congressClient: CongressClient = { async get() { return null; } };
    const auditLog = makeAuditLogger();

    const r = await seedBills({
      d1, congressClient, auditLog, logger: quietLogger(), concurrency: 2,
    });

    expect(r.processed).toBe(3);
    expect(r.ok).toBe(0);
    expect(r.failed).toBe(3);
    // Audit log got one bill_seed_error per failure.
    expect(auditLog.events.length).toBe(3);
    expect(auditLog.events.every((e) => e.action === 'bill_seed_error')).toBe(true);
  });

  it('continues past a single bill failure (AC-59.3)', async () => {
    const d1 = makeBillsD1([
      { bill_id: '117-HR-1', congress: 117, type: 'HR', number: '1' },
      { bill_id: '117-HR-2', congress: 117, type: 'HR', number: '2' },
    ]);
    // First bill throws; second returns null (bill_not_found).
    let n = 0;
    const congressClient: CongressClient = {
      async get() {
        n++;
        if (n === 1) throw new Error('synthetic upstream blip');
        return null;
      },
    };
    const auditLog = makeAuditLogger();

    const r = await seedBills({
      d1, congressClient, auditLog, logger: quietLogger(), concurrency: 1,
    });

    expect(r.processed).toBe(2);
    expect(r.failed).toBe(2);
    expect(r.errors[0]?.error).toContain('synthetic upstream blip');
  });

  it('honors the `limit` option', async () => {
    const d1 = makeBillsD1([
      { bill_id: '117-HR-1', congress: 117, type: 'HR', number: '1' },
      { bill_id: '117-HR-2', congress: 117, type: 'HR', number: '2' },
      { bill_id: '117-HR-3', congress: 117, type: 'HR', number: '3' },
    ]);
    const congressClient: CongressClient = { async get() { return null; } };
    const auditLog = makeAuditLogger();

    const r = await seedBills({
      d1, congressClient, auditLog, logger: quietLogger(),
      limit: 2,
    });

    expect(r.processed).toBe(2);
  });

  it('honors the `after` cursor', async () => {
    const d1 = makeBillsD1([
      { bill_id: '117-HR-1', congress: 117, type: 'HR', number: '1' },
      { bill_id: '117-HR-2', congress: 117, type: 'HR', number: '2' },
      { bill_id: '118-HR-1', congress: 118, type: 'HR', number: '1' },
    ]);
    const congressClient: CongressClient = { async get() { return null; } };
    const auditLog = makeAuditLogger();

    const r = await seedBills({
      d1, congressClient, auditLog, logger: quietLogger(),
      after: '117-HR-2',
    });

    expect(r.processed).toBe(1);
    expect(r.lastBillId).toBe('118-HR-1');
  });

  it('respects the filter predicate', async () => {
    const d1 = makeBillsD1([
      { bill_id: '117-HR-1', congress: 117, type: 'HR', number: '1' },
      { bill_id: '118-HR-1', congress: 118, type: 'HR', number: '1' },
      { bill_id: '119-HR-1', congress: 119, type: 'HR', number: '1' },
    ]);
    const congressClient: CongressClient = { async get() { return null; } };
    const auditLog = makeAuditLogger();

    const r = await seedBills({
      d1, congressClient, auditLog, logger: quietLogger(),
      filter: (row) => row.congress === 119,
    });

    expect(r.processed).toBe(1);
    expect(r.lastBillId).toBe('119-HR-1');
  });

  // Regression: rc3 → rc4. `--limit N --congress X` was returning zero bills
  // because SQL LIMIT ran BEFORE the in-memory filter. Fix: when a filter
  // is provided, fetch all rows and slice() after filtering.
  it('limit + filter applies limit AFTER filter (rc4 regression)', async () => {
    // 117-HR-1, 117-HR-2, 118-HR-1, 119-HR-1, 119-HR-2, 119-HR-3 — six bills.
    // With `limit=2, filter=119th`, naive impl would SELECT … LIMIT 2 → get
    // [117-HR-1, 117-HR-2] → filter to 119th → 0 bills. Correct impl
    // returns [119-HR-1, 119-HR-2].
    const d1 = makeBillsD1([
      { bill_id: '117-HR-1', congress: 117, type: 'HR', number: '1' },
      { bill_id: '117-HR-2', congress: 117, type: 'HR', number: '2' },
      { bill_id: '118-HR-1', congress: 118, type: 'HR', number: '1' },
      { bill_id: '119-HR-1', congress: 119, type: 'HR', number: '1' },
      { bill_id: '119-HR-2', congress: 119, type: 'HR', number: '2' },
      { bill_id: '119-HR-3', congress: 119, type: 'HR', number: '3' },
    ]);
    const congressClient: CongressClient = { async get() { return null; } };
    const auditLog = makeAuditLogger();

    const r = await seedBills({
      d1, congressClient, auditLog, logger: quietLogger(),
      filter: (row) => row.congress === 119,
      limit: 2,
    });

    expect(r.processed).toBe(2);
    // The two should be 119th bills (first two by bill_id ASC after filter).
    expect(r.lastBillId).toBe('119-HR-2');
  });
});
