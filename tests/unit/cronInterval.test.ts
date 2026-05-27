/**
 * Tests for proxy/services/cron-interval.ts.
 *
 * Pure functions; no I/O. Asserts the every recognized cron pattern shape and
 * the FALLBACK behavior on anything unrecognized. The downstream consumer
 * (`getSocialPollStalenessMin`) is asserted to subtract the safety margin and
 * never return ≤0.
 *
 * Traces: FR-59, ADR-018 (staleness window).
 */
import { describe, it, expect } from 'vitest';
import { cronToIntervalMin, getSocialPollStalenessMin } from '../../proxy/services/cron-interval';

describe('cronToIntervalMin', () => {
  it('every-N-minutes: */15 * * * * → 15', () => {
    expect(cronToIntervalMin('*/15 * * * *')).toBe(15);
  });

  it('every-N-minutes: */1 * * * * → 1', () => {
    expect(cronToIntervalMin('*/1 * * * *')).toBe(1);
  });

  it('once an hour at minute M: 0 * * * * → 60', () => {
    expect(cronToIntervalMin('0 * * * *')).toBe(60);
  });

  it('once an hour at non-zero minute: 30 * * * * → 60', () => {
    expect(cronToIntervalMin('30 * * * *')).toBe(60);
  });

  it('every-N-hours: 0 */6 * * * → 360 (6 * 60)', () => {
    expect(cronToIntervalMin('0 */6 * * *')).toBe(360);
  });

  it('every-N-hours: 0 */1 * * * → 60', () => {
    expect(cronToIntervalMin('0 */1 * * *')).toBe(60);
  });

  it('once a day at H:M: 0 6 * * * → 1440', () => {
    expect(cronToIntervalMin('0 6 * * *')).toBe(1440);
  });

  it('once a day at non-zero minute: 30 14 * * * → 1440', () => {
    expect(cronToIntervalMin('30 14 * * *')).toBe(1440);
  });

  it('falls back on wrong field count', () => {
    expect(cronToIntervalMin('0 * * *')).toBe(60); // 4 fields
    expect(cronToIntervalMin('0 * * * * *')).toBe(60); // 6 fields
    expect(cronToIntervalMin('')).toBe(60);
  });

  it('falls back on garbage minute step', () => {
    // `*/abc` doesn't match the digit regex
    expect(cronToIntervalMin('*/abc * * * *')).toBe(60);
  });

  it('falls back on zero/negative N in step', () => {
    // `*/0` parses to 0, fails the `n > 0` guard, returns fallback
    expect(cronToIntervalMin('*/0 * * * *')).toBe(60);
  });

  it('falls back on exotic pattern unsupported by parser', () => {
    expect(cronToIntervalMin('1-5 * * * *')).toBe(60); // ranges not supported
    expect(cronToIntervalMin('*/15 */6 * * *')).toBe(60); // both stepped
    expect(cronToIntervalMin('15 6 * * MON')).toBe(1440); // single min + hour passes
    expect(cronToIntervalMin('* * * * *')).toBe(60); // bare star minute
  });

  it('handles surrounding whitespace', () => {
    expect(cronToIntervalMin('  */15 * * * *  ')).toBe(15);
  });
});

describe('getSocialPollStalenessMin', () => {
  it('returns interval minus 5-min safety margin (hourly default)', () => {
    expect(getSocialPollStalenessMin({})).toBe(55); // 60 - 5
    expect(getSocialPollStalenessMin({ SOCIAL_POLL_CRON: '0 * * * *' })).toBe(55);
  });

  it('every 15 minutes → 10-min staleness window', () => {
    expect(getSocialPollStalenessMin({ SOCIAL_POLL_CRON: '*/15 * * * *' })).toBe(10);
  });

  it('once a day → 1435-min staleness window', () => {
    expect(getSocialPollStalenessMin({ SOCIAL_POLL_CRON: '0 6 * * *' })).toBe(1435);
  });

  it('clamps to >=1 when interval is less than safety margin', () => {
    // Every 1 min → 1 - 5 = -4, clamped to 1
    expect(getSocialPollStalenessMin({ SOCIAL_POLL_CRON: '*/1 * * * *' })).toBe(1);
    // Every 5 min → 5 - 5 = 0, clamped to 1
    expect(getSocialPollStalenessMin({ SOCIAL_POLL_CRON: '*/5 * * * *' })).toBe(1);
  });

  it('treats empty string as default cron', () => {
    expect(getSocialPollStalenessMin({ SOCIAL_POLL_CRON: '' })).toBe(55);
    expect(getSocialPollStalenessMin({ SOCIAL_POLL_CRON: '   ' })).toBe(55);
  });

  it('falls back through cronToIntervalMin on unrecognized pattern', () => {
    expect(getSocialPollStalenessMin({ SOCIAL_POLL_CRON: 'garbage' })).toBe(55); // fallback 60 - 5
  });
});
