/**
 * seedRosters — FR-32 AC-32.36 / AC-32.38.
 *
 * Enumerates curated roll-calls from D1 `votes`, fetches each roll-call's
 * casts via injected fetchers, and replaces this roll-call's rows in
 * `vote_casts` (idempotent). Per-roll-call failures → audit_log + continue.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { seedRosters } from '../../../scripts/lib/rosters/seed';
import type { CastFetchers } from '../../../scripts/lib/rosters/fetch-casts';
import type { D1Like, D1PreparedStatement } from '../../../scripts/lib/d1-client';
import type { AuditLogger, AuditEvent } from '../../../scripts/lib/audit-log';
import type { CliLogger } from '../../../scripts/lib/logger';

/* ----------------------------- fakes ----------------------------- */

interface CastRow {
  id: string; chamber: string; congress: number; session: number; roll_call: number;
  bioguide_id: string | null; last_name: string | null; first_name: string | null;
  state: string | null; party: string | null; cast: string;
}

class FakeD1 implements D1Like {
  votes: Array<{ chamber: string; congress: number; session: number; roll_call: number }> = [];
  casts: CastRow[] = [];

  prepare(query: string): D1PreparedStatement {
    const self = this;
    let bound: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...v: unknown[]) { bound = v; return stmt; },
      async first<T>() { return null as T | null; },
      async all<T>() {
        if (/SELECT DISTINCT chamber, congress, session, roll_call FROM votes/i.test(query)) {
          return { results: self.votes as unknown as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        if (/^DELETE FROM vote_casts/i.test(query)) {
          const [chamber, congress, session, rollCall] = bound as [string, number, number, number];
          self.casts = self.casts.filter(
            (c) => !(c.chamber === chamber && c.congress === congress && c.session === session && c.roll_call === rollCall),
          );
        } else if (/^INSERT INTO vote_casts/i.test(query)) {
          const [id, chamber, congress, session, roll_call, bioguide_id, last_name, first_name, state, party, cast] = bound as [string, string, number, number, number, string | null, string | null, string | null, string | null, string | null, string];
          self.casts.push({ id, chamber, congress, session, roll_call, bioguide_id, last_name, first_name, state, party, cast });
        }
        return { success: true };
      },
    };
    return stmt;
  }
  async batch(stmts: D1PreparedStatement[]) {
    for (const s of stmts) await s.run();
    return [];
  }
}

const auditEvents: AuditEvent[] = [];
const auditLog: AuditLogger = { async log(e) { auditEvents.push(e); } };
const logger: CliLogger = {
  info() {}, warn() {}, error() {}, debug() {}, verbose() {}, event() {},
} as unknown as CliLogger;

beforeEach(() => { auditEvents.length = 0; });

const okFetchers: CastFetchers = {
  async fetchHouse() { return [{ bioguideId: 'D000563', cast: 'Yea' }, { bioguideId: 'S001150', cast: 'Nay' }]; },
  async fetchSenate() { return [{ lastName: 'Durbin', state: 'IL', cast: 'Yea' }]; },
};

describe('seedRosters (FR-32 AC-32.36)', () => {
  it('seeds House + Senate casts from the curated votes roll-calls', async () => {
    const d1 = new FakeD1();
    d1.votes = [
      { chamber: 'House', congress: 117, session: 1, roll_call: 293 },
      { chamber: 'Senate', congress: 118, session: 2, roll_call: 10 },
    ];
    const r = await seedRosters({ d1, fetchers: okFetchers, auditLog, logger, concurrency: 1 });
    expect(r.processed).toBe(2);
    expect(r.ok).toBe(2);
    expect(r.failed).toBe(0);
    expect(r.castsWritten).toBe(3); // 2 House + 1 Senate
    const house = d1.casts.filter((c) => c.chamber === 'House');
    expect(house.find((c) => c.bioguide_id === 'S001150')?.cast).toBe('Nay');
    const senate = d1.casts.filter((c) => c.chamber === 'Senate');
    expect(senate[0]).toMatchObject({ last_name: 'Durbin', state: 'IL', cast: 'Yea', bioguide_id: null });
  });

  it('AC-32.36 — idempotent: re-running replaces rows, no duplicates', async () => {
    const d1 = new FakeD1();
    d1.votes = [{ chamber: 'House', congress: 117, session: 1, roll_call: 293 }];
    await seedRosters({ d1, fetchers: okFetchers, auditLog, logger, concurrency: 1 });
    const afterFirst = d1.casts.length;
    await seedRosters({ d1, fetchers: okFetchers, auditLog, logger, concurrency: 1 });
    expect(d1.casts.length).toBe(afterFirst); // delete-then-insert → same count
  });

  it('AC-32.38 — a fetch failure logs to audit_log and continues', async () => {
    const d1 = new FakeD1();
    d1.votes = [
      { chamber: 'House', congress: 117, session: 1, roll_call: 1 },
      { chamber: 'Senate', congress: 118, session: 2, roll_call: 10 },
    ];
    const flaky: CastFetchers = {
      async fetchHouse() { throw new Error('upstream 503'); },
      async fetchSenate() { return [{ lastName: 'Durbin', state: 'IL', cast: 'Yea' }]; },
    };
    const r = await seedRosters({ d1, fetchers: flaky, auditLog, logger, concurrency: 1 });
    expect(r.failed).toBe(1);
    expect(r.ok).toBe(1); // the senate one still succeeded
    expect(auditEvents.some((e) => e.action === 'roster_seed_error')).toBe(true);
    expect(d1.casts.filter((c) => c.chamber === 'Senate').length).toBe(1);
  });
});
