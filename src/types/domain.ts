/** Core domain types — see docs/spec.md §6 Data Dictionary */

export interface Representative {
  bioguideId: string;
  name: string;
  /** Full party name from API (e.g., "Democratic", "Republican", "Independent") */
  party: string;
  /** Authoritative single-letter abbreviation from partyHistory — "D" | "R" | "I" etc.
   *  Use this (not party.startsWith('D')) for party-line logic. See FR-19. */
  partyAbbreviation: 'D' | 'R' | 'I' | 'L' | 'G' | string;
  state: string;
  district: number | null;
  chamber: 'house' | 'senate';
  photoUrl: string | null;
  isNonVoting: boolean;
  /** Member's own official site (e.g., hometown.senate.gov). May be null. */
  officialWebsiteUrl?: string | null;
}

export type VoteCast = 'Aye' | 'Nay' | 'Present' | 'Not Voting' | 'Did Not Serve';

export interface VoteRecord {
  date: string;
  billNumber: string | null;
  billTitle: string;
  question: string;
  memberVote: VoteCast;
  result: string;
  partyMajorityVote: string;
}

export interface Bill {
  number: string;
  title: string;
  dateIntroduced: string;
  latestAction: string;
  congressGovUrl: string;
  relationship: 'sponsored' | 'cosponsored';
  /** True if this is one of the top-5 featured Ukraine bills */
  featured?: boolean;
}

export interface PartyAlignment {
  score: number | null;
  totalPartyLineVotes: number;
  votesWithParty: number;
}

export interface LookupResult {
  state: string;
  district: number;
  representatives: Representative[];
}

/** Result from Census geocoder after FIPS-to-state conversion */
export interface GeocodedDistrict {
  state: string | null;
  district: number | null;
  matchedAddress: string | null;
}

/** Data shape fed into the party alignment calculator */
export interface VoteWithPartyData {
  memberVote: 'Aye' | 'Nay' | 'Present' | 'Not Voting';
  democratYeas: number;
  democratNays: number;
  republicanYeas: number;
  republicanNays: number;
}

/** Shape returned by the service when looking up a single member's cast on a vote.
 *  `Did Not Serve` = member not present in the roll-call roster at all. */
export type MemberCastLookup =
  | { kind: 'cast'; cast: 'Aye' | 'Nay' | 'Present' | 'Not Voting' }
  | { kind: 'did-not-serve' };
