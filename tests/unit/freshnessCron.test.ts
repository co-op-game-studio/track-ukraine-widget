/**
 * AC-52.49 — scaling-backoff freshness cron logic.
 *
 * Pure-function tests on the freshness math + due-check helpers. The cron
 * orchestrator itself (runFreshnessCron) does I/O; here we verify the
 * decision functions in isolation so the integration test only needs to
 * trust them.
 *
 * Backoff schedule:
 *   < 24h    → recheck every 1h
 *   < 7d     → recheck every 3h
 *   < 30d    → recheck every 12h
 *   ≥ 30d    → recheck every 24h
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshnessIntervalMs, isFreshnessDue } from '../../proxy/services/import-bill';
import { runFreshnessCron } from '../../proxy/services/freshness-cron';
import type {
  ProxyEnv,
  D1Like,
  D1PreparedStatementLike,
  D1ResultLike,
  KVLike,
} from '../../proxy/env';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-05-03T12:00:00Z');

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe('freshnessIntervalMs (AC-52.49 scaling backoff)', () => {
  it('< 24h ago → 1-hour interval', () => {
    expect(freshnessIntervalMs(ago(2 * HOUR), NOW)).toBe(1 * HOUR);
    expect(freshnessIntervalMs(ago(23 * HOUR), NOW)).toBe(1 * HOUR);
  });

  it('boundary: exactly 24h ago → 3-hour bucket (24h is not < 24h)', () => {
    expect(freshnessIntervalMs(ago(24 * HOUR), NOW)).toBe(3 * HOUR);
  });

  it('< 7d ago → 3-hour interval', () => {
    expect(freshnessIntervalMs(ago(2 * DAY), NOW)).toBe(3 * HOUR);
    expect(freshnessIntervalMs(ago(6 * DAY + 23 * HOUR), NOW)).toBe(3 * HOUR);
  });

  it('boundary: exactly 7d ago → 12-hour bucket', () => {
    expect(freshnessIntervalMs(ago(7 * DAY), NOW)).toBe(12 * HOUR);
  });

  it('< 30d ago → 12-hour interval', () => {
    expect(freshnessIntervalMs(ago(15 * DAY), NOW)).toBe(12 * HOUR);
    expect(freshnessIntervalMs(ago(29 * DAY), NOW)).toBe(12 * HOUR);
  });

  it('≥ 30d ago → 24-hour interval', () => {
    expect(freshnessIntervalMs(ago(30 * DAY), NOW)).toBe(24 * HOUR);
    expect(freshnessIntervalMs(ago(365 * DAY), NOW)).toBe(24 * HOUR);
  });

  it('current-moment timestamp → 1-hour bucket (not negative)', () => {
    // age = 0; the < 24h branch catches it.
    expect(freshnessIntervalMs(ago(0), NOW)).toBe(1 * HOUR);
  });
});

describe('isFreshnessDue (AC-52.49)', () => {
  it('null lastCheck → always due (first time the cron sees this bill)', () => {
    expect(isFreshnessDue(ago(2 * HOUR), null, NOW)).toBe(true);
    expect(isFreshnessDue(ago(365 * DAY), null, NOW)).toBe(true);
  });

  it('recent bill, last checked 30 min ago → NOT due (interval is 1h)', () => {
    expect(isFreshnessDue(ago(2 * HOUR), ago(30 * 60 * 1000), NOW)).toBe(false);
  });

  it('recent bill, last checked 61 min ago → due (interval is 1h)', () => {
    expect(isFreshnessDue(ago(2 * HOUR), ago(61 * 60 * 1000), NOW)).toBe(true);
  });

  it('week-old bill, last checked 2h ago → NOT due (interval is 3h)', () => {
    expect(isFreshnessDue(ago(3 * DAY), ago(2 * HOUR), NOW)).toBe(false);
  });

  it('week-old bill, last checked 4h ago → due (interval is 3h)', () => {
    expect(isFreshnessDue(ago(3 * DAY), ago(4 * HOUR), NOW)).toBe(true);
  });

  it('month-old bill, last checked 6h ago → NOT due (interval is 12h)', () => {
    expect(isFreshnessDue(ago(15 * DAY), ago(6 * HOUR), NOW)).toBe(false);
  });

  it('ancient bill, last checked 23h ago → NOT due (interval is 24h)', () => {
    expect(isFreshnessDue(ago(180 * DAY), ago(23 * HOUR), NOW)).toBe(false);
  });

  it('ancient bill, last checked 25h ago → due (interval is 24h)', () => {
    expect(isFreshnessDue(ago(180 * DAY), ago(25 * HOUR), NOW)).toBe(true);
  });

  it('exact-interval boundary: equal age → due (≥ comparison)', () => {
    // 1h ago bill, last checked exactly 1h ago.
    expect(isFreshnessDue(ago(2 * HOUR), ago(1 * HOUR), NOW)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*               runFreshnessCron orchestrator (AC-52.49)                     */
/* -------------------------------------------------------------------------- */

/**
 * Tiny purpose-built FakeD1 — only handles the queries runFreshnessCron and
 * the cached short-circuit path inside importBillFromCongress emit:
 *
 *   - SELECT bill_id, congress, type, number, updated_at, last_freshness_check_at FROM bills  (.all)
 *   - SELECT * FROM bills WHERE bill_id = ?                                                   (.first)
 *   - UPDATE bills SET last_freshness_check_at = ? WHERE bill_id = ?                          (.run)
 *
 * Anything else throws, which is intentional — if a test exercises a new
 * code path we want it to fail loudly rather than silently no-op.
 */
interface BillRow {
  id?: string;
  bill_id: string;
  congress: number;
  type: string;
  number: string;
  updated_at: string;
  last_freshness_check_at: string | null;
  congress_update_date?: string | null;
  direction?: string;
  direction_reason?: string | null;
  featured?: number;
  label?: string | null;
}

class FreshnessFakeD1 implements D1Like {
  bills: BillRow[] = [];

  prepare(query: string): D1PreparedStatementLike {
    return new FreshnessFakeStmt(this, query, []);
  }

  async batch<T>(): Promise<D1ResultLike<T>[]> {
    throw new Error('batch not implemented in FreshnessFakeD1');
  }

  async exec(): Promise<{ count: number; duration: number }> {
    return { count: 0, duration: 0 };
  }
}

class FreshnessFakeStmt implements D1PreparedStatementLike {
  constructor(
    private d1: FreshnessFakeD1,
    private query: string,
    private bindings: unknown[],
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new FreshnessFakeStmt(this.d1, this.query, [...this.bindings, ...values]);
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
    const q = this.query.replace(/\s+/g, ' ').trim();

    // SELECT roster (used by runFreshnessCron itself).
    if (/^SELECT bill_id, congress, type, number, updated_at, last_freshness_check_at FROM bills$/i.test(q)) {
      return { success: true, results: this.d1.bills.map((r) => ({ ...r })) };
    }

    // SELECT * FROM bills WHERE bill_id = ?  (used by importBillFromCongress).
    if (/^SELECT \* FROM bills WHERE bill_id = \?$/i.test(q)) {
      const want = this.bindings[0] as string;
      const found = this.d1.bills.find((r) => r.bill_id === want);
      return { success: true, results: found ? [{ ...found }] : [] };
    }

    // UPDATE bills SET last_freshness_check_at = ? WHERE bill_id = ?
    if (/^UPDATE bills SET last_freshness_check_at = \? WHERE bill_id = \?$/i.test(q)) {
      const ts = this.bindings[0] as string;
      const billId = this.bindings[1] as string;
      const idx = this.d1.bills.findIndex((r) => r.bill_id === billId);
      if (idx === -1) return { success: true, meta: { changes: 0 } };
      this.d1.bills[idx] = { ...this.d1.bills[idx]!, last_freshness_check_at: ts };
      return { success: true, meta: { changes: 1 } };
    }

    throw new Error(`unhandled query in FreshnessFakeD1: ${q}`);
  }
}

const noopKv: KVLike = {
  async get() { return null; },
  async put() {},
  async list() { return { keys: [], list_complete: true }; },
  async delete() {},
};

function makeEnv(overrides: Partial<ProxyEnv> = {}): ProxyEnv {
  return {
    CONGRESS_API_KEY: 'test-key',
    KV_VOTER_INFO: noopKv,
    ENV_NAME: 'test',
    ...overrides,
  };
}

describe('runFreshnessCron — orchestrator', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('early-returns zeros when D1 binding is absent (no_d1 path)', async () => {
    const env = makeEnv({ D1_VOTER_INFO: undefined });
    const result = await runFreshnessCron(env, 'https://worker.example');
    expect(result).toEqual({ checked: 0, refreshed: 0, skipped: 0, errors: 0 });
  });

  it('also handles env with no ENV_NAME — uses "unknown" in log context', async () => {
    const env = makeEnv({ D1_VOTER_INFO: undefined, ENV_NAME: undefined });
    const result = await runFreshnessCron(env, 'https://worker.example');
    expect(result).toEqual({ checked: 0, refreshed: 0, skipped: 0, errors: 0 });
  });

  it('returns zeros when bills table is empty', async () => {
    const d1 = new FreshnessFakeD1();
    const env = makeEnv({ D1_VOTER_INFO: d1 });
    const result = await runFreshnessCron(env, 'https://worker.example');
    expect(result).toEqual({ checked: 0, refreshed: 0, skipped: 0, errors: 0 });
  });

  it('skips bills whose freshness window has not elapsed (continue branch)', async () => {
    const d1 = new FreshnessFakeD1();
    const now = new Date('2026-05-03T12:00:00Z');
    // Bill last checked 30 min ago, updated 2h ago → 1h interval, NOT due.
    d1.bills.push({
      bill_id: '118-HR-1',
      congress: 118,
      type: 'HR',
      number: '1',
      updated_at: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      last_freshness_check_at: new Date(now.getTime() - 30 * 60 * 1000).toISOString(),
    });
    const env = makeEnv({ D1_VOTER_INFO: d1 });
    const result = await runFreshnessCron(env, 'https://worker.example', now);
    expect(result.checked).toBe(0);
    expect(result.refreshed).toBe(0);
    // The not-due row remains untouched.
    expect(d1.bills[0]!.last_freshness_check_at).not.toBe(now.toISOString());
  });

  it('caps refreshes per run + counts the rest as skipped (rate-limit branch)', async () => {
    const d1 = new FreshnessFakeD1();
    const now = new Date('2026-05-03T12:00:00Z');
    // 30 due bills (null last_check) — past the cap of 25.
    for (let i = 0; i < 30; i++) {
      d1.bills.push({
        bill_id: `118-HR-${i}`,
        congress: 118,
        type: 'HR',
        number: String(i),
        updated_at: now.toISOString(),
        last_freshness_check_at: null,
        // Pre-seeded so the cached short-circuit fires (no fetch needed for the
        // first 25; the remaining 5 never get touched).
        congress_update_date: 'X',
      });
    }
    // Stub fetch to return the matching updateDate so importBillFromCongress
    // hits its cache short-circuit path (cached:true) for every refresh.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ bill: { updateDate: 'X', title: 't' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch;
    const env = makeEnv({ D1_VOTER_INFO: d1 });
    const result = await runFreshnessCron(env, 'https://worker.example', now);
    expect(result.refreshed).toBe(25);
    expect(result.checked).toBe(25);
    expect(result.skipped).toBe(5);
    expect(result.errors).toBe(0);
  });

  it('on cached:true, stamps last_freshness_check_at to now', async () => {
    const d1 = new FreshnessFakeD1();
    const now = new Date('2026-05-03T12:00:00Z');
    d1.bills.push({
      bill_id: '118-HR-77',
      congress: 118,
      type: 'HR',
      number: '77',
      updated_at: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      last_freshness_check_at: null,
      congress_update_date: 'UNCHANGED',
    });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ bill: { updateDate: 'UNCHANGED', title: 't' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch;
    const env = makeEnv({ D1_VOTER_INFO: d1 });
    const result = await runFreshnessCron(env, 'https://worker.example', now);
    expect(result.checked).toBe(1);
    expect(result.refreshed).toBe(1);
    expect(result.errors).toBe(0);
    expect(d1.bills[0]!.last_freshness_check_at).toBe(now.toISOString());
  });

  it('counts errors when importBillFromCongress throws (CONGRESS_API_KEY missing)', async () => {
    const d1 = new FreshnessFakeD1();
    const now = new Date('2026-05-03T12:00:00Z');
    d1.bills.push({
      bill_id: '118-HR-9',
      congress: 118,
      type: 'HR',
      number: '9',
      updated_at: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      last_freshness_check_at: null,
    });
    // No CONGRESS_API_KEY → fetchCongress throws synchronously inside the import.
    const env = makeEnv({
      D1_VOTER_INFO: d1,
      CONGRESS_API_KEY: '',
    });
    const result = await runFreshnessCron(env, 'https://worker.example', now);
    expect(result.checked).toBe(1);
    expect(result.refreshed).toBe(0);
    expect(result.errors).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('mixes due + not-due bills correctly (only due rows count toward checked)', async () => {
    const d1 = new FreshnessFakeD1();
    const now = new Date('2026-05-03T12:00:00Z');
    // Not due: checked recently.
    d1.bills.push({
      bill_id: '118-HR-A',
      congress: 118,
      type: 'HR',
      number: 'A',
      updated_at: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      last_freshness_check_at: new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
    });
    // Due: never checked.
    d1.bills.push({
      bill_id: '118-HR-B',
      congress: 118,
      type: 'HR',
      number: 'B',
      updated_at: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      last_freshness_check_at: null,
      congress_update_date: 'Y',
    });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ bill: { updateDate: 'Y', title: 't' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch;
    const env = makeEnv({ D1_VOTER_INFO: d1 });
    const result = await runFreshnessCron(env, 'https://worker.example', now);
    expect(result.checked).toBe(1);
    expect(result.refreshed).toBe(1);
  });

  it('uses default `now = new Date()` when omitted', async () => {
    const d1 = new FreshnessFakeD1();
    const env = makeEnv({ D1_VOTER_INFO: d1 });
    // Empty bills → just exercises the default-arg path.
    const result = await runFreshnessCron(env, 'https://worker.example');
    expect(result).toEqual({ checked: 0, refreshed: 0, skipped: 0, errors: 0 });
  });
});
