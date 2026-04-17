/**
 * Congress.gov API Service Tests
 * Traces to: FR-3, FR-4, FR-5, FR-7
 * Authoritative contract: docs/api-contracts.md §2
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchMembersByStateDistrict,
  fetchMembersByState,
  fetchMemberDetail,
  fetchHouseVoteList,
  fetchHouseVoteDetail,
  fetchHouseVoteMembers,
  fetchSponsoredLegislation,
  fetchCosponsoredLegislation,
} from '../../src/services/congressApi';

// ─── Fixtures (shapes verified against real API responses 2026-04-16) ───

const houseRepListResponse = {
  members: [
    {
      bioguideId: 'B001315',
      name: 'Budzinski, Nikki',
      partyName: 'Democratic',
      state: 'Illinois',
      district: 13,
      depiction: { imageUrl: 'https://www.congress.gov/img/member/b001315_200.jpg', attribution: '' },
      terms: { item: [{ chamber: 'House of Representatives', startYear: 2023 }] },
      updateDate: '2025-09-24T07:40:18Z',
      url: 'https://api.congress.gov/v3/member/B001315?format=json',
    },
  ],
  pagination: { count: 1 },
  request: {},
};

const stateMemberListResponse = {
  members: [
    {
      bioguideId: 'D000563',
      name: 'Durbin, Richard J.',
      partyName: 'Democratic',
      state: 'Illinois',
      district: null,
      depiction: { imageUrl: 'https://www.congress.gov/img/member/d000563_200.jpg', attribution: '' },
      terms: {
        item: [
          { chamber: 'House of Representatives', startYear: 1983, endYear: 1997 },
          { chamber: 'Senate', startYear: 1997 },
        ],
      },
      updateDate: '2026-03-08T10:31:07Z',
      url: 'https://api.congress.gov/v3/member/D000563?format=json',
    },
    {
      bioguideId: 'D000622',
      name: 'Duckworth, Tammy',
      partyName: 'Democratic',
      state: 'Illinois',
      district: null,
      terms: { item: [{ chamber: 'Senate', startYear: 2017 }] },
      updateDate: '2026-03-08T10:31:06Z',
      url: 'https://api.congress.gov/v3/member/D000622?format=json',
    },
    {
      bioguideId: 'B001315',
      name: 'Budzinski, Nikki',
      partyName: 'Democratic',
      state: 'Illinois',
      district: 13,
      terms: { item: [{ chamber: 'House of Representatives', startYear: 2023 }] },
      updateDate: '2025-09-24T07:40:18Z',
      url: 'https://api.congress.gov/v3/member/B001315?format=json',
    },
  ],
  pagination: { count: 19 },
  request: {},
};

const memberDetailResponse = {
  member: {
    bioguideId: 'D000563',
    directOrderName: 'Richard J. Durbin',
    invertedOrderName: 'Durbin, Richard J.',
    firstName: 'Richard',
    lastName: 'Durbin',
    birthYear: '1944',
    currentMember: true,
    state: 'Illinois',
    depiction: { imageUrl: 'https://www.congress.gov/img/member/d000563_200.jpg', attribution: '' },
    partyHistory: [{ partyAbbreviation: 'D', partyName: 'Democratic', startYear: 1983 }],
    terms: [
      {
        chamber: 'Senate',
        congress: 119,
        startYear: 2025,
        stateCode: 'IL',
        stateName: 'Illinois',
        memberType: 'Senator',
      },
    ],
    sponsoredLegislation: { count: 2135, url: 'https://api.congress.gov/v3/member/D000563/sponsored-legislation' },
    cosponsoredLegislation: { count: 10417, url: 'https://api.congress.gov/v3/member/D000563/cosponsored-legislation' },
  },
};

const houseVoteListResponse = {
  houseRollCallVotes: [
    {
      congress: 119,
      rollCallNumber: 240,
      sessionNumber: 1,
      startDate: '2025-09-08T18:56:00-04:00',
      result: 'Passed',
      voteType: '2/3 Yea-And-Nay',
      legislationType: 'HR',
      legislationNumber: '3424',
      legislationUrl: 'https://www.congress.gov/bill/119/house-bill/3424',
      sourceDataURL: 'https://clerk.house.gov/evs/2025/roll240.xml',
      url: 'https://api.congress.gov/v3/house-vote/119/1/240',
      identifier: 11912025240,
      updateDate: '2025-09-09T18:53:19-04:00',
    },
  ],
  pagination: { count: 362 },
};

const houseVoteDetailResponse = {
  houseRollCallVote: {
    congress: 119,
    rollCallNumber: 240,
    sessionNumber: 1,
    startDate: '2025-09-08T18:56:00-04:00',
    result: 'Passed',
    voteQuestion: 'On Motion to Suspend the Rules and Pass',
    voteType: '2/3 Yea-And-Nay',
    legislationType: 'HR',
    legislationNumber: '3424',
    votePartyTotal: [
      {
        voteParty: 'R',
        party: { name: 'Republican', type: 'R' },
        yeaTotal: 202,
        nayTotal: 0,
        presentTotal: 0,
        notVotingTotal: 16,
      },
      {
        voteParty: 'D',
        party: { name: 'Democrat', type: 'D' },
        yeaTotal: 195,
        nayTotal: 1,
        presentTotal: 0,
        notVotingTotal: 16,
      },
    ],
    sourceDataURL: '',
    url: '',
    identifier: 11912025240,
    updateDate: '2025-09-09',
  },
};

const houseVoteMembersResponse = {
  houseRollCallVoteMemberVotes: {
    congress: 119,
    rollCallNumber: 240,
    sessionNumber: 1,
    startDate: '2025-09-08T18:56:00-04:00',
    result: 'Passed',
    voteType: '2/3 Yea-And-Nay',
    sourceDataURL: '',
    url: '',
    identifier: 11912025240,
    updateDate: '2025-09-09',
    results: [
      { bioguideID: 'A000055', firstName: 'Robert', lastName: 'Aderholt', voteCast: 'Yea', voteParty: 'R', voteState: 'AL' },
      { bioguideID: 'B001315', firstName: 'Nikki', lastName: 'Budzinski', voteCast: 'Yea', voteParty: 'D', voteState: 'IL' },
    ],
  },
};

const sponsoredLegResponse = {
  sponsoredLegislation: [
    {
      congress: 119,
      number: '4307',
      type: 'S',
      title: 'A bill to expand the scope of the Do Not Call rules',
      introducedDate: '2026-04-15',
      latestAction: { actionDate: '2026-04-15', text: 'Read twice and referred to committee.' },
      url: 'https://api.congress.gov/v3/bill/119/s/4307?format=json',
      policyArea: { name: null },
    },
  ],
  pagination: { count: 2135 },
};

// ─── Tests ───

function mockJson(data: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify(data), { status: 200 }),
  );
}

describe('congressApi', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchMembersByStateDistrict', () => {
    it('returns the House representative for a state+district combo', async () => {
      mockJson(houseRepListResponse);
      const result = await fetchMembersByStateDistrict('IL', 13, '');
      expect(result).toHaveLength(1);
      expect(result[0]!.bioguideId).toBe('B001315');
      expect(result[0]!.district).toBe(13);
      expect(result[0]!.partyName).toBe('Democratic');
    });

    it('calls /v3/member/congress/119/{state}/{district} with currentMember=true and format=json', async () => {
      const spy = mockJson(houseRepListResponse);
      await fetchMembersByStateDistrict('IL', 13, '/proxy');
      const url = spy.mock.calls[0]![0] as string;
      expect(url).toContain('/proxy/api/congress/v3/member/congress/119/IL/13');
      expect(url).toContain('currentMember=true');
      expect(url).toContain('format=json');
    });

    it('passes at-large district 0 correctly', async () => {
      const spy = mockJson({ members: [], pagination: { count: 0 }, request: {} });
      await fetchMembersByStateDistrict('WY', 0, '');
      const url = spy.mock.calls[0]![0] as string;
      expect(url).toContain('/v3/member/congress/119/WY/0');
    });

    it('throws on non-200 response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Rate limited', { status: 429 }),
      );
      await expect(fetchMembersByStateDistrict('IL', 13, '')).rejects.toThrow(/429/);
    });
  });

  describe('fetchMembersByState', () => {
    it('returns all current members for a state', async () => {
      mockJson(stateMemberListResponse);
      const result = await fetchMembersByState('IL', '');
      expect(result).toHaveLength(3);
    });

    it('includes both senators (district=null) and house reps (district=number)', async () => {
      mockJson(stateMemberListResponse);
      const result = await fetchMembersByState('IL', '');
      const senators = result.filter((m) => m.district === null);
      const house = result.filter((m) => m.district !== null);
      expect(senators).toHaveLength(2);
      expect(house).toHaveLength(1);
    });

    it('requests up to 250 members per page', async () => {
      const spy = mockJson(stateMemberListResponse);
      await fetchMembersByState('IL', '');
      const url = spy.mock.calls[0]![0] as string;
      expect(url).toContain('limit=250');
    });
  });

  describe('fetchMemberDetail', () => {
    it('returns detailed member info with directOrderName and terms array', async () => {
      mockJson(memberDetailResponse);
      const result = await fetchMemberDetail('D000563', '');
      expect(result.directOrderName).toBe('Richard J. Durbin');
      expect(result.lastName).toBe('Durbin'); // D-2: our contract uses camelCase
      expect(result.partyHistory[0]!.partyName).toBe('Democratic'); // D-3
      expect(result.terms[0]!.chamber).toBe('Senate');
    });
  });

  describe('fetchHouseVoteList', () => {
    it('returns list of roll call vote summaries', async () => {
      mockJson(houseVoteListResponse);
      const result = await fetchHouseVoteList(119, 1, '', 0, 250);
      expect(result.houseRollCallVotes).toHaveLength(1);
      expect(result.houseRollCallVotes[0]!.rollCallNumber).toBe(240);
      expect(result.houseRollCallVotes[0]!.legislationNumber).toBe('3424');
    });

    it('calls /v3/house-vote/{congress}/{session} with limit and offset', async () => {
      const spy = mockJson(houseVoteListResponse);
      await fetchHouseVoteList(119, 1, '', 40, 100);
      const url = spy.mock.calls[0]![0] as string;
      expect(url).toContain('/v3/house-vote/119/1');
      expect(url).toContain('limit=100');
      expect(url).toContain('offset=40');
    });
  });

  describe('fetchHouseVoteDetail', () => {
    it('returns vote detail with voteQuestion and votePartyTotal', async () => {
      mockJson(houseVoteDetailResponse);
      const result = await fetchHouseVoteDetail(119, 1, 240, '');
      expect(result.voteQuestion).toBe('On Motion to Suspend the Rules and Pass');
      expect(result.votePartyTotal).toHaveLength(2);
      const rep = result.votePartyTotal.find((p) => p.voteParty === 'R')!;
      expect(rep.yeaTotal).toBe(202);
      expect(rep.nayTotal).toBe(0);
    });
  });

  describe('fetchHouseVoteMembers', () => {
    it('returns individual member votes with bioguideID (uppercase ID)', async () => {
      mockJson(houseVoteMembersResponse);
      const result = await fetchHouseVoteMembers(119, 1, 240, '');
      expect(result).toHaveLength(2);
      expect(result[0]!.bioguideID).toBe('A000055'); // note uppercase ID
      expect(result[0]!.voteCast).toBe('Yea');
    });

    it('requests the /members subpath', async () => {
      const spy = mockJson(houseVoteMembersResponse);
      await fetchHouseVoteMembers(119, 1, 240, '');
      const url = spy.mock.calls[0]![0] as string;
      expect(url).toContain('/v3/house-vote/119/1/240/members');
    });
  });

  describe('fetchSponsoredLegislation', () => {
    it('returns sponsored bills list with pagination', async () => {
      mockJson(sponsoredLegResponse);
      const result = await fetchSponsoredLegislation('D000563', '', 0, 20);
      expect(result.sponsoredLegislation).toHaveLength(1);
      expect(result.sponsoredLegislation![0]!.number).toBe('4307');
      expect(result.sponsoredLegislation![0]!.type).toBe('S');
      expect(result.pagination.count).toBe(2135);
    });
  });

  describe('fetchCosponsoredLegislation', () => {
    it('returns cosponsored bills list', async () => {
      const cosponsored = {
        cosponsoredLegislation: sponsoredLegResponse.sponsoredLegislation,
        pagination: { count: 100 },
      };
      mockJson(cosponsored);
      const result = await fetchCosponsoredLegislation('D000563', '', 0, 20);
      expect(result.cosponsoredLegislation).toHaveLength(1);
    });

    it('calls the /cosponsored-legislation subpath', async () => {
      const spy = mockJson({ cosponsoredLegislation: [], pagination: { count: 0 } });
      await fetchCosponsoredLegislation('D000563', '', 0, 20);
      const url = spy.mock.calls[0]![0] as string;
      expect(url).toContain('/v3/member/D000563/cosponsored-legislation');
    });
  });
});
