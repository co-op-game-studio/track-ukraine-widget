/**
 * useMemberById projection — FR-60 AC-60.3.
 *
 * The deep-link path builds a Representative from `/api/members/{id}`. The
 * route returns the FULL Congress.gov state name ("Illinois"), but Senate
 * roster matching in useVotingRecord compares against the two-letter code
 * carried on each cast ("IL"). The projection MUST normalize state, or every
 * Senator's votes silently fail to match ("No Ukraine-related votes").
 */
import { describe, it, expect } from 'vitest';
import { profileToRepresentative } from '../../src/hooks/useMemberById';

describe('profileToRepresentative state normalization (FR-60 AC-60.3)', () => {
  it('normalizes a full state name to the two-letter code', () => {
    const rep = profileToRepresentative({
      bioguideId: 'D000563', first: 'Richard', last: 'Durbin',
      officialName: 'Richard J. Durbin', state: 'Illinois',
      district: null, chamber: 'Senate', party: 'D',
    });
    expect(rep.state).toBe('IL');
  });

  it('passes a two-letter code through unchanged (uppercased)', () => {
    expect(profileToRepresentative({ bioguideId: 'A000360', state: 'ca', chamber: 'Senate' }).state).toBe('CA');
    expect(profileToRepresentative({ bioguideId: 'A000360', state: 'TN', chamber: 'Senate' }).state).toBe('TN');
  });

  it('builds the "Last, First" name and lowercases chamber for matching', () => {
    const rep = profileToRepresentative({
      bioguideId: 'D000563', first: 'Richard', last: 'Durbin', state: 'Illinois', chamber: 'Senate', party: 'D',
    });
    // useVotingRecord parses name.split(',')[0] for the Senate last-name key.
    expect(rep.name.split(',')[0]).toBe('Durbin');
    expect(rep.chamber).toBe('senate');
    expect(rep.party).toBe('Democratic');
    expect(rep.partyAbbreviation).toBe('D');
  });
});
