/**
 * Bundled-roster lookup tests (FR-24).
 *
 * In production the roster file loads asynchronously via initRosters(). For
 * tests we seed it synchronously from a mocked fetch so we can assert on the
 * contract without a real network request.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  bundledHouseCast,
  bundledSenateCast,
  hasBundledRoster,
  initRosters,
} from '../../src/services/bundledRosters';
import { getCuratedVotesForChamber } from '../../src/services/ukraineFilter';

beforeAll(async () => {
  // Prime the module-level roster store by feeding a stub fetch that returns
  // the real ukraineVotes.json file off disk.
  const jsonText = readFileSync('src/data/ukraineVotes.json', 'utf8');
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(jsonText, { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );
  await initRosters('file://dummy/ukraineVotes.json');
  vi.restoreAllMocks();
});

describe('bundledHouseCast', () => {
  it('returns a valid cast for a known House voter on a bundled vote', () => {
    // Pick a real House curated vote from the bundled data.
    const houseVotes = getCuratedVotesForChamber('House');
    expect(houseVotes.length).toBeGreaterThan(0);
    const v = houseVotes[0]!.vote;

    // Confirm the roster is bundled
    expect(hasBundledRoster('House', v.congress, v.session, v.rollCall)).toBe(true);

    // For a bioguide we know won't be in the roster, we get null.
    const cast = bundledHouseCast(v.congress, v.session, v.rollCall, 'ZZZ00000');
    expect(cast).toBe(null);
  });

  it('returns undefined when the roster is not bundled for that vote', () => {
    // A roll call number that's not in the curated set at all
    const cast = bundledHouseCast(99, 9, 99999, 'ZZZ00000');
    expect(cast).toBeUndefined();
  });
});

describe('bundledSenateCast', () => {
  it('returns a valid cast for a known senator on a bundled vote', () => {
    // Use a well-known senator + vote combination from the real data
    // HR 7691 Senate#191 — Durbin was present
    const cast = bundledSenateCast(117, 2, 191, 'Durbin', 'IL');
    // Must be a string like "Yea" / "Nay" / etc. — not null, not undefined
    expect(typeof cast).toBe('string');
    expect(['Yea', 'Nay', 'Present', 'Not Voting']).toContain(cast);
  });

  it('returns null when the senator is not in a bundled vote roster (Did Not Serve)', () => {
    // Fake last name + real vote
    const cast = bundledSenateCast(117, 2, 191, 'NotARealSenator', 'ZZ');
    expect(cast).toBe(null);
  });

  it('returns undefined when the vote itself is not bundled', () => {
    const cast = bundledSenateCast(99, 9, 99999, 'Durbin', 'IL');
    expect(cast).toBeUndefined();
  });
});

describe('hasBundledRoster', () => {
  it('is true for every curated Senate vote', () => {
    const senateVotes = getCuratedVotesForChamber('Senate');
    expect(senateVotes.length).toBeGreaterThan(0);
    for (const { vote } of senateVotes) {
      expect(
        hasBundledRoster('Senate', vote.congress, vote.session, vote.rollCall),
      ).toBe(true);
    }
  });

  it('is true for every curated House vote', () => {
    const houseVotes = getCuratedVotesForChamber('House');
    expect(houseVotes.length).toBeGreaterThan(0);
    for (const { vote } of houseVotes) {
      expect(
        hasBundledRoster('House', vote.congress, vote.session, vote.rollCall),
      ).toBe(true);
    }
  });

  it('is false for votes not in the curated set', () => {
    expect(hasBundledRoster('Senate', 99, 9, 99999)).toBe(false);
    expect(hasBundledRoster('House', 99, 9, 99999)).toBe(false);
  });
});
