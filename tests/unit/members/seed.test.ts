/**
 * seedMembers / importMemberCore — FR-32 AC-32.39.
 *
 * Seeds the durable D1 `members` table from Congress.gov: enumerate current
 * members, fetch per-member detail + sponsored/cosponsored + socials, upsert.
 * Freshness-gated on congress_update_date, idempotent, per-member failures →
 * audit_log + continue, exit-result mirrors lw bills seed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { seedMembers } from '../../../scripts/lib/members/seed';
import type { CongressClient } from '../../../scripts/lib/congress-client';
import type { D1Like, D1PreparedStatement } from '../../../scripts/lib/d1-client';
import type { AuditLogger, AuditEvent } from '../../../scripts/lib/audit-log';
import type { CliLogger } from '../../../scripts/lib/logger';

/* ----------------------------- fake D1 ----------------------------- */

interface MemberRow {
  bioguide_id: string; first: string; last: string; official_name: string;
  state: string; chamber: string; district: number | null; party: string;
  photo_url: string | null; website: string | null; search_key: string;
  year_entered: number | null; is_non_voting: number;
  socials_json: string | null; sponsored_json: string; cosponsored_json: string;
  congress_update_date: string | null; last_freshness_check_at: string | null;
}

class FakeD1 implements D1Like {
  rows = new Map<string, MemberRow>();
  prepare(query: string): D1PreparedStatement {
    const self = this;
    let bound: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...v: unknown[]) { bound = v; return stmt; },
      async first<T>() {
        if (/SELECT .* FROM members WHERE bioguide_id/i.test(query)) {
          return (self.rows.get(bound[0] as string) ?? null) as T | null;
        }
        return null as T | null;
      },
      async all<T>() { return { results: [...self.rows.values()] as unknown as T[] }; },
      async run() {
        if (/INSERT (OR REPLACE )?INTO members/i.test(query)) {
          const b = bound as [string, string, string, string, string, string, number | null, string, string | null, string | null, string, number | null, number, string | null, string, string, string | null, string | null];
          const row: MemberRow = {
            bioguide_id: b[0], first: b[1], last: b[2], official_name: b[3], state: b[4],
            chamber: b[5], district: b[6], party: b[7], photo_url: b[8], website: b[9],
            search_key: b[10], year_entered: b[11], is_non_voting: b[12], socials_json: b[13],
            sponsored_json: b[14], cosponsored_json: b[15], congress_update_date: b[16], last_freshness_check_at: b[17],
          };
          self.rows.set(row.bioguide_id, row);
        }
        return { success: true };
      },
    };
    return stmt;
  }
  async batch(stmts: D1PreparedStatement[]) { for (const s of stmts) await s.run(); return []; }
}

/* ----------------------------- fakes ----------------------------- */

const auditEvents: AuditEvent[] = [];
const auditLog: AuditLogger = { async log(e) { auditEvents.push(e); } };
const logger: CliLogger = { info() {}, warn() {}, error() {}, debug() {}, verbose() {}, event() {} } as unknown as CliLogger;
beforeEach(() => { auditEvents.length = 0; });

/** Fake Congress client. Member list = 2 members; per-member detail + legislation.
 *  Records every path on `.calls` so tests can assert selectivity. */
function makeCongress(opts: { failDetailFor?: string; calls?: string[] } = {}): CongressClient {
  return {
    async get<T>(path: string): Promise<T | null> {
      opts.calls?.push(path);
      if (/^\/v3\/member\?/.test(path) || path.startsWith('/v3/member?')) {
        return { members: [{ bioguideId: 'D000563' }, { bioguideId: 'S001150' }] } as unknown as T;
      }
      const detail = /^\/v3\/member\/([A-Z]\d{6})\b/.exec(path);
      if (detail && !path.includes('legislation')) {
        const id = detail[1]!;
        if (opts.failDetailFor === id) throw new Error('upstream 500');
        return {
          member: {
            bioguideId: id,
            firstName: id === 'D000563' ? 'Richard' : 'Adam',
            lastName: id === 'D000563' ? 'Durbin' : 'Schiff',
            directOrderName: id === 'D000563' ? 'Richard J. Durbin' : 'Adam Schiff',
            state: id === 'D000563' ? 'Illinois' : 'California',
            partyHistory: [{ partyName: 'Democratic' }],
            terms: { item: [{ chamber: 'Senate', startYear: id === 'D000563' ? 1997 : 2025 }] },
            depiction: { imageUrl: 'https://img/' + id + '.jpg' },
            officialWebsiteUrl: 'https://' + id + '.senate.gov',
            updateDate: '2026-05-01',
          },
        } as unknown as T;
      }
      if (path.includes('/sponsored-legislation')) return { sponsoredLegislation: [{ bill: 'x' }] } as unknown as T;
      if (path.includes('/cosponsored-legislation')) return { cosponsoredLegislation: [] } as unknown as T;
      return null;
    },
  };
}

const noSocials = async () => new Map<string, Record<string, string>>();

describe('seedMembers (FR-32 AC-32.39)', () => {
  it('enumerates current members and upserts member rows', async () => {
    const d1 = new FakeD1();
    const r = await seedMembers({ d1, congressClient: makeCongress(), auditLog, logger, fetchSocials: noSocials, concurrency: 1 });
    expect(r.processed).toBe(2);
    expect(r.ok).toBe(2);
    expect(r.failed).toBe(0);
    const durbin = d1.rows.get('D000563')!;
    expect(durbin).toBeTruthy();
    expect(durbin.last).toBe('Durbin');
    expect(durbin.state).toBe('IL'); // normalized to two-letter
    expect(durbin.chamber).toBe('Senate');
    expect(durbin.party).toBe('D');
    expect(durbin.year_entered).toBe(1997);
    expect(JSON.parse(durbin.sponsored_json)).toHaveLength(1);
    expect(durbin.search_key).toContain('durbin');
  });

  it('AC-32.39 — a per-member fetch failure logs to audit_log and continues', async () => {
    const d1 = new FakeD1();
    const r = await seedMembers({ d1, congressClient: makeCongress({ failDetailFor: 'S001150' }), auditLog, logger, fetchSocials: noSocials, concurrency: 1 });
    expect(r.ok).toBe(1);
    expect(r.failed).toBe(1);
    expect(d1.rows.has('D000563')).toBe(true);
    expect(d1.rows.has('S001150')).toBe(false);
    expect(auditEvents.some((e) => e.action === 'member_seed_error')).toBe(true);
  });

  it('AC-32.39 — freshness gate: unchanged congress_update_date skips re-write (cached)', async () => {
    const d1 = new FakeD1();
    await seedMembers({ d1, congressClient: makeCongress(), auditLog, logger, fetchSocials: noSocials, concurrency: 1 });
    const r2 = await seedMembers({ d1, congressClient: makeCongress(), auditLog, logger, fetchSocials: noSocials, concurrency: 1 });
    expect(r2.cached).toBe(2); // both unchanged → cached, no re-write
  });

  it('AC-32.43 — onlyBioguides seeds just those, with NO list-enumeration call', async () => {
    const d1 = new FakeD1();
    const calls: string[] = [];
    const r = await seedMembers({
      d1, congressClient: makeCongress({ calls }), auditLog, logger, fetchSocials: noSocials,
      concurrency: 1, onlyBioguides: ['S001150'],
    });
    expect(r.processed).toBe(1);
    expect(d1.rows.has('S001150')).toBe(true);
    expect(d1.rows.has('D000563')).toBe(false);
    // No `/v3/member?...` list call was made — selection bypassed enumeration.
    expect(calls.some((p) => p.startsWith('/v3/member?'))).toBe(false);
  });

  it('AC-32.43 — onlyMissing skips bioguides already in D1 (zero detail calls for them)', async () => {
    const d1 = new FakeD1();
    // Pre-seed D000563 so only S001150 is "missing".
    await seedMembers({ d1, congressClient: makeCongress(), auditLog, logger, fetchSocials: noSocials, concurrency: 1, onlyBioguides: ['D000563'] });
    const calls: string[] = [];
    const r = await seedMembers({
      d1, congressClient: makeCongress({ calls }), auditLog, logger, fetchSocials: noSocials,
      concurrency: 1, onlyMissing: true,
    });
    expect(r.processed).toBe(1); // only the missing one
    expect(d1.rows.has('S001150')).toBe(true);
    // The list call happened (to enumerate), but NO detail call for the existing D000563.
    expect(calls.some((p) => /^\/v3\/member\/D000563\b/.test(p))).toBe(false);
    expect(calls.some((p) => /^\/v3\/member\/S001150\b/.test(p))).toBe(true);
  });
});
