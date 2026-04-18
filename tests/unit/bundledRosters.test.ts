/**
 * bundledRosters is now a no-op facade (ADR-011 v2.5.1). useVotingRecord
 * always goes through the network fallback path; Worker's ADR-009 response
 * cache handles amortization. These tests pin the contract.
 */
import { describe, it, expect } from 'vitest';
import {
  bundledHouseCast,
  bundledSenateCast,
  hasBundledRoster,
  initRosters,
  preloadHouseMember,
  preloadSenateMember,
  rostersReady,
} from '../../src/services/bundledRosters';

describe('bundledRosters facade (ADR-011 v2.5.1)', () => {
  it('initRosters is a resolved no-op', async () => {
    await expect(initRosters('https://example.com')).resolves.toBeUndefined();
  });
  it('rostersReady is always true (no loading step)', () => {
    expect(rostersReady()).toBe(true);
  });
  it('hasBundledRoster always returns false', () => {
    expect(hasBundledRoster('House', 117, 2, 65)).toBe(false);
    expect(hasBundledRoster('Senate', 118, 1, 42)).toBe(false);
  });
  it('preload* resolves to null', async () => {
    await expect(preloadHouseMember('B001315')).resolves.toBeNull();
    await expect(preloadSenateMember('Durbin', 'IL')).resolves.toBeNull();
  });
  it('bundledHouseCast and bundledSenateCast always return undefined', () => {
    expect(bundledHouseCast(117, 2, 65, 'B001315')).toBeUndefined();
    expect(bundledSenateCast(117, 2, 191, 'Durbin', 'IL')).toBeUndefined();
  });
});
