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
import { describe, it, expect } from 'vitest';
import { freshnessIntervalMs, isFreshnessDue } from '../../proxy/services/import-bill';

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
