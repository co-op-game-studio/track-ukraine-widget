/**
 * Member-profile-backed roster lookup tests (FR-24 revised, FR-32, ADR-011).
 *
 * The service lazily fetches /api/members/{bioguideId} on demand and caches
 * per-member. Tests use a fake fetch to return canned profiles.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  bundledHouseCast,
  bundledSenateCast,
  hasBundledRoster,
  initRosters,
  preloadHouseMember,
  preloadSenateMember,
  __resetBundledRostersForTest,
} from '../../src/services/bundledRosters';

const API_BASE = 'https://example.com';

function canned(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  __resetBundledRostersForTest();
  vi.restoreAllMocks();
});

describe('initRosters', () => {
  it('stores the api base for subsequent fetches', async () => {
    await initRosters(API_BASE);
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(canned({
      bioguideId: 'D000563', first: 'Richard', last: 'Durbin', state: 'IL',
      chamber: 'House', party: 'D', ukraineVotes: [],
    }));
    await preloadHouseMember('D000563');
    expect(spy).toHaveBeenCalledWith(`${API_BASE}/api/members/D000563`);
  });
});

describe('bundledHouseCast', () => {
  it('returns cast after profile loads', async () => {
    await initRosters(API_BASE);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(canned({
      bioguideId: 'B001315', chamber: 'House', first: 'Nikki', last: 'Budzinski', state: 'IL', party: 'D',
      ukraineVotes: [
        { rollCallId: 'house:117:2:65', cast: 'Yea', date: '', billId: 'HR2471', question: '', weight: 0.9, billTitle: '' },
      ],
    }));
    await preloadHouseMember('B001315');
    expect(bundledHouseCast(117, 2, 65, 'B001315')).toBe('Yea');
  });

  it('returns undefined before profile loads', () => {
    expect(bundledHouseCast(117, 2, 65, 'B001315')).toBeUndefined();
  });

  it('returns null when profile loaded but member absent on that roll call (DNS)', async () => {
    await initRosters(API_BASE);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(canned({
      bioguideId: 'X000001', chamber: 'House', first: 'X', last: 'Y', state: 'FL', party: 'R',
      ukraineVotes: [],
    }));
    await preloadHouseMember('X000001');
    expect(bundledHouseCast(117, 2, 65, 'X000001')).toBe(null);
  });
});

describe('bundledSenateCast', () => {
  it('resolves senate key via last|state synthetic bioguide', async () => {
    await initRosters(API_BASE);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(canned({
      bioguideId: 'S|Durbin|IL', chamber: 'Senate', first: 'Richard', last: 'Durbin', state: 'IL', party: 'D',
      ukraineVotes: [
        { rollCallId: 'senate:117:2:191', cast: 'Yea', date: '', billId: 'HR7691', question: '', weight: 1.0, billTitle: '' },
      ],
    }));
    await preloadSenateMember('Durbin', 'IL');
    expect(bundledSenateCast(117, 2, 191, 'Durbin', 'IL')).toBe('Yea');
  });

  it('returns null for absent senator after profile load', async () => {
    await initRosters(API_BASE);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(canned({
      bioguideId: 'S|NotReal|ZZ', chamber: 'Senate', first: 'N', last: 'R', state: 'ZZ', party: 'I',
      ukraineVotes: [],
    }));
    await preloadSenateMember('NotReal', 'ZZ');
    expect(bundledSenateCast(117, 2, 191, 'NotReal', 'ZZ')).toBe(null);
  });
});

describe('hasBundledRoster', () => {
  it('becomes true once any cached member has the roll call', async () => {
    await initRosters(API_BASE);
    expect(hasBundledRoster('House', 117, 2, 65)).toBe(false);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(canned({
      bioguideId: 'B001315', chamber: 'House', first: 'Nikki', last: 'Budzinski', state: 'IL', party: 'D',
      ukraineVotes: [
        { rollCallId: 'house:117:2:65', cast: 'Yea', date: '', billId: 'HR2471', question: '', weight: 0.9, billTitle: '' },
      ],
    }));
    await preloadHouseMember('B001315');
    expect(hasBundledRoster('House', 117, 2, 65)).toBe(true);
  });
});
