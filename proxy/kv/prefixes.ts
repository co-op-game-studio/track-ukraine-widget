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
} as const;
