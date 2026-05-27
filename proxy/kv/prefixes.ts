/**
 * KV key prefixes for Worker-managed records.
 *
 * Owns the canonical `KV_PREFIXES` constant as of Phase 12 T-073 (2026-04-19).
 * `proxy/lib.ts` re-exports from here for legacy import paths.
 *
 * Traces: ADR-011, FR-32.
 */

export const KV_PREFIXES = {
  member: 'member:v1:',
  bill: 'bill:v1:',
  rollCall: 'roll-call:v1:',
  rollCallRoster: 'roll-call-roster:v1:',
  stateMembers: 'state-members:v1:',
  nameIndex: 'name-index:v1:',
  cache: 'cache:v1:',
  // V4 (FR-51) — denormalized read-snapshot prefixes written by
  // scripts/publish-d1-to-kv.ts.
  comment: 'comment:v1:',
  socialPost: 'social-post:v1:',
  quote: 'quote:v1:',
  stats: 'stats:v1:',
  auditFeed: 'audit-feed:v1:',
  // FR-55 / ADR-018 §6 — per-party Ukraine-score means, computed at publish
  // time by scripts/compute-party-priors.ts. Single record at the literal key
  // `scores:v1:party-priors`. Read by api-members read-through to stamp
  // `partyPrior` onto each MemberProfile.
  scores: 'scores:v1:',
  // Per-rep render bundle — everything the embed needs to render one rep
  // in a single KV read. Composed from the smaller per-resource records
  // (member, bills, roll-calls, comments, quotes, social-posts) by the
  // read-through fill in api-rep-bundle.ts. Invalidated by admin writes
  // that touch the rep's data.
  repBundle: 'rep-bundle:v1:',
} as const;

