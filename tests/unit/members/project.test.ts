/**
 * D1 → KV member projections — FR-32 AC-32.40.
 *
 * Pure helpers that turn durable D1 `members` rows into the KV record shapes
 * the routes + widget already consume: member:v1: (MemberProfile),
 * state-members:v1: ({stateCode,senators,house}), name-index:v1: (shards+meta).
 * No upstream fetch — a KV flush + re-project fully restores these.
 */
import { describe, it, expect } from 'vitest';
import {
  projectMemberProfile,
  projectStateMembers,
  projectNameIndex,
  projectRosters,
  type MemberRow,
  type VoteCastRow,
} from '../../../scripts/lib/members/project';

const durbin: MemberRow = {
  bioguide_id: 'D000563', first: 'Richard', last: 'Durbin', official_name: 'Richard J. Durbin',
  state: 'IL', chamber: 'Senate', district: null, party: 'D',
  photo_url: 'https://img/d.jpg', website: 'https://durbin.senate.gov',
  search_key: 'richard durbin', year_entered: 1997, is_non_voting: 0,
  socials_json: JSON.stringify({ twitter: 'SenatorDurbin' }),
  sponsored_json: JSON.stringify([{ bill: 'x' }]), cosponsored_json: '[]',
  congress_update_date: '2026-05-01', last_freshness_check_at: '2026-05-01',
};
const aoc: MemberRow = {
  bioguide_id: 'O000172', first: 'Alexandria', last: 'Ocasio-Cortez', official_name: 'Alexandria Ocasio-Cortez',
  state: 'NY', chamber: 'House', district: 14, party: 'D',
  photo_url: null, website: null, search_key: 'alexandria ocasiocortez', year_entered: 2019, is_non_voting: 0,
  socials_json: null, sponsored_json: '[]', cosponsored_json: '[]',
  congress_update_date: '2026-05-01', last_freshness_check_at: '2026-05-01',
};
const padilla: MemberRow = { ...durbin, bioguide_id: 'P000145', first: 'Alex', last: 'Padilla', official_name: 'Alex Padilla', state: 'CA', search_key: 'alex padilla', socials_json: null };

describe('projectMemberProfile (AC-32.40)', () => {
  it('produces a MemberProfile-shaped record from a members row', () => {
    const p = projectMemberProfile(durbin, '2026-05-30T00:00:00Z');
    expect(p).toMatchObject({
      bioguideId: 'D000563', first: 'Richard', last: 'Durbin', officialName: 'Richard J. Durbin',
      state: 'IL', chamber: 'Senate', district: null, party: 'D',
      photoUrl: 'https://img/d.jpg', website: 'https://durbin.senate.gov',
      searchKey: 'richard durbin', yearEntered: 1997, schemaVersion: 1,
    });
    expect(p.sponsored).toHaveLength(1);
    expect(p.cosponsored).toHaveLength(0);
    expect(p.socials).toEqual({ twitter: 'SenatorDurbin' });
  });
});

describe('projectStateMembers (AC-32.40)', () => {
  it('groups members by state into senators + house', () => {
    const byState = projectStateMembers([durbin, aoc, padilla], '2026-05-30T00:00:00Z');
    const ca = byState.get('CA')!;
    expect(ca.senators.map((s) => s.bioguideId)).toEqual(['P000145']);
    const ny = byState.get('NY')!;
    expect(ny.house.map((h) => h.bioguideId)).toEqual(['O000172']);
    expect(ny.stateCode).toBe('NY');
  });
});

describe('projectNameIndex (AC-32.40)', () => {
  it('shards by first letter of each searchKey + writes meta', () => {
    const { shards, meta } = projectNameIndex([durbin, aoc], '2026-05-30T00:00:00Z');
    // Durbin → 'r' (richard) + 'd' (durbin); AOC → 'a' + 'o'.
    expect(shards.get('d')!.entries.some((e) => e.bioguideId === 'D000563')).toBe(true);
    expect(shards.get('r')!.entries.some((e) => e.bioguideId === 'D000563')).toBe(true);
    expect(shards.get('a')!.entries.some((e) => e.bioguideId === 'O000172')).toBe(true);
    expect(meta.totalMembers).toBe(2);
    expect(meta.shardLetters).toEqual([...meta.shardLetters].sort());
  });
});

describe('projectRosters (AC-32.40)', () => {
  it('groups vote_casts into per-roll-call House Record / Senate array records', () => {
    const casts: VoteCastRow[] = [
      { chamber: 'House', congress: 117, session: 1, roll_call: 293, bioguide_id: 'S001150', last_name: null, first_name: null, state: null, party: null, cast: 'Yea' },
      { chamber: 'House', congress: 117, session: 1, roll_call: 293, bioguide_id: 'D000096', last_name: null, first_name: null, state: null, party: null, cast: 'Nay' },
      { chamber: 'Senate', congress: 118, session: 2, roll_call: 10, bioguide_id: null, last_name: 'Durbin', first_name: 'Richard', state: 'IL', party: 'D', cast: 'Yea' },
    ];
    const recs = projectRosters(casts, '2026-05-30T00:00:00Z');
    const house = recs.get('roll-call-roster:v1:house:117:1:293')!;
    expect(house.chamber).toBe('house');
    expect((house.casts as Record<string, string>).S001150).toBe('Yea');
    const senate = recs.get('roll-call-roster:v1:senate:118:2:10')!;
    expect(Array.isArray(senate.casts)).toBe(true);
    expect((senate.casts as Array<{ lastName: string; cast: string }>)[0]).toMatchObject({ lastName: 'Durbin', cast: 'Yea' });
  });
});
