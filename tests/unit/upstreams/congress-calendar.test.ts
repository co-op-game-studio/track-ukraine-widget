/**
 * Tests for proxy/upstreams/congress-calendar.ts.
 *
 * Traces to FR-41 AC-41.4 (spec.md v2.6.0).
 *
 * Congress calendar facts used in these tests:
 *  - 117th Congress: 2021-01-03 .. 2023-01-03 (session 1 = 2021, session 2 = 2022)
 *  - 118th Congress: 2023-01-03 .. 2025-01-03 (session 1 = 2023, session 2 = 2024)
 *  - 119th Congress: 2025-01-03 .. 2027-01-03 (session 1 = 2025, session 2 = 2026)
 */
import { describe, expect, it } from 'vitest';
import {
  currentCongress,
  currentSession,
  isRollCallFrozen,
  isBillFrozen,
} from '../../../proxy/upstreams/congress-calendar';

describe('currentCongress', () => {
  it('119th for 2025-06-01', () => {
    expect(currentCongress(new Date('2025-06-01T00:00:00Z'))).toBe(119);
  });

  it('119th for 2026-04-19 (today)', () => {
    expect(currentCongress(new Date('2026-04-19T12:00:00Z'))).toBe(119);
  });

  it('118th for 2024-06-01', () => {
    expect(currentCongress(new Date('2024-06-01T00:00:00Z'))).toBe(118);
  });

  it('117th for 2022-06-01', () => {
    expect(currentCongress(new Date('2022-06-01T00:00:00Z'))).toBe(117);
  });

  it('boundary: 2025-01-03 flips to 119th', () => {
    expect(currentCongress(new Date('2025-01-03T00:00:00Z'))).toBe(119);
  });

  it('boundary: 2025-01-02 still 118th', () => {
    expect(currentCongress(new Date('2025-01-02T23:59:59Z'))).toBe(118);
  });
});

describe('currentSession', () => {
  it('odd years → session 1', () => {
    expect(currentSession(new Date('2025-06-01T00:00:00Z'))).toBe(1);
  });

  it('even years → session 2', () => {
    expect(currentSession(new Date('2026-06-01T00:00:00Z'))).toBe(2);
  });

  it('2024 → session 2 (118th Congress)', () => {
    expect(currentSession(new Date('2024-06-01T00:00:00Z'))).toBe(2);
  });
});

describe('isRollCallFrozen — AC-41.4 rule for roll-calls', () => {
  const NOW = new Date('2026-04-19T12:00:00Z'); // 119th/session 2

  it('past Congress → frozen', () => {
    expect(isRollCallFrozen({ congress: 117, session: 2, now: NOW })).toBe(true);
    expect(isRollCallFrozen({ congress: 118, session: 2, now: NOW })).toBe(true);
    expect(isRollCallFrozen({ congress: 118, session: 1, now: NOW })).toBe(true);
  });

  it('same Congress, earlier session → frozen', () => {
    expect(isRollCallFrozen({ congress: 119, session: 1, now: NOW })).toBe(true);
  });

  it('current Congress + current session → NOT frozen', () => {
    expect(isRollCallFrozen({ congress: 119, session: 2, now: NOW })).toBe(false);
  });

  it('future Congress → NOT frozen (guard against misclassification)', () => {
    expect(isRollCallFrozen({ congress: 120, session: 1, now: NOW })).toBe(false);
  });

  it('defaults `now` to wall-clock when omitted (smoke only)', () => {
    // Either true or false depending on date; just verify it doesn't throw.
    expect(() => isRollCallFrozen({ congress: 117, session: 2 })).not.toThrow();
  });
});

describe('isBillFrozen — AC-41.4 rule for bill actions/summaries', () => {
  const NOW = new Date('2026-04-19T00:00:00Z');

  it('returns true when latestActionDate is >180 days ago', () => {
    const past = new Date('2025-09-01T00:00:00Z'); // ~230 days ago
    expect(isBillFrozen({ latestActionDate: past, now: NOW })).toBe(true);
  });

  it('returns false when latestActionDate is <180 days ago', () => {
    const recent = new Date('2026-01-01T00:00:00Z'); // ~108 days ago
    expect(isBillFrozen({ latestActionDate: recent, now: NOW })).toBe(false);
  });

  it('returns false exactly on the 180-day boundary (strict > comparison)', () => {
    // 180 days before NOW, exact.
    const boundary = new Date(NOW.getTime() - 180 * 24 * 3600 * 1000);
    expect(isBillFrozen({ latestActionDate: boundary, now: NOW })).toBe(false);
  });

  it('returns true on the 181-day mark', () => {
    const just_over = new Date(NOW.getTime() - 181 * 24 * 3600 * 1000);
    expect(isBillFrozen({ latestActionDate: just_over, now: NOW })).toBe(true);
  });

  it('returns false when latestActionDate is missing', () => {
    expect(isBillFrozen({ latestActionDate: null, now: NOW })).toBe(false);
  });
});
