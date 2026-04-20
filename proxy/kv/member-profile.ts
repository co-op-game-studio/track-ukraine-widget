/**
 * MemberProfile type — the shape of /api/members/{bioguideId} responses
 * and of member:v1:* KV records.
 *
 * Owns the canonical type + TTL as of Phase 12 T-073 (2026-04-19).
 * `proxy/lib.ts` re-exports from here for legacy import paths.
 *
 * Traces: FR-42, FR-32 AC-32.1.
 */

/** Member profile — the canonical shape returned by /api/members/{bioguideId}. */
export interface MemberProfile {
  bioguideId: string;
  first: string;
  last: string;
  officialName: string;
  state: string;
  district: number | null;
  chamber: 'House' | 'Senate';
  party: string;
  photoUrl: string | null;
  website: string | null;
  searchKey: string;
  sponsored: unknown[];
  cosponsored: unknown[];
  /** Year the member first entered Congress (earliest term.startYear).
   *  Optional — older KV records predate this field. */
  yearEntered?: number;
  /** Social-media handles (FR-48) sourced from
   *  unitedstates/congress-legislators. Optional. */
  socials?: {
    twitter?: string;
    facebook?: string;
    youtube?: string;
    instagram?: string;
  };
  generatedAt: string;
  schemaVersion: number;
}

export const PROFILE_TTL_SECONDS = 30 * 24 * 3600; // 30d per ADR-009 member-detail class
