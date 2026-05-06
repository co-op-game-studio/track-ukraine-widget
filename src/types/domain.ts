/** Core domain types — see docs/spec.md §6 Data Dictionary */

/** Social-media handles sourced from the unitedstates/congress-legislators
 *  dataset (FR-48). Each field is a human-readable handle; the widget
 *  builds the canonical URL at render time. `_id` variants from the
 *  upstream feed are dropped — we only need handles. */
export interface MemberSocials {
  twitter?: string;
  youtube?: string;
  facebook?: string;
  instagram?: string;
  threads?: string;
  bluesky?: string;
  mastodon?: string;
}

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
  /** Year the member first entered Congress (earliest `terms[*].startYear`
   *  from the Congress.gov member profile). Optional — older KV records
   *  predate this field. */
  yearEntered?: number;
  /** Social-media handles (FR-48). Optional — older KV records predate
   *  this field; members may also legitimately have zero social accounts. */
  socials?: MemberSocials;
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
