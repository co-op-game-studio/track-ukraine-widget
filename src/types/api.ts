/**
 * TypeScript types for external API response shapes.
 *
 * Source of truth: docs/api-contracts.md (our authoritative contract).
 * Vendored reference: docs/congress-api-openapi.json (Congress.gov OpenAPI 3.0.3).
 *
 * When you see a divergence from the vendored OpenAPI spec, it's documented in
 * api-contracts.md §2.1 "Divergences from Vendored OpenAPI Spec".
 */

// ─── U.S. Census Bureau Geocoder ───
// No OpenAPI spec exists. Documented from live observation.

export interface CensusGeography {
  GEOID: string;
  NAME: string;
  BASENAME: string;
  STATE: string;
  CD119?: string;
  CDSESSN?: string;
  FUNCSTAT: string;
  [key: string]: string | number | undefined;
}

export interface CensusAddressMatch {
  matchedAddress: string;
  coordinates: { x: number; y: number };
  addressComponents: {
    city: string;
    state: string;
    zip: string;
    streetName: string;
    [key: string]: string;
  };
  geographies: Record<string, CensusGeography[]>;
}

export interface CensusGeocodeResponse {
  result: {
    input: {
      address: { address: string };
      benchmark: { benchmarkName: string };
      vintage: { vintageName: string };
    };
    addressMatches: CensusAddressMatch[];
  };
}

// ─── Congress.gov API v3 — Member List ───
// Matches schema `Members` with divergence D-1 applied (district field).

export interface CongressMemberSummary {
  bioguideId: string;
  name: string;              // "Last, First" format
  partyName: string;         // "Democratic" | "Republican" | etc.
  state: string;             // Full state name, e.g., "Illinois"
  /** D-1: district is present in real responses but missing from OpenAPI schema. null for senators. */
  district: number | null;
  depiction?: {
    imageUrl: string;
    attribution: string;
  };
  terms: {
    item: {
      chamber: string;       // "House of Representatives" | "Senate"
      startYear: number;
      endYear?: number;
    }[];
  };
  updateDate: string;
  url: string;
}

export interface CongressMemberListResponse {
  members: CongressMemberSummary[];
  /** D-4: pagination present in real responses but undocumented in spec. */
  pagination: {
    count: number;
    next?: string;
  };
  request: Record<string, string>;
}

// ─── Congress.gov API v3 — Member Detail ───
// Matches schema `Member` with divergence D-2 applied (lastName vs lastname).

export interface CongressMemberDetail {
  bioguideId: string;
  directOrderName: string;       // "Richard J. Durbin"
  invertedOrderName: string;     // "Durbin, Richard J."
  firstName: string;
  /** D-2: OpenAPI spec says `lastname` (lowercase n); real responses use `lastName`. */
  lastName: string;
  honorificName?: string;
  birthYear: string;
  currentMember: boolean;
  state: string;
  depiction?: {
    imageUrl: string;
    attribution: string;
  };
  partyHistory: {
    partyAbbreviation: string;
    /** D-3: OpenAPI example says "Democrat"; real responses say "Democratic". */
    partyName: string;
    startYear: number;
    endYear?: number;
  }[];
  terms: {
    chamber: string;
    congress: number;
    startYear: number;
    endYear?: number;
    memberType: string;
    stateCode: string;
    stateName: string;
  }[];
  leadership?: {
    congress: number;
    type: string;
  }[];
  sponsoredLegislation: { count: number; url: string };
  cosponsoredLegislation: { count: number; url: string };
  officialWebsiteUrl?: string;
}

export interface CongressMemberDetailResponse {
  member: CongressMemberDetail;
}

// ─── Congress.gov API v3 — Legislation ───
// Matches schema `sponsoredLegislation`, with D-6 divergence:
// sponsored/cosponsored lists are a *discriminated union* of bills and amendments.

export interface CongressBillSummary {
  kind: 'bill';
  congress: number;
  number: string;             // "4307"
  type: string;               // "HR", "S", "HJRES", etc. Non-null for bills.
  title: string;
  introducedDate: string;     // "YYYY-MM-DD"
  latestAction: {
    actionDate: string;
    text: string;
  } | null;
  url: string;
  policyArea?: { name: string | null };
}

export interface CongressAmendmentSummary {
  kind: 'amendment';
  congress: number;
  amendmentNumber: string;    // e.g., "4855"
  introducedDate: string;
  latestAction: { actionDate: string; text: string } | null;
  url: string;                // points at /v3/amendment/...
}

/** Raw entry before we discriminate; `type` is null for amendments. */
export interface CongressLegislationRawEntry {
  congress: number;
  number?: string;
  type?: string | null;
  title?: string;
  amendmentNumber?: string;
  introducedDate?: string;
  latestAction?: { actionDate: string; text: string } | null;
  url?: string;
  policyArea?: { name: string | null };
}

export type CongressLegislationEntry = CongressBillSummary | CongressAmendmentSummary;

export interface CongressLegislationListResponse {
  sponsoredLegislation?: CongressLegislationRawEntry[];
  cosponsoredLegislation?: CongressLegislationRawEntry[];
  pagination: {
    count: number;
    next?: string;
  };
}

// ─── Congress.gov API v3 — House Roll Call Votes ───
// Matches schemas `HouseVote`, `HouseVoteNumber`, `HouseVoteMembers`.

export interface HouseRollCallVoteSummary {
  congress: number;
  rollCallNumber: number;
  sessionNumber: number;
  startDate: string;            // ISO datetime "2025-09-08T18:56:00-04:00"
  result: string;               // "Passed" | "Failed" | etc.
  voteType: string;             // "2/3 Yea-And-Nay" | "Yea-and-Nay" | etc.
  legislationType?: string;     // "HR", "S", etc.
  legislationNumber?: string;
  legislationUrl?: string;
  sourceDataURL: string;
  url: string;
  identifier: number;
  updateDate: string;
}

export interface HouseVoteListResponse {
  houseRollCallVotes: HouseRollCallVoteSummary[];
  pagination: {
    count: number;
    next?: string;
  };
}

export interface HouseVotePartyTotal {
  voteParty: string;            // "R" | "D" | "I"
  party: { name: string; type: string };
  yeaTotal: number;
  nayTotal: number;
  presentTotal: number;
  notVotingTotal: number;
}

/** Extends HouseVoteNumberBase with voteQuestion and votePartyTotal (per OpenAPI allOf). */
export interface HouseRollCallVoteDetail extends HouseRollCallVoteSummary {
  voteQuestion: string;
  votePartyTotal: HouseVotePartyTotal[];
}

export interface HouseVoteDetailResponse {
  houseRollCallVote: HouseRollCallVoteDetail;
}

/** Matches schema `houseVoteResults`. Note: bioguide field is "bioguideID" (uppercase ID). */
export interface HouseRollCallMemberVote {
  bioguideID: string;           // Note: uppercase — different from bioguideId elsewhere
  firstName: string;
  lastName: string;
  /** D-5: Full observed set is "Yea" | "Nay" | "Present" | "Not Voting" (OpenAPI shows only "Yea"). */
  voteCast: string;
  voteParty: string;            // "R" | "D" | "I"
  voteState: string;            // "IL"
}

export interface HouseVoteMembersResponse {
  houseRollCallVoteMemberVotes: HouseRollCallVoteSummary & {
    results: HouseRollCallMemberVote[];
    voteQuestion?: string;
  };
}
