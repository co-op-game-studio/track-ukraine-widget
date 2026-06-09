/**
 * FR-62 — upstream API quota gauge service. Tests the estimate math, the
 * unconfigured-key path, and the always-present `estimate: true` flag.
 */
import { describe, it, expect } from 'vitest';
import { buildApiUsageReport, type D1UsageLike } from '../../proxy/services/api-usage';

/** Tiny fake D1 that answers each query by inspecting the SQL text. */
function fakeD1(opts: {
  youtubeAttempts?: number;
  importCount?: number;
  rateLimitRow?: { at: string; err: string } | null;
}): D1UsageLike {
  return {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (sql.includes("platform = 'youtube'") && sql.includes('COUNT(*)')) {
                return { n: opts.youtubeAttempts ?? 0 } as unknown as T;
              }
              if (sql.includes("action = 'import_bill'")) {
                return { n: opts.importCount ?? 0 } as unknown as T;
              }
              if (sql.includes("last_poll_status = 'error'")) {
                return (opts.rateLimitRow ?? null) as unknown as T;
              }
              return null;
            },
          };
        },
      };
    },
  };
}

const NOW = Date.parse('2026-06-07T12:00:00Z');

describe('FR-62: buildApiUsageReport', () => {
  it('AC-62.1: returns one entry per upstream with estimate:true', async () => {
    const report = await buildApiUsageReport(fakeD1({}), { youtube: true, congress: true }, NOW);
    expect(report.upstreams.map((u) => u.upstream)).toEqual(['youtube', 'congress']);
    for (const u of report.upstreams) {
      expect(u.estimate).toBe(true);
    }
    expect(report.asOf).toBe('2026-06-07T12:00:00.000Z');
  });

  it('AC-62.2: estimates YouTube units from sync attempts (≈11 units/attempt)', async () => {
    const report = await buildApiUsageReport(fakeD1({ youtubeAttempts: 100 }), { youtube: true, congress: true }, NOW);
    const yt = report.upstreams.find((u) => u.upstream === 'youtube')!;
    expect(yt.dailyLimit).toBe(10_000);
    expect(yt.limitUnit).toBe('units');
    // 100 × 11 = 1100
    expect(yt.estimatedUsed24h).toBe(1100);
  });

  it('AC-62.3: estimates Congress requests from import_bill audit rows (×6)', async () => {
    const report = await buildApiUsageReport(fakeD1({ importCount: 10 }), { youtube: true, congress: true }, NOW);
    const cg = report.upstreams.find((u) => u.upstream === 'congress')!;
    expect(cg.limitUnit).toBe('requests');
    expect(cg.estimatedUsed24h).toBe(60);
  });

  it('AC-62.6: unconfigured key → dailyLimit null + configured false', async () => {
    const report = await buildApiUsageReport(fakeD1({}), { youtube: false, congress: false }, NOW);
    for (const u of report.upstreams) {
      expect(u.configured).toBe(false);
      expect(u.dailyLimit).toBeNull();
    }
  });

  it('AC-62.4: surfaces the last YouTube rate-limit event + kind', async () => {
    const report = await buildApiUsageReport(
      fakeD1({ rateLimitRow: { at: '2026-06-07T09:30:00.000Z', err: 'rate-limited (403, quota)' } }),
      { youtube: true, congress: true },
      NOW,
    );
    const yt = report.upstreams.find((u) => u.upstream === 'youtube')!;
    expect(yt.lastRateLimitAt).toBe('2026-06-07T09:30:00.000Z');
    expect(yt.lastRateLimitKind).toBe('quota');
  });

  it('no rate-limit row → null at/kind', async () => {
    const report = await buildApiUsageReport(fakeD1({ rateLimitRow: null }), { youtube: true, congress: true }, NOW);
    const yt = report.upstreams.find((u) => u.upstream === 'youtube')!;
    expect(yt.lastRateLimitAt).toBeNull();
    expect(yt.lastRateLimitKind).toBeNull();
  });
});
