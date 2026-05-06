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
    youtube?: string;
    facebook?: string;
    instagram?: string;
    threads?: string;
    bluesky?: string;
    mastodon?: string;
  };
  /**
   * FR-55 / ADR-018 §6 — party-mean Ukraine score, used by the embed as the
   * Bayesian shrink target for under-confident reps. Stamped onto each
   * record by the Worker's read-through fill from a separate KV key
   * (`scores:v1:party-priors`) computed at publish time by
   * `scripts/compute-party-priors.ts`.
   *
   * `null` when:
   *   - the priors KV key is missing entirely (cold deploy, before the
   *     publish job has run for the first time)
   *   - the rep's party has fewer than 5 full-confidence reps (degenerate
   *     population — see ADR-018 "Risk" section)
   *
   * In either null case, `useUkraineScore` skips the shrink branch and
   * the displayed score equals the raw score (current pre-V4 behavior).
   * Older KV records (predating this field) read as `undefined` →
   * frontend treats `undefined` and `null` interchangeably as "no shrink."
   */
  partyPrior?: number | null;
  generatedAt: string;
  schemaVersion: number;
}

export const PROFILE_TTL_SECONDS = 30 * 24 * 3600; // 30d per ADR-009 member-detail class
