/**
 * D1 → KV member projections (FR-32 AC-32.40). Re-exports the pure projector
 * that lives in proxy/services/member-projector.ts so the publish CLI and the
 * Worker routes (D1 self-heal fallback) share ONE implementation and can't
 * drift. (Mirrors how publish-d1-to-kv re-exports proxy/services/kv-projector.)
 */
export {
  projectMemberProfile,
  projectStateMembers,
  projectNameIndex,
  projectRosters,
  type MemberRow,
  type VoteCastRow,
  type MemberSummary,
  type StateMembersRecord,
  type NameIndexShard,
  type NameIndexMeta,
  type RosterRecord,
} from '../../../proxy/services/member-projector';
