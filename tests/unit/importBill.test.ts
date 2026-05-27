/**
 * Tests for proxy/services/import-bill.ts.
 *
 * Covers `importBillFromCongress` orchestration:
 *   - happy path: bill detail + summaries + actions + cosponsors → D1 batch
 *   - new vs existing bill row (insert vs update)
 *   - cache-hit short circuit when upstream updateDate is unchanged
 *   - bill_not_found when /v3/bill/... returns 404
 *   - missing CONGRESS_API_KEY throws before any work
 *   - cosponsor pagination breaks after a short page
 *   - actions with recordedVotes seed roll-call rows; House detail is
 *     fetched, Senate is skipped
 *   - per-vote staleness gate skips matched-update-date rows
 *   - freshness helpers: freshnessIntervalMs / isFreshnessDue
 *
 * Mocks:
 *   - globalThis.fetch is keyed by URL pattern (mirrors
 *     importBillCongressionalRecord.test.ts style — direct api.congress.gov
 *     URLs since the orchestrator no longer same-Worker subrequests).
 *   - D1 is the same in-memory FakeD1 pattern as adminStore.test.ts but
 *     trimmed to the small SQL surface this orchestrator issues.
 *   - KV is a tiny inline KVLike implementation (delete is the only call).
 *
 * Traces: AC-52.46, AC-52.49, AC-52.50, AC-52.58, AC-52.59.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  importBillFromCongress,
  freshnessIntervalMs,
  isFreshnessDue,
} from '../../proxy/services/import-bill';
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
    bills: [],
    votes: [],
    bill_cosponsors: [],
    bill_actions: [],
    audit_log: [],
    researchers: [],
  };

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
    const q = this.query.trim();

    // ---- INSERT — handles inline literals (`0`, `NULL`, `'string'`) by
    //      walking the VALUES clause and pulling from bindings only on `?`.
    const insMatch = q.match(/^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s+VALUES\s*\(([^)]+)\)/is);
    if (insMatch) {
      const table = insMatch[1]!;
      const cols = insMatch[2]!.split(',').map((c) => c.trim());
      const valTokens = insMatch[3]!.split(',').map((v) => v.trim());
      const row: Record<string, unknown> = {};
      let bindIdx = 0;
      cols.forEach((c, i) => {
        const tok = valTokens[i];
        if (tok === '?') {
          row[c] = this.bindings[bindIdx++] ?? null;
        } else if (!tok || /^NULL$/i.test(tok)) {
          row[c] = null;
        } else if (/^'.*'$/.test(tok)) {
          row[c] = tok.slice(1, -1);
        } else if (/^-?\d+(\.\d+)?$/.test(tok)) {
          row[c] = Number(tok);
        } else {
          row[c] = tok; // fallback
        }
      });
      this.d1.tables[table] = this.d1.tables[table] ?? [];
      this.d1.tables[table]!.push(row);
      return { success: true, meta: { changes: 1 } };
    }

    // ---- UPDATE bills SET … WHERE bill_id = ? ----
    const updBillMatch = q.match(/^UPDATE\s+bills\s+SET\s+(.+?)\s+WHERE\s+bill_id\s*=\s*\?/is);
    if (updBillMatch) {
      const setClause = updBillMatch[1]!;
      const fields = setClause.split(',').map((f) => f.split('=')[0]!.trim());
      const billId = this.bindings[this.bindings.length - 1] as string;
      const rows = this.d1.tables.bills ?? [];
      const idx = rows.findIndex((r) => r['bill_id'] === billId);
      if (idx === -1) return { success: true, meta: { changes: 0 } };
      const row = { ...rows[idx]! };
      fields.forEach((f, i) => { row[f] = this.bindings[i] ?? null; });
      rows[idx] = row;
      return { success: true, meta: { changes: 1 } };
    }

    // ---- UPDATE votes SET … WHERE id = ? ----
    const updVoteMatch = q.match(/^UPDATE\s+votes\s+SET\s+(.+?)\s+WHERE\s+id\s*=\s*\?/is);
    if (updVoteMatch) {
      const setClause = updVoteMatch[1]!;
      const fields = setClause.split(',').map((f) => f.split('=')[0]!.trim());
      const id = this.bindings[this.bindings.length - 1] as string;
      const rows = this.d1.tables.votes ?? [];
      const idx = rows.findIndex((r) => r['id'] === id);
      if (idx === -1) return { success: true, meta: { changes: 0 } };
      const row = { ...rows[idx]! };
      fields.forEach((f, i) => { row[f] = this.bindings[i] ?? null; });
      rows[idx] = row;
      return { success: true, meta: { changes: 1 } };
    }

    // ---- DELETE FROM <table> WHERE bill_id = ? ----
    const delMatch = q.match(/^DELETE\s+FROM\s+(\w+)\s+WHERE\s+bill_id\s*=\s*\?/i);
    if (delMatch) {
      const table = delMatch[1]!;
      const billId = this.bindings[0];
      const rows = this.d1.tables[table] ?? [];
      this.d1.tables[table] = rows.filter((r) => r['bill_id'] !== billId);
      return { success: true, meta: { changes: rows.length - this.d1.tables[table]!.length } };
    }

    // ---- SELECT * FROM bills WHERE bill_id = ?
    if (/^SELECT\s+\*\s+FROM\s+bills\s+WHERE\s+bill_id\s*=\s*\?/i.test(q)) {
      const billId = this.bindings[0];
      const rows = (this.d1.tables.bills ?? []).filter((r) => r['bill_id'] === billId);
      return { success: true, results: rows };
    }

    // ---- SELECT id, chamber, congress, session, roll_call, congress_update_date FROM votes WHERE bill_id = ?
    if (/SELECT\s+id,\s*chamber,\s*congress,\s*session,\s*roll_call,\s*congress_update_date\s+FROM\s+votes\s+WHERE\s+bill_id\s*=\s*\?/i.test(q)) {
      const billId = this.bindings[0];
      const rows = (this.d1.tables.votes ?? []).filter((r) => r['bill_id'] === billId);
      return { success: true, results: rows };
    }

    throw new Error(`unhandled query in fake D1: ${q}`);
  }
}

/* -------------------------------------------------------------------------- */
/*                              In-memory KVLike                              */
/* -------------------------------------------------------------------------- */

function makeKv(): KVLike & { _store: Map<string, string>; _deletes: string[] } {
  const store = new Map<string, string>();
  const deletes: string[] = [];
  return {
    _store: store,
    _deletes: deletes,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async list({ prefix }: { prefix: string; cursor?: string }) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
      return { keys: keys.map((name) => ({ name })), list_complete: true };
    },
    async delete(key: string) {
      deletes.push(key);
      store.delete(key);
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                              Fixtures + helpers                            */
/* -------------------------------------------------------------------------- */

function makeEnv(d1: FakeD1, kv: KVLike, opts?: { apiKey?: string | null }): ProxyEnv {
  return {
    CONGRESS_API_KEY: opts?.apiKey === null ? undefined : (opts?.apiKey ?? 'TEST_KEY'),
    KV_VOTER_INFO: kv,
    D1_VOTER_INFO: d1 as unknown as D1Like,
    ENV_NAME: 'test',
  } as unknown as ProxyEnv;
}

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
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

/** Default canned responses for the four endpoint families a typical import hits. */
function defaultUpstream(opts: {
  detail: unknown;
  summaries?: unknown;
  actions?: unknown;
  cosponsors?: unknown;
  houseVote?: unknown;
}): FetchCase[] {
  return [
    // House roll-call detail. Match BEFORE the bare `/v3/bill/` rule below.
    { match: (u) => u.includes('/v3/house-vote/'), respond: () => opts.houseVote ?? { houseRollCallVote: { updateDate: '2022-03-15T00:00:00Z' } } },
    // Bill cosponsors.
    { match: (u) => u.includes('/cosponsors'), respond: () => opts.cosponsors ?? { cosponsors: [] } },
    // Bill actions.
    { match: (u) => u.includes('/actions'), respond: () => opts.actions ?? { actions: [] } },
    // Bill summaries.
    { match: (u) => u.includes('/summaries'), respond: () => opts.summaries ?? { summaries: [] } },
    // Bill detail (catch-all for /v3/bill/{c}/{t}/{n}).
    { match: (u) => /\/v3\/bill\/\d+\//.test(u), respond: () => opts.detail },
  ];
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

describe('importBillFromCongress — happy paths', () => {
  it('creates a new bill row with sponsor + summary + cosponsors + actions + votes', async () => {
    installFetch(defaultUpstream({
      detail: {
        bill: {
          title: 'Ukraine Supplemental Appropriations Act',
          updateDate: '2022-03-15T00:00:00Z',
          latestAction: { actionDate: '2022-03-15', text: 'Became Public Law' },
          laws: [{ number: '117-103' }],
          congressGovUrl: 'https://www.congress.gov/bill/117th/hr/2471',
          introducedDate: '2021-04-13',
          sponsors: [{ bioguideId: 'D000001', fullName: 'Jane Doe', party: 'D', state: 'CA' }],
        },
      },
      summaries: { summaries: [{ actionDesc: 'Public Law', text: 'Aid for Ukraine.', updateDate: '2022-03-15' }] },
      actions: {
        actions: [
          {
            actionDate: '2022-03-09',
            text: 'On passage. (text: CR H1405-1407)',
            actionCode: 'H38310',
            sourceSystem: { name: 'House' },
            recordedVotes: [{ chamber: 'House', congress: 117, sessionNumber: 2, rollNumber: 65, url: 'https://clerk.house.gov/evs/2022/roll065.xml', date: '2022-03-10T02:49:07Z' }],
          },
          {
            actionDate: '2022-03-10',
            text: 'On agreement.',
            sourceSystem: { name: 'Senate' },
            recordedVotes: [{ chamber: 'Senate', congress: 117, sessionNumber: 2, rollNumber: 78, date: '2022-03-11' }],
          },
        ],
      },
      cosponsors: {
        cosponsors: [
          { bioguideId: 'C000001', fullName: 'Cosponsor One', party: 'D', state: 'NY', district: '12', isOriginalCosponsor: true, sponsorshipDate: '2021-04-13' },
          { bioguideId: 'C000002', fullName: 'Cosponsor Two', party: 'R', state: 'TX', sponsorshipDate: '2021-05-01', sponsorshipWithdrawnDate: '2021-06-01' },
          { fullName: 'Missing bioguide — must be skipped' },
        ],
      },
      houseVote: { houseRollCallVote: { updateDate: '2022-03-10T08:00:00Z' } },
    }));

    const env = makeEnv(d1, kv);
    const result = await importBillFromCongress(
      { congress: 117, type: 'HR', number: '2471', actorEmail: 'r@example.com', traceId: 'tr1' },
      { env, workerOrigin: 'https://test.example' },
    );

    expect(result.cached).toBe(false);
    expect(result.votes_imported).toBe(2);
    expect(result.cosponsors_imported).toBe(2); // skips the row missing bioguideId
    expect(result.actions_imported).toBe(2);
    expect(result.bill.bill_id).toBe('117-HR-2471');
    expect(result.bill.title).toContain('Ukraine');

    // Bill row written.
    const bill = d1.tables.bills![0]!;
    expect(bill['title']).toContain('Ukraine');
    expect(bill['became_law']).toBe(1);
    expect(bill['sponsor_bioguide_id']).toBe('D000001');
    expect(bill['summary_json']).toBeTruthy();

    // Votes seeded.
    expect(d1.tables.votes).toHaveLength(2);
    // Cosponsors / actions written.
    expect(d1.tables.bill_cosponsors).toHaveLength(2);
    expect(d1.tables.bill_actions).toHaveLength(2);
    // CR citation extracted on the first action.
    const crAction = d1.tables.bill_actions!.find((a) => String(a['action_text']).includes('CR H1405'));
    expect(crAction?.['congressional_record_citation']).toBe('H1405-1407');
    // Audit row written.
    expect(d1.tables.audit_log).toHaveLength(1);
    expect(d1.tables.audit_log![0]!['action']).toBe('import_bill');
    // KV invalidation called for the bill.
    expect(kv._deletes).toContain('bill:v1:117-HR-2471');
  });

  it('updates an existing bill row instead of inserting (preserves curation)', async () => {
    // Pre-seed an existing row with researcher curation.
    d1.tables.bills!.push({
      id: 'preexisting',
      bill_id: '117-HR-2471',
      direction: 'pro-ukraine',
      direction_reason: 'manual review',
      featured: 1,
      label: 'flagship',
      congress_update_date: '2020-01-01T00:00:00Z',
      title: 'Old title',
    });
    installFetch(defaultUpstream({
      detail: {
        bill: {
          title: 'Refreshed Title',
          updateDate: '2022-04-01T00:00:00Z',
          latestAction: { actionDate: '2022-03-15', text: 'Became law' },
          laws: [{}],
          sponsors: [{ bioguideId: 'D000001', fullName: 'Sen. X', party: 'D', state: 'CA' }],
        },
      },
    }));
    const r = await importBillFromCongress(
      { congress: 117, type: 'HR', number: '2471', actorEmail: 'r@x', traceId: 't' },
      { env: makeEnv(d1, kv), workerOrigin: 'https://x' },
    );
    expect(r.cached).toBe(false);
    expect(r.bill.direction).toBe('pro-ukraine'); // preserved
    const updated = d1.tables.bills!.find((b) => b['id'] === 'preexisting')!;
    expect(updated['title']).toBe('Refreshed Title');
    expect(updated['featured']).toBe(1); // preserved (not in the UPDATE field set)
    expect(updated['label']).toBe('flagship');
    expect(updated['direction']).toBe('pro-ukraine'); // not overwritten
  });

  it('short-circuits with cached=true when upstream updateDate matches local row', async () => {
    d1.tables.bills!.push({
      id: 'p',
      bill_id: '117-HR-2471',
      direction: 'pro-ukraine',
      direction_reason: null,
      featured: 0,
      label: null,
      congress_update_date: '2022-03-15T00:00:00Z',
    });
    installFetch(defaultUpstream({
      detail: { bill: { title: 'No-op', updateDate: '2022-03-15T00:00:00Z' } },
    }));
    const r = await importBillFromCongress(
      { congress: 117, type: 'HR', number: '2471', actorEmail: 'r@x', traceId: 't' },
      { env: makeEnv(d1, kv), workerOrigin: 'https://x' },
    );
    expect(r.cached).toBe(true);
    expect(r.votes_skipped).toBe(-1);
    // No new bill row, no audit row.
    expect(d1.tables.bills).toHaveLength(1);
    expect(d1.tables.audit_log).toHaveLength(0);
  });

  it('force=true bypasses the cache short-circuit', async () => {
    d1.tables.bills!.push({
      id: 'p',
      bill_id: '117-HR-2471',
      direction: 'ambiguous',
      direction_reason: null,
      featured: 0,
      label: null,
      congress_update_date: '2022-03-15T00:00:00Z',
    });
    installFetch(defaultUpstream({
      detail: { bill: { title: 'Forced refresh', updateDate: '2022-03-15T00:00:00Z' } },
    }));
    const r = await importBillFromCongress(
      { congress: 117, type: 'HR', number: '2471', actorEmail: 'r@x', traceId: 't', force: true },
      { env: makeEnv(d1, kv), workerOrigin: 'https://x' },
    );
    expect(r.cached).toBe(false);
    expect(d1.tables.audit_log).toHaveLength(1);
  });
});

describe('importBillFromCongress — error paths', () => {
  it('throws bill_not_found when /v3/bill returns 404', async () => {
    installFetch([
      { match: (u) => /\/v3\/bill\/\d+\//.test(u), respond: () => ({}), status: 404 },
    ]);
    await expect(
      importBillFromCongress(
        { congress: 999, type: 'HR', number: '1', actorEmail: 'r@x', traceId: 't' },
        { env: makeEnv(d1, kv), workerOrigin: 'https://x' },
      ),
    ).rejects.toThrow(/bill_not_found/);
  });

  it('throws when CONGRESS_API_KEY is missing', async () => {
    installFetch([]); // anything would do — we never reach fetch
    await expect(
      importBillFromCongress(
        { congress: 117, type: 'HR', number: '2471', actorEmail: 'r@x', traceId: 't' },
        { env: makeEnv(d1, kv, { apiKey: null }), workerOrigin: 'https://x' },
      ),
    ).rejects.toThrow(/CONGRESS_API_KEY/);
  });

  it('propagates a non-2xx, non-404 from /v3/bill as a typed error', async () => {
    installFetch([
      { match: (u) => /\/v3\/bill\/\d+\//.test(u), respond: () => ({}), status: 500 },
    ]);
    await expect(
      importBillFromCongress(
        { congress: 117, type: 'HR', number: '2471', actorEmail: 'r@x', traceId: 't' },
        { env: makeEnv(d1, kv), workerOrigin: 'https://x' },
      ),
    ).rejects.toThrow(/congress_upstream_500/);
  });

  it('handles a /summaries fetch failure gracefully (caught .catch → null) — bill still imported', async () => {
    installFetch([
      // Force summaries to fail with non-404 (which would normally throw).
      { match: (u) => u.includes('/summaries'), respond: () => ({}), status: 502 },
      { match: (u) => u.includes('/cosponsors'), respond: () => ({ cosponsors: [] }) },
      { match: (u) => u.includes('/actions'), respond: () => ({ actions: [] }) },
      { match: (u) => /\/v3\/bill\/\d+\//.test(u), respond: () => ({ bill: { title: 'OK', updateDate: '2024-01-01' } }) },
    ]);
    const r = await importBillFromCongress(
      { congress: 117, type: 'HR', number: '2471', actorEmail: 'r@x', traceId: 't' },
      { env: makeEnv(d1, kv), workerOrigin: 'https://x' },
    );
    // Summary failure is non-fatal — bill row written with NULL summary_json.
    expect(r.cached).toBe(false);
    expect(d1.tables.bills![0]!['summary_json']).toBeNull();
  });

  it('handles a House roll-call detail fetch failure (per-vote try/catch)', async () => {
    installFetch([
      { match: (u) => u.includes('/v3/house-vote/'), respond: () => ({}), status: 502 },
      { match: (u) => u.includes('/cosponsors'), respond: () => ({ cosponsors: [] }) },
      { match: (u) => u.includes('/actions'), respond: () => ({
          actions: [{
            actionDate: '2022-03-09',
            text: 'On passage',
            recordedVotes: [{ chamber: 'House', congress: 117, sessionNumber: 2, rollNumber: 65, date: '2022-03-10' }],
          }],
        }) },
      { match: (u) => u.includes('/summaries'), respond: () => ({ summaries: [] }) },
      { match: (u) => /\/v3\/bill\/\d+\//.test(u), respond: () => ({ bill: { title: 'OK', updateDate: '2024-01-01' } }) },
    ]);
    const r = await importBillFromCongress(
      { congress: 117, type: 'HR', number: '2471', actorEmail: 'r@x', traceId: 't' },
      { env: makeEnv(d1, kv), workerOrigin: 'https://x' },
    );
    expect(r.votes_imported).toBe(1); // vote still inserted, just with null update date
  });
});

describe('importBillFromCongress — cosponsor pagination + per-vote staleness', () => {
  it('breaks the cosponsor loop when a page returns fewer than 250 items', async () => {
    let calls = 0;
    installFetch([
      { match: (u) => u.includes('/cosponsors'), respond: () => {
          calls++;
          // First page returns a partial set → loop breaks immediately.
          return { cosponsors: [{ bioguideId: 'A', fullName: 'A' }, { bioguideId: 'B', fullName: 'B' }] };
        } },
      { match: (u) => u.includes('/actions'), respond: () => ({ actions: [] }) },
      { match: (u) => u.includes('/summaries'), respond: () => ({ summaries: [] }) },
      { match: (u) => /\/v3\/bill\/\d+\//.test(u), respond: () => ({ bill: { title: 'X', updateDate: '2024-01-01' } }) },
    ]);
    const r = await importBillFromCongress(
      { congress: 117, type: 'HR', number: '2471', actorEmail: 'r@x', traceId: 't' },
      { env: makeEnv(d1, kv), workerOrigin: 'https://x' },
    );
    expect(r.cosponsors_imported).toBe(2);
    expect(calls).toBe(1);
  });

  it('skips a vote whose congress_update_date matches upstream (per-vote staleness)', async () => {
    // Pre-seed an existing vote whose update-date already matches what upstream will return.
    d1.tables.bills!.push({
      id: 'b1', bill_id: '117-HR-2471', direction: 'ambiguous', direction_reason: null,
      featured: 0, label: null, congress_update_date: '2020-01-01',
    });
    d1.tables.votes!.push({
      id: 'v_existing', bill_id: '117-HR-2471', chamber: 'House', congress: 117, session: 2, roll_call: 65,
      congress_update_date: '2022-03-10T08:00:00Z',
    });
    installFetch(defaultUpstream({
      detail: { bill: { title: 'X', updateDate: '2024-04-01T00:00:00Z' } },
      actions: { actions: [{
        actionDate: '2022-03-09', text: 'On passage',
        recordedVotes: [
          { chamber: 'House', congress: 117, sessionNumber: 2, rollNumber: 65, date: '2022-03-10' },
          // A second roll-call → fresh insert.
          { chamber: 'House', congress: 117, sessionNumber: 2, rollNumber: 66, date: '2022-03-10' },
        ],
      }] },
      houseVote: { houseRollCallVote: { updateDate: '2022-03-10T08:00:00Z' } },
    }));
    const r = await importBillFromCongress(
      { congress: 117, type: 'HR', number: '2471', actorEmail: 'r@x', traceId: 't' },
      { env: makeEnv(d1, kv), workerOrigin: 'https://x' },
    );
    expect(r.votes_skipped).toBe(1);
    expect(r.votes_imported).toBe(1); // roll 66 inserted
    expect(r.votes_updated).toBe(0);
  });

  it('updates an existing vote when upstream update-date moves forward', async () => {
    d1.tables.bills!.push({
      id: 'b1', bill_id: '117-HR-2471', direction: 'ambiguous', direction_reason: null,
      featured: 0, label: null, congress_update_date: '2020-01-01',
    });
    d1.tables.votes!.push({
      id: 'v_existing', bill_id: '117-HR-2471', chamber: 'House', congress: 117, session: 2, roll_call: 65,
      congress_update_date: '2020-01-01T00:00:00Z',
    });
    installFetch(defaultUpstream({
      detail: { bill: { title: 'X', updateDate: '2024-04-01T00:00:00Z' } },
      actions: { actions: [{
        actionDate: '2022-03-09', text: 'On passage',
        recordedVotes: [{ chamber: 'House', congress: 117, sessionNumber: 2, rollNumber: 65, date: '2022-03-10' }],
      }] },
      houseVote: { houseRollCallVote: { updateDate: '2024-04-01T00:00:00Z' } },
    }));
    const r = await importBillFromCongress(
      { congress: 117, type: 'HR', number: '2471', actorEmail: 'r@x', traceId: 't' },
      { env: makeEnv(d1, kv), workerOrigin: 'https://x' },
    );
    expect(r.votes_updated).toBe(1);
    expect(r.votes_skipped).toBe(0);
    expect(r.votes_imported).toBe(0);
  });
});

describe('freshnessIntervalMs / isFreshnessDue', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const NOW = new Date('2026-05-04T00:00:00Z').getTime();

  it('returns 1h for an entry updated within the last 24h', () => {
    const updated = new Date(NOW - 5 * HOUR).toISOString();
    expect(freshnessIntervalMs(updated, NOW)).toBe(1 * HOUR);
  });
  it('returns 3h for an entry updated within the last 7d', () => {
    const updated = new Date(NOW - 3 * DAY).toISOString();
    expect(freshnessIntervalMs(updated, NOW)).toBe(3 * HOUR);
  });
  it('returns 12h for an entry updated within the last 30d', () => {
    const updated = new Date(NOW - 14 * DAY).toISOString();
    expect(freshnessIntervalMs(updated, NOW)).toBe(12 * HOUR);
  });
  it('returns 24h for older entries', () => {
    const updated = new Date(NOW - 90 * DAY).toISOString();
    expect(freshnessIntervalMs(updated, NOW)).toBe(24 * HOUR);
  });
  it('isFreshnessDue is true when lastCheckAt is null', () => {
    expect(isFreshnessDue(new Date(NOW).toISOString(), null, NOW)).toBe(true);
  });
  it('isFreshnessDue is true when interval has elapsed', () => {
    const updated = new Date(NOW - 2 * HOUR).toISOString();
    const lastCheck = new Date(NOW - 2 * HOUR).toISOString();
    expect(isFreshnessDue(updated, lastCheck, NOW)).toBe(true);
  });
  it('isFreshnessDue is false when interval has not elapsed', () => {
    const updated = new Date(NOW - 2 * HOUR).toISOString();
    const lastCheck = new Date(NOW - 30 * 60 * 1000).toISOString();
    expect(isFreshnessDue(updated, lastCheck, NOW)).toBe(false);
  });
});
