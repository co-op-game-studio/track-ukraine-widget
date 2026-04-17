/**
 * Congress.gov API Service
 * See: docs/design.md §4.2, docs/api-contracts.md §2
 * Traces to: FR-3, FR-4, FR-5, FR-7
 */
import type {
  CongressMemberListResponse,
  CongressMemberSummary,
  CongressMemberDetail,
  CongressMemberDetailResponse,
  HouseVoteListResponse,
  HouseRollCallVoteDetail,
  HouseVoteDetailResponse,
  HouseRollCallMemberVote,
  HouseVoteMembersResponse,
  CongressLegislationListResponse,
} from '../types/api';

const CONGRESS = 119;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Congress.gov API returned ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function congressUrl(apiBase: string, path: string, params: Record<string, string | number> = {}): string {
  const allParams = { ...params, format: 'json' };
  const qs = new URLSearchParams(
    Object.entries(allParams).map(([k, v]) => [k, String(v)]),
  ).toString();
  return `${apiBase}/api/congress${path}?${qs}`;
}

// ─── Members ───

export async function fetchMembersByStateDistrict(
  state: string,
  district: number,
  apiBase: string,
): Promise<CongressMemberSummary[]> {
  const url = congressUrl(apiBase, `/v3/member/congress/${CONGRESS}/${state}/${district}`, {
    currentMember: 'true',
  });
  const data = await fetchJson<CongressMemberListResponse>(url);
  return data.members;
}

export async function fetchMembersByState(
  state: string,
  apiBase: string,
): Promise<CongressMemberSummary[]> {
  const url = congressUrl(apiBase, `/v3/member/congress/${CONGRESS}/${state}`, {
    currentMember: 'true',
    limit: '250',
  });
  const data = await fetchJson<CongressMemberListResponse>(url);
  return data.members;
}

export async function fetchMemberDetail(
  bioguideId: string,
  apiBase: string,
): Promise<CongressMemberDetail> {
  const url = congressUrl(apiBase, `/v3/member/${bioguideId}`);
  const data = await fetchJson<CongressMemberDetailResponse>(url);
  return data.member;
}

// ─── House Votes ───

export async function fetchHouseVoteList(
  congress: number,
  session: number,
  apiBase: string,
  offset = 0,
  limit = 250,
): Promise<HouseVoteListResponse> {
  const url = congressUrl(apiBase, `/v3/house-vote/${congress}/${session}`, {
    offset,
    limit,
  });
  return fetchJson<HouseVoteListResponse>(url);
}

export async function fetchHouseVoteDetail(
  congress: number,
  session: number,
  rollCall: number,
  apiBase: string,
): Promise<HouseRollCallVoteDetail> {
  const url = congressUrl(apiBase, `/v3/house-vote/${congress}/${session}/${rollCall}`);
  const data = await fetchJson<HouseVoteDetailResponse>(url);
  return data.houseRollCallVote;
}

export async function fetchHouseVoteMembers(
  congress: number,
  session: number,
  rollCall: number,
  apiBase: string,
): Promise<HouseRollCallMemberVote[]> {
  const url = congressUrl(apiBase, `/v3/house-vote/${congress}/${session}/${rollCall}/members`, {
    limit: '500',
  });
  const data = await fetchJson<HouseVoteMembersResponse>(url);
  return data.houseRollCallVoteMemberVotes.results;
}

// ─── Legislation ───

export async function fetchSponsoredLegislation(
  bioguideId: string,
  apiBase: string,
  offset = 0,
  limit = 20,
): Promise<CongressLegislationListResponse> {
  const url = congressUrl(apiBase, `/v3/member/${bioguideId}/sponsored-legislation`, {
    offset,
    limit,
  });
  return fetchJson<CongressLegislationListResponse>(url);
}

export async function fetchCosponsoredLegislation(
  bioguideId: string,
  apiBase: string,
  offset = 0,
  limit = 20,
): Promise<CongressLegislationListResponse> {
  const url = congressUrl(apiBase, `/v3/member/${bioguideId}/cosponsored-legislation`, {
    offset,
    limit,
  });
  return fetchJson<CongressLegislationListResponse>(url);
}
