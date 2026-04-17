/**
 * Voting Record Integration Tests (v2.1 — Ukraine-filtered + valence + clustered)
 * Traces to: FR-5, FR-6, FR-11–FR-17, FR-23, FR-24, US-3, US-5
 *
 * These tests exercise the network-fallback path of useVotingRecord. The
 * bundled-roster fast path (FR-24) is stubbed out here so every vote falls
 * through to the mocked fetch layer. A dedicated test file covers the
 * bundled-roster path itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

// FR-24: disable the bundled-roster fast path for these tests. Forces every
// curated vote through the fallback network path the test fixtures mock.
vi.mock('../../src/services/bundledRosters', () => ({
  hasBundledRoster: () => false,
  bundledHouseCast: () => undefined,
  bundledSenateCast: () => undefined,
  rosterGeneratedAt: () => '1970-01-01T00:00:00.000Z',
}));

import { useVotingRecord } from '../../src/hooks/useVotingRecord';
import { getCuratedVotesForChamber } from '../../src/services/ukraineFilter';
import type { Representative } from '../../src/types/domain';

const houseRep: Representative = {
  bioguideId: 'B001315',
  name: 'Budzinski, Nikki',
  party: 'Democratic',
  partyAbbreviation: 'D',
  state: 'IL',
  district: 13,
  chamber: 'house',
  photoUrl: null,
  isNonVoting: false,
};

const senator: Representative = {
  bioguideId: 'D000563',
  name: 'Durbin, Richard J.',
  party: 'Democratic',
  partyAbbreviation: 'D',
  state: 'IL',
  district: null,
  chamber: 'senate',
  photoUrl: null,
  isNonVoting: false,
};

type Route = { match: (u: string) => boolean; body: unknown; isXml?: boolean };

function routeFetch(routes: Route[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const route = routes.find((r) => r.match(url));
    if (!route) return new Response(`No mock for ${url}`, { status: 500 });
    if (route.isXml) {
      return new Response(route.body as string, {
        status: 200,
        headers: { 'Content-Type': 'application/xml' },
      });
    }
    return new Response(JSON.stringify(route.body), { status: 200 });
  });
}

function housePartyLineMembers(memberBioguideId: string, cast: string) {
  return {
    houseRollCallVoteMemberVotes: {
      results: [
        { bioguideID: memberBioguideId, firstName: 'Me', lastName: 'Self', voteCast: cast, voteParty: 'D', voteState: 'IL' },
        ...Array.from({ length: 200 }, (_, i) => ({
          bioguideID: `D${i}`, firstName: 'D', lastName: `Dem${i}`,
          voteCast: 'Yea', voteParty: 'D', voteState: 'CA',
        })),
        ...Array.from({ length: 200 }, (_, i) => ({
          bioguideID: `R${i}`, firstName: 'R', lastName: `Rep${i}`,
          voteCast: 'Nay', voteParty: 'R', voteState: 'TX',
        })),
      ],
    },
  };
}

function senateXmlWith(lastName: string, state: string, castByMember: string) {
  return `<?xml version="1.0"?>
<roll_call_vote><congress>119</congress><session>1</session>
<vote_number>1</vote_number><vote_date>January 1, 2025</vote_date>
<vote_question_text>On Passage</vote_question_text><vote_document_text>Test</vote_document_text>
<vote_result_text>Agreed to</vote_result_text><question>On Passage</question>
<vote_title>Test</vote_title><vote_result>Agreed to</vote_result>
<count><yeas>50</yeas><nays>50</nays><present/><absent>0</absent></count>
<members>
  <member><last_name>${lastName}</last_name><first_name>X</first_name>
  <party>D</party><state>${state}</state>
  <vote_cast>${castByMember}</vote_cast><member_full>${lastName}</member_full>
  <lis_member_id>S1</lis_member_id></member>
</members></roll_call_vote>`;
}

describe('useVotingRecord (v2.1)', () => {
  beforeEach(() => vi.restoreAllMocks());

  describe('House path', () => {
    it('returns clusters with one primary per bill+chamber and nests procedurals', async () => {
      routeFetch([
        {
          match: (u) => /house-vote\/\d+\/\d+\/\d+\/members/.test(u),
          body: housePartyLineMembers(houseRep.bioguideId, 'Yea'),
        },
      ]);

      const { result } = renderHook(() => useVotingRecord(houseRep, ''));
      await act(async () => { await result.current.load(); });
      await waitFor(() => expect(result.current.status).toBe('success'));

      const { clusters, flat, voteScore } = result.current.data!;
      expect(clusters.length).toBeGreaterThan(0);
      expect(flat.length).toBeGreaterThan(0);
      expect(clusters.length).toBeLessThanOrEqual(flat.length);

      for (const c of clusters) {
        for (const p of c.procedural) {
          expect(p.vote.weight).toBeLessThanOrEqual(c.primary.vote.weight);
        }
      }

      // Score is strongly positive (Dem voted Yea on pro-UA bills). A handful
      // of inverse-direction procedurals (motion-to-recommit) pull it slightly
      // below +1.0 but should still be well above 0.5.
      expect(voteScore.score).toBeGreaterThan(0.5);
    });

    it('produces voted-pro valence on normal-direction pro-UA Aye votes', async () => {
      routeFetch([
        {
          match: (u) => /house-vote\/\d+\/\d+\/\d+\/members/.test(u),
          body: housePartyLineMembers(houseRep.bioguideId, 'Yea'),
        },
      ]);
      const { result } = renderHook(() => useVotingRecord(houseRep, ''));
      await act(async () => { await result.current.load(); });
      await waitFor(() => expect(result.current.status).toBe('success'));

      // For normal-direction votes (not motion-to-recommit etc.), Dem Aye on
      // pro-UA = voted-pro. Skip rows where directionMultiplier != 1.
      const rowsToCheck = result.current.data!.flat.filter(
        (r) => r.bill.direction === 'pro-ukraine' && r.memberVote === 'Aye' &&
               r.vote.directionMultiplier === 1,
      );
      expect(rowsToCheck.length).toBeGreaterThan(0);
      rowsToCheck.forEach((r) => expect(r.valence).toBe('voted-pro'));
    });

    it('FR-23: member absent from every roster → Did Not Serve → rows filtered out', async () => {
      // Empty results roster means the member was not seated in any of these
      // sessions. All rows should be excluded from the flat/clusters lists.
      routeFetch([
        {
          match: (u) => /house-vote\/\d+\/\d+\/\d+\/members/.test(u),
          body: {
            houseRollCallVoteMemberVotes: {
              results: [
                // Roster populated with OTHER members; our target not present.
                { bioguideID: 'OTHER1', firstName: 'A', lastName: 'B', voteCast: 'Yea', voteParty: 'D', voteState: 'CA' },
                { bioguideID: 'OTHER2', firstName: 'C', lastName: 'D', voteCast: 'Nay', voteParty: 'R', voteState: 'TX' },
              ],
            },
          },
        },
      ]);
      const { result } = renderHook(() => useVotingRecord(houseRep, ''));
      await act(async () => { await result.current.load(); });
      await waitFor(() => expect(result.current.status).toBe('success'));

      // Flat list is empty — member didn't serve for any of these curated votes
      expect(result.current.data!.flat).toHaveLength(0);
      expect(result.current.data!.clusters).toHaveLength(0);
      // No Did-Not-Serve rows should leak through
      for (const row of result.current.data!.flat) {
        expect(row.memberVote).not.toBe('Did Not Serve');
      }
    });

    it('FR-23: member in roster with Not Voting → real abstention, row KEPT', async () => {
      // Target member is in the roster but cast no ballot. Keep the row
      // (memberVote = 'Not Voting', valence = 'unstated').
      routeFetch([
        {
          match: (u) => /house-vote\/\d+\/\d+\/\d+\/members/.test(u),
          body: {
            houseRollCallVoteMemberVotes: {
              results: [
                { bioguideID: houseRep.bioguideId, firstName: 'Nikki', lastName: 'Budzinski',
                  voteCast: 'Not Voting', voteParty: 'D', voteState: 'IL' },
                { bioguideID: 'OTHER1', firstName: 'A', lastName: 'B', voteCast: 'Yea', voteParty: 'D', voteState: 'CA' },
              ],
            },
          },
        },
      ]);
      const { result } = renderHook(() => useVotingRecord(houseRep, ''));
      await act(async () => { await result.current.load(); });
      await waitFor(() => expect(result.current.status).toBe('success'));

      // All rows retained as real abstentions
      expect(result.current.data!.flat.length).toBeGreaterThan(0);
      for (const row of result.current.data!.flat) {
        expect(row.memberVote).toBe('Not Voting');
        expect(row.valence).toBe('unstated');
      }
    });

    it('FR-23 AC-23.5: abstentionCount reports primary-weight abstentions', async () => {
      // Same setup as the abstention test — member is in roster, votes Not Voting
      // on every curated pro-UA vote.
      routeFetch([
        {
          match: (u) => /house-vote\/\d+\/\d+\/\d+\/members/.test(u),
          body: {
            houseRollCallVoteMemberVotes: {
              results: [
                { bioguideID: houseRep.bioguideId, firstName: 'Nikki', lastName: 'Budzinski',
                  voteCast: 'Not Voting', voteParty: 'D', voteState: 'IL' },
              ],
            },
          },
        },
      ]);
      const { result } = renderHook(() => useVotingRecord(houseRep, ''));
      await act(async () => { await result.current.load(); });
      await waitFor(() => expect(result.current.status).toBe('success'));

      // Primary abstentions = rows on pro-UA bills with weight ≥ 0.7 where member is Not Voting
      const primaryAbstentions = result.current.data!.flat.filter(
        (r) => r.bill.direction === 'pro-ukraine'
            && r.vote.weight >= 0.7
            && r.memberVote === 'Not Voting',
      );
      // We expect at least one (curator produces multiple primary Pro-UA House votes)
      expect(primaryAbstentions.length).toBeGreaterThan(0);
      expect(result.current.data!.primaryAbstentionCount).toBe(primaryAbstentions.length);
    });

    it('House member Aye on motion-to-recommit = obstruction event', async () => {
      // motion-to-recommit has directionMultiplier = -1, so Aye → voted-anti,
      // and procedural kind → obstruction. House curated data includes
      // motion-to-recommit rows, so Aye across the board should produce
      // obstruction events for those rows specifically.
      routeFetch([
        {
          match: (u) => /house-vote\/\d+\/\d+\/\d+\/members/.test(u),
          body: housePartyLineMembers(houseRep.bioguideId, 'Yea'), // Yea on all
        },
      ]);
      const { result } = renderHook(() => useVotingRecord(houseRep, ''));
      await act(async () => { await result.current.load(); });
      await waitFor(() => expect(result.current.status).toBe('success'));

      // Every obstruction row should have valence voted-anti AND isObstruction.
      const obs = result.current.data!.flat.filter((r) => r.isObstruction);
      for (const row of obs) {
        expect(row.valence).toBe('voted-anti');
      }

      // Count matches the hook's summary.
      expect(result.current.data!.obstructionCount).toBe(obs.length);
      // We have motion-to-recommit rows in curated data → at least 1 obstruction.
      expect(result.current.data!.obstructionCount).toBeGreaterThan(0);
    });

    it('Dem voting Nay on pro-UA bill produces voted-anti valence (normal-direction rows)', async () => {
      routeFetch([
        {
          match: (u) => /house-vote\/\d+\/\d+\/\d+\/members/.test(u),
          body: housePartyLineMembers(houseRep.bioguideId, 'Nay'),
        },
      ]);
      const { result } = renderHook(() => useVotingRecord(houseRep, ''));
      await act(async () => { await result.current.load(); });
      await waitFor(() => expect(result.current.status).toBe('success'));

      // Normal-direction Nay on pro-UA = voted-anti. Skip motion-to-recommit
      // rows where Nay actually means pro.
      const antiRows = result.current.data!.flat.filter(
        (r) => r.bill.direction === 'pro-ukraine' && r.memberVote === 'Nay' &&
               r.vote.directionMultiplier === 1,
      );
      expect(antiRows.length).toBeGreaterThan(0);
      antiRows.forEach((r) => expect(r.valence).toBe('voted-anti'));
      expect(result.current.data!.voteScore.score).toBeLessThan(0);
    });
  });

  describe('Senate path', () => {
    it('matches by last-name + state and normalizes Yea → Aye', async () => {
      const curated = getCuratedVotesForChamber('Senate');
      expect(curated.length).toBeGreaterThan(0);

      routeFetch([
        {
          match: (u) => /vote_\d+_\d+_\d+\.xml/.test(u),
          body: senateXmlWith('Durbin', 'IL', 'Yea'),
          isXml: true,
        },
      ]);
      const { result } = renderHook(() => useVotingRecord(senator, ''));
      await act(async () => { await result.current.load(); });
      await waitFor(() => expect(result.current.status).toBe('success'));

      for (const row of result.current.data!.flat) {
        expect(row.memberVote).toBe('Aye');
      }
    });
  });
});
