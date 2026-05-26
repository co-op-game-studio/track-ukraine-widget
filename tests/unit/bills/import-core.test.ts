/**
 * Tests for scripts/lib/bills/import-core.ts — the pure orchestrator
 * extracted from proxy/services/import-bill.ts in v4.1.0.
 *
 * Most behavior is already covered by tests/unit/importBill.test.ts
 * (which exercises the same code via the Worker adapter). This file
 * adds the three v4.1.0 AC-specific tests:
 *
 *   AC-59.5: bill.laws[].length > 0  →  bills.became_law = 1
 *   AC-59.6: every recordedVote in every action gets a votes row
 *   AC-59.10: idempotent — second consecutive run writes zero new
 *             rows when nothing has changed upstream
 */
import { describe, it, expect } from 'vitest';
import { importBillCore } from '../../../scripts/lib/bills/import-core';
import type { D1Like, D1PreparedStatement } from '../../../scripts/lib/d1-client';
import type { CongressClient } from '../../../scripts/lib/congress-client';
import type { AuditLogger, AuditEvent } from '../../../scripts/lib/audit-log';

/* -------------------------------------------------------------------------- */
/*                              Tiny fake D1                                  */
/* -------------------------------------------------------------------------- */

interface FakeRow {
  [col: string]: unknown;
}

class FakeD1 implements D1Like {
  tables: Record<string, FakeRow[]> = {
    bills: [],
    votes: [],
    bill_cosponsors: [],
    bill_actions: [],
  };

  prepare(query: string): D1PreparedStatement {
    return new FakeStmt(this, query, []);
  }

  async batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
    const snapshot = JSON.parse(JSON.stringify(this.tables));
    const out: unknown[] = [];
    try {
      for (const s of statements) {
        out.push(await s.run());
      }
      return out;
    } catch (e) {
      this.tables = snapshot;
      throw e;
    }
  }
}

class FakeStmt implements D1PreparedStatement {
  constructor(
    private d1: FakeD1,
    private query: string,
    private params: unknown[],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new FakeStmt(this.d1, this.query, [...this.params, ...values]);
  }

  async first<T>(): Promise<T | null> {
    const rows = await this.runSelect();
    return (rows[0] ?? null) as T | null;
  }

  async all<T>(): Promise<{ results?: T[] }> {
    const rows = await this.runSelect();
    return { results: rows as T[] };
  }

  async run(): Promise<{ success: boolean }> {
    const q = this.query.trim();
    if (/^INSERT INTO bills/i.test(q)) {
      // The orchestrator's INSERT VALUES list has inline literals for
      // featured/label/display_title/direction/direction_reason, so the
      // bound-param positions are: id, bill_id, congress, type, number,
      // title, latest_action, latest_action_date, became_law, congress_gov_url,
      // summary_json, sponsor_bioguide_id, sponsor_full_name, sponsor_party,
      // sponsor_state, introduced_date, congress_update_date,
      // last_freshness_check_at, created_at, updated_at.
      const row = this.recordFromBindings([
        'id', 'bill_id', 'congress', 'type', 'number',
        'title', 'latest_action', 'latest_action_date', 'became_law',
        'congress_gov_url', 'summary_json',
        'sponsor_bioguide_id', 'sponsor_full_name', 'sponsor_party',
        'sponsor_state', 'introduced_date',
        'congress_update_date', 'last_freshness_check_at',
        'created_at', 'updated_at',
      ]);
      // Inline literals from the VALUES list.
      row.featured = 0;
      row.label = null;
      row.display_title = null;
      row.direction = 'ambiguous';
      row.direction_reason = null;
      this.d1.tables.bills!.push(row);
    } else if (/^UPDATE bills SET/i.test(q)) {
      // last param is the bill_id (WHERE bill_id = ?)
      const billId = this.params[this.params.length - 1];
      const row = this.d1.tables.bills!.find((r) => r.bill_id === billId);
      if (row) {
        // Map fields in the order they appear in the orchestrator's UPDATE.
        const cols = [
          'title', 'latest_action', 'latest_action_date', 'became_law',
          'congress_gov_url', 'summary_json', 'sponsor_bioguide_id',
          'sponsor_full_name', 'sponsor_party', 'sponsor_state', 'introduced_date',
          'congress_update_date', 'last_freshness_check_at', 'updated_at',
        ];
        cols.forEach((c, i) => { row[c] = this.params[i]; });
      }
    } else if (/^INSERT INTO votes/i.test(q)) {
      this.d1.tables.votes!.push(this.recordFromBindings([
        'id', 'bill_id', 'chamber', 'congress', 'session', 'roll_call', 'date',
        'url', 'action', 'action_date', 'weight', 'direction_multiplier', 'kind',
        'congress_update_date', 'created_at', 'updated_at',
      ]));
    } else if (/^UPDATE votes SET/i.test(q)) {
      const voteId = this.params[this.params.length - 1];
      const row = this.d1.tables.votes!.find((r) => r.id === voteId);
      if (row) {
        const cols = ['date', 'url', 'action', 'action_date', 'congress_update_date', 'updated_at'];
        cols.forEach((c, i) => { row[c] = this.params[i]; });
      }
    } else if (/^DELETE FROM bill_cosponsors/i.test(q)) {
      const billId = this.params[0];
      this.d1.tables.bill_cosponsors = this.d1.tables.bill_cosponsors!.filter(
        (r) => r.bill_id !== billId,
      );
    } else if (/^INSERT INTO bill_cosponsors/i.test(q)) {
      this.d1.tables.bill_cosponsors!.push(this.recordFromBindings([
        'id', 'bill_id', 'bioguide_id', 'full_name', 'party', 'state', 'district',
        'is_original_cosponsor', 'sponsorship_date', 'sponsorship_withdrawn_date',
        'congress_update_date', 'created_at', 'updated_at',
      ]));
    } else if (/^DELETE FROM bill_actions/i.test(q)) {
      const billId = this.params[0];
      this.d1.tables.bill_actions = this.d1.tables.bill_actions!.filter(
        (r) => r.bill_id !== billId,
      );
    } else if (/^INSERT INTO bill_actions/i.test(q)) {
      this.d1.tables.bill_actions!.push(this.recordFromBindings([
        'id', 'bill_id', 'action_date', 'action_text', 'action_code', 'source_system',
        'congressional_record_url', 'congressional_record_citation',
        'recorded_chamber', 'recorded_roll_call',
        'congress_update_date', 'created_at', 'updated_at',
      ]));
    }
    return { success: true };
  }

  private async runSelect(): Promise<FakeRow[]> {
    const q = this.query.trim();
    if (/^SELECT \* FROM bills WHERE bill_id = \?/i.test(q)) {
      const billId = this.params[0];
      return this.d1.tables.bills!.filter((r) => r.bill_id === billId);
    }
    if (/^SELECT id, chamber, congress, session, roll_call/i.test(q)) {
      const billId = this.params[0];
      return this.d1.tables.votes!.filter((r) => r.bill_id === billId);
    }
    return [];
  }

  private recordFromBindings(cols: string[]): FakeRow {
    const r: FakeRow = {};
    cols.forEach((c, i) => { r[c] = this.params[i]; });
    return r;
  }
}

/* -------------------------------------------------------------------------- */
/*                          Fake CongressClient                               */
/* -------------------------------------------------------------------------- */

interface ResponseMap {
  detail?: unknown;
  summaries?: unknown;
  actions?: unknown;
  cosponsors?: unknown;
  houseVotes?: Record<string, unknown>; // keyed by `${congress}-${session}-${rollCall}`
}

function makeCongressClient(map: ResponseMap, callCounter: { n: number }): CongressClient {
  return {
    async get<T>(path: string): Promise<T | null> {
      callCounter.n++;
      // Strip query string when matching paths.
      const cleanPath = path.split('?')[0]!;
      if (/^v3\/bill\/\d+\/[a-z]+\/\d+$/.test(cleanPath)) {
        return (map.detail ?? null) as T | null;
      }
      if (/\/summaries$/.test(cleanPath)) return (map.summaries ?? null) as T | null;
      if (/\/actions$/.test(cleanPath)) return (map.actions ?? null) as T | null;
      if (/\/cosponsors$/.test(cleanPath)) return (map.cosponsors ?? null) as T | null;
      const houseVoteMatch = cleanPath.match(/^v3\/house-vote\/(\d+)\/(\d+)\/(\d+)$/);
      if (houseVoteMatch) {
        const key = `${houseVoteMatch[1]}-${houseVoteMatch[2]}-${houseVoteMatch[3]}`;
        return (map.houseVotes?.[key] ?? null) as T | null;
      }
      return null;
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                            Fake AuditLogger                                */
/* -------------------------------------------------------------------------- */

function makeAuditLogger(): AuditLogger & { events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    events,
    async log(e) {
      events.push(e);
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                                Tests                                       */
/* -------------------------------------------------------------------------- */

describe('importBillCore — AC-59.5 became_law mapping', () => {
  it('sets became_law=1 when bill.laws is a non-empty array', async () => {
    const d1 = new FakeD1();
    const callCounter = { n: 0 };
    const congressClient = makeCongressClient({
      detail: {
        bill: {
          title: 'Ending Importation of Russian Oil Act',
          updateDate: '2026-05-25T00:00:00Z',
          laws: [{ number: '117-109', type: 'Public Law' }],
          latestAction: { actionDate: '2022-04-08', text: 'Became Public Law No: 117-109.' },
          congressGovUrl: 'https://www.congress.gov/bill/117th-congress/house-bill/6968',
          sponsors: [{ bioguideId: 'D000399', fullName: 'Lloyd Doggett' }],
          introducedDate: '2022-03-08',
        },
      },
      summaries: { summaries: [] },
      actions: { actions: [] },
      cosponsors: { cosponsors: [] },
    }, callCounter);
    const auditLog = makeAuditLogger();

    await importBillCore(
      { congress: 117, type: 'HR', number: '6968', actorEmail: 't@test', traceId: 'tr_test', force: true },
      { d1, congressClient, auditLog },
    );

    const bill = d1.tables.bills!.find((b) => b.bill_id === '117-HR-6968');
    expect(bill).toBeDefined();
    expect(bill!.became_law).toBe(1);
  });

  it('sets became_law=0 when bill.laws is missing, null, or empty', async () => {
    for (const laws of [undefined, null, [] as unknown[]]) {
      const d1 = new FakeD1();
      const callCounter = { n: 0 };
      const congressClient = makeCongressClient({
        detail: {
          bill: {
            title: 'Some Non-Law',
            updateDate: '2026-05-25T00:00:00Z',
            laws,
            sponsors: [],
          },
        },
        summaries: { summaries: [] },
        actions: { actions: [] },
        cosponsors: { cosponsors: [] },
      }, callCounter);
      const auditLog = makeAuditLogger();

      await importBillCore(
        { congress: 117, type: 'HR', number: '9999', actorEmail: 't@test', traceId: 'tr_test', force: true },
        { d1, congressClient, auditLog },
      );

      const bill = d1.tables.bills!.find((b) => b.bill_id === '117-HR-9999');
      expect(bill!.became_law, `laws=${JSON.stringify(laws)}`).toBe(0);
    }
  });
});

describe('importBillCore — AC-59.6 every recordedVote imported', () => {
  it('inserts one votes row per recordedVote across all actions', async () => {
    const d1 = new FakeD1();
    const callCounter = { n: 0 };
    // Synthetic actions feed: 3 actions, 5 recordedVotes total.
    //   action 1: 2 votes (House cloture, House passage)
    //   action 2: 1 vote (House motion-to-recommit)
    //   action 3: 2 votes (Senate cloture, Senate passage)
    const congressClient = makeCongressClient({
      detail: {
        bill: {
          title: 'Test Bill',
          updateDate: '2026-05-25T00:00:00Z',
          laws: [],
          sponsors: [],
        },
      },
      summaries: { summaries: [] },
      actions: {
        actions: [
          {
            actionDate: '2024-04-23',
            text: 'House cloture + passage',
            recordedVotes: [
              { chamber: 'House', congress: 118, sessionNumber: 2, rollNumber: 100, url: 'u1', date: '2024-04-23' },
              { chamber: 'House', congress: 118, sessionNumber: 2, rollNumber: 101, url: 'u2', date: '2024-04-23' },
            ],
          },
          {
            actionDate: '2024-04-24',
            text: 'Motion to recommit',
            recordedVotes: [
              { chamber: 'House', congress: 118, sessionNumber: 2, rollNumber: 102, url: 'u3', date: '2024-04-24' },
            ],
          },
          {
            actionDate: '2024-04-25',
            text: 'Senate action',
            recordedVotes: [
              { chamber: 'Senate', congress: 118, sessionNumber: 2, rollNumber: 200, url: 'u4', date: '2024-04-25' },
              { chamber: 'Senate', congress: 118, sessionNumber: 2, rollNumber: 201, url: 'u5', date: '2024-04-25' },
            ],
          },
        ],
      },
      cosponsors: { cosponsors: [] },
      // House votes return null detail (skipped per chamber) but the orchestrator
      // still fetches them — only Senate is skipped per import-core.ts.
      houseVotes: {
        '118-2-100': { houseRollCallVote: { updateDate: '2024-04-23T00:00:00Z' } },
        '118-2-101': { houseRollCallVote: { updateDate: '2024-04-23T00:00:00Z' } },
        '118-2-102': { houseRollCallVote: { updateDate: '2024-04-24T00:00:00Z' } },
      },
    }, callCounter);
    const auditLog = makeAuditLogger();

    await importBillCore(
      { congress: 118, type: 'HR', number: '815', actorEmail: 't@test', traceId: 'tr_test', force: true },
      { d1, congressClient, auditLog },
    );

    const votes = d1.tables.votes!.filter((v) => v.bill_id === '118-HR-815');
    expect(votes).toHaveLength(5);

    // Roll-call numbers should all be present.
    const rcSet = new Set(votes.map((v) => `${v.chamber}:${v.roll_call}`));
    expect(rcSet).toEqual(new Set([
      'House:100', 'House:101', 'House:102', 'Senate:200', 'Senate:201',
    ]));
  });
});

describe('importBillCore — AC-59.10 idempotency', () => {
  it('a second run with unchanged updateDate short-circuits and writes zero rows', async () => {
    const d1 = new FakeD1();
    const callCounter = { n: 0 };
    const detail = {
      bill: {
        title: 'Cached Bill',
        updateDate: '2026-05-25T00:00:00Z',
        laws: [],
        sponsors: [],
      },
    };
    const congressClient = makeCongressClient({
      detail,
      summaries: { summaries: [] },
      actions: {
        actions: [{
          actionDate: '2024-01-01',
          text: 'Passed',
          recordedVotes: [{
            chamber: 'House', congress: 118, sessionNumber: 1, rollNumber: 500, url: 'u', date: '2024-01-01',
          }],
        }],
      },
      cosponsors: { cosponsors: [] },
      houseVotes: { '118-1-500': { houseRollCallVote: { updateDate: '2024-01-01' } } },
    }, callCounter);
    const auditLog = makeAuditLogger();

    // First run — cold; expected to fetch everything and write rows.
    const r1 = await importBillCore(
      { congress: 118, type: 'HR', number: '1', actorEmail: 't@test', traceId: 'tr1', force: false },
      { d1, congressClient, auditLog },
    );
    expect(r1.cached).toBe(false);
    expect(r1.votes_imported).toBe(1);
    const firstCallCount = callCounter.n;
    const firstBillsCount = d1.tables.bills!.length;
    const firstVotesCount = d1.tables.votes!.length;

    // Second run — warm; bill.updateDate unchanged → bill-level gate
    // short-circuits. Only ONE API call (the initial bill detail fetch).
    const r2 = await importBillCore(
      { congress: 118, type: 'HR', number: '1', actorEmail: 't@test', traceId: 'tr2', force: false },
      { d1, congressClient, auditLog },
    );
    expect(r2.cached).toBe(true);

    // Exactly ONE additional upstream call (the cheap bill-detail probe).
    expect(callCounter.n).toBe(firstCallCount + 1);

    // Zero new rows written.
    expect(d1.tables.bills!.length).toBe(firstBillsCount);
    expect(d1.tables.votes!.length).toBe(firstVotesCount);
  });
});
