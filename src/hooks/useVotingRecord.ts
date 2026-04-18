/**
 * useVotingRecord — iterate curated Ukraine bills and fetch member's position
 * on each roll-call vote, emitting clustered + valence-tagged results.
 *
 * Traces to: FR-5, FR-6, FR-8, FR-11–FR-17, design.md §3.2.2, §4.4b, §4.8–4.10.
 *
 * Output shape:
 *   - clusters: grouped votes (procedurals nested under their passage/primary)
 *   - score:    weighted [-1, +1] Ukraine Support Score over all actions
 */
import { useCallback, useRef, useState } from 'react';
import { fetchHouseVoteMembers } from '../services/congressApi';
import {
  fetchSenateVoteDetail,
  normalizeVoteCast,
} from '../services/senateVotesApi';
import {
  getCuratedVotesForChamber,
  type CuratedBill,
} from '../services/ukraineFilter';
import { mapWithConcurrency } from '../utils/limitConcurrency';
import { computeValence, type Valence } from '../services/valence';
import { computeUkraineScore, type UkraineScore } from '../services/ukraineScore';
import { isObstructionVote } from '../services/obstruction';
import {
  bundledHouseCast,
  bundledSenateCast,
  hasBundledRoster,
  preloadHouseMember,
  preloadSenateMember,
} from '../services/bundledRosters';
import {
  clusterMemberVotes,
  type VoteForMember,
} from '../services/voteClustering';
import type { Representative } from '../types/domain';

/**
 * Concurrency cap for the runtime-fetch fallback path. With bundled rosters
 * (FR-24) the fallback rarely fires, but when it does, 8 is well within what
 * both upstreams (Senate.gov, Congress.gov) serve without rate-limiting.
 * Benchmarked in scripts/perf-check.mjs: 8 is ~10× faster than the old 3.
 */
const MAX_CONCURRENCY = 8;

export type RecordStatus = 'idle' | 'loading' | 'success' | 'error';

export interface MemberVoteRow extends VoteForMember {
  valence: Valence;
  /** True if this row is an obstruction event (procedural anti-UA vote, or
   *  Aye on anti-UA amendment/bill). Derived — see services/obstruction.ts. */
  isObstruction: boolean;
}

export interface ClusteredMemberVoteWithValence {
  primary: MemberVoteRow;
  procedural: MemberVoteRow[];
}

export interface VotingRecordData {
  clusters: ClusteredMemberVoteWithValence[];
  /** Flat list of all votes, for computing scores / exporting. */
  flat: MemberVoteRow[];
  /** Ukraine Support Score over the voting record (score card fills these in with bills too). */
  voteScore: UkraineScore;
  /** Number of obstruction events in the flat list (for UI summary). */
  obstructionCount: number;
  /**
   * FR-23 AC-23.5: count of primary-weight votes (weight ≥ 0.7) on pro-UA
   * bills where the member was in roster but abstained (`'Not Voting'`).
   * Surfaced in the score badge when ≥ the display threshold.
   */
  primaryAbstentionCount: number;
}

export interface UseVotingRecordResult {
  status: RecordStatus;
  data: VotingRecordData | null;
  error: Error | null;
  load: () => Promise<void>;
  reset: () => void;
}

/** Intermediate row type allowing 'Did Not Serve' — filtered out before clustering. */
interface RawRow {
  bill: CuratedBill;
  vote: VoteForMember['vote'];
  memberVote: VoteForMember['memberVote'] | 'Did Not Serve';
  /** Distinguishes the TWO failure modes:
   *   - inRoster:false → member wasn't a member of that chamber/session (Did Not Serve)
   *   - inRoster:true  → member was in roster but cast no ballot (real abstention) */
  inRoster: boolean;
}

// ─── House path ───
//
// FR-24: try the bundled roster FIRST. Only fall back to network if the roster
// isn't bundled for this vote (brand-new override pointing at a vote the last
// curator run didn't fetch, or a curator bug). Typical happy-path is zero
// network calls.

async function loadHouseRecord(
  member: Representative,
  apiBase: string,
): Promise<RawRow[]> {
  // Preload this member's KV profile so subsequent bundledHouseCast() lookups are hot.
  await preloadHouseMember(member.bioguideId);
  const curated = getCuratedVotesForChamber('House');

  // Partition into bundled-roster hits vs fallback-needed.
  const fallbackWork: typeof curated = [];
  const bundled: RawRow[] = [];

  for (const entry of curated) {
    const { bill, vote } = entry;
    const cast = bundledHouseCast(vote.congress, vote.session, vote.rollCall, member.bioguideId);
    if (cast === undefined) {
      // No bundled roster for this vote → need to fetch
      fallbackWork.push(entry);
    } else if (cast === null) {
      // Roster bundled, member absent → Did Not Serve
      bundled.push({ bill, vote, memberVote: 'Did Not Serve' as const, inRoster: false });
    } else {
      const memberVote = normalizeVoteCast(cast) as VoteForMember['memberVote'];
      bundled.push({ bill, vote, memberVote, inRoster: true });
    }
  }

  // Fallback path — hits network for any votes we don't have bundled.
  const fetched = await mapWithConcurrency(fallbackWork, MAX_CONCURRENCY, async ({ bill, vote }) => {
    try {
      const members = await fetchHouseVoteMembers(
        vote.congress,
        vote.session,
        vote.rollCall,
        apiBase,
      );
      const mine = members.find((r) => r.bioguideID === member.bioguideId);
      if (!mine) {
        return { bill, vote, memberVote: 'Did Not Serve' as const, inRoster: false };
      }
      const memberVote = normalizeVoteCast(mine.voteCast) as VoteForMember['memberVote'];
      return { bill, vote, memberVote, inRoster: true };
    } catch {
      return { bill, vote, memberVote: 'Not Voting' as const, inRoster: true };
    }
  });

  return [...bundled, ...fetched];
}

// ─── Senate path ───
//
// Senate XML isn't keyed by bioguide — the curator stored entries keyed by
// `${lastName}|${state}`. Widget does the same lookup here.

async function loadSenateRecord(
  member: Representative,
  apiBase: string,
): Promise<RawRow[]> {
  const lastName = member.name.split(',')[0]?.trim() ?? member.name;
  await preloadSenateMember(lastName, member.state);
  const curated = getCuratedVotesForChamber('Senate');

  const fallbackWork: typeof curated = [];
  const bundled: RawRow[] = [];

  for (const entry of curated) {
    const { bill, vote } = entry;
    if (!hasBundledRoster('Senate', vote.congress, vote.session, vote.rollCall)) {
      fallbackWork.push(entry);
      continue;
    }
    const cast = bundledSenateCast(vote.congress, vote.session, vote.rollCall, lastName, member.state);
    if (cast === null) {
      bundled.push({ bill, vote, memberVote: 'Did Not Serve' as const, inRoster: false });
    } else if (cast !== undefined) {
      const memberVote = normalizeVoteCast(cast) as VoteForMember['memberVote'];
      bundled.push({ bill, vote, memberVote, inRoster: true });
    }
  }

  const fetched = await mapWithConcurrency(fallbackWork, MAX_CONCURRENCY, async ({ bill, vote }) => {
    try {
      const detail = await fetchSenateVoteDetail(
        vote.congress,
        vote.session,
        vote.rollCall,
        apiBase,
      );
      const mine = detail.members.find(
        (m) => m.lastName === lastName && m.state === member.state,
      );
      if (!mine) {
        return { bill, vote, memberVote: 'Did Not Serve' as const, inRoster: false };
      }
      const memberVote = normalizeVoteCast(mine.voteCast) as VoteForMember['memberVote'];
      return { bill, vote, memberVote, inRoster: true };
    } catch {
      return { bill, vote, memberVote: 'Not Voting' as const, inRoster: true };
    }
  });

  return [...bundled, ...fetched];
}

// ─── Action → valence ───

function actionFromVote(cast: VoteForMember['memberVote']): 'voted-aye' | 'voted-nay' | 'voted-present' | 'not-voted' {
  switch (cast) {
    case 'Aye': return 'voted-aye';
    case 'Nay': return 'voted-nay';
    case 'Present': return 'voted-present';
    default: return 'not-voted';
  }
}

function toMemberVoteRow(row: VoteForMember): MemberVoteRow {
  const valence = computeValence(
    row.bill.direction,
    actionFromVote(row.memberVote),
    row.vote.directionMultiplier,
  );
  const isObstruction = isObstructionVote(row.bill, row.vote, row.memberVote, valence);
  return { ...row, valence, isObstruction };
}

// ─── Hook ───

export function useVotingRecord(
  member: Representative | null,
  apiBase: string,
): UseVotingRecordResult {
  const [status, setStatus] = useState<RecordStatus>('idle');
  const [data, setData] = useState<VotingRecordData | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const reqIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!member) return;
    const thisReq = ++reqIdRef.current;
    setStatus('loading');
    setError(null);
    setData(null);

    try {
      const rawWithStatus: RawRow[] =
        member.chamber === 'house'
          ? await loadHouseRecord(member, apiBase)
          : await loadSenateRecord(member, apiBase);
      if (thisReq !== reqIdRef.current) return;

      // FR-23 AC-23.3: drop Did-Not-Serve rows before any UI or scoring step.
      const rawRows: VoteForMember[] = rawWithStatus
        .filter((r): r is RawRow & { memberVote: VoteForMember['memberVote'] } =>
          r.inRoster && r.memberVote !== 'Did Not Serve')
        .map(({ bill, vote, memberVote }) => ({ bill, vote, memberVote }));

      const enrichedRows: MemberVoteRow[] = rawRows.map(toMemberVoteRow);

      const clusters = clusterMemberVotes(rawRows).map((c) => ({
        primary: toMemberVoteRow(c.primary),
        procedural: c.procedural.map(toMemberVoteRow),
      }));

      const voteScore = computeUkraineScore(
        enrichedRows.map((r) => ({ valence: r.valence, weight: r.vote.weight })),
      );

      const obstructionCount = enrichedRows.filter((r) => r.isObstruction).length;

      // FR-23 AC-23.5: count abstentions on primary-weight pro-UA votes
      const primaryAbstentionCount = enrichedRows.filter(
        (r) =>
          r.bill.direction === 'pro-ukraine' &&
          r.vote.weight >= 0.7 &&
          r.memberVote === 'Not Voting',
      ).length;

      setData({
        clusters,
        flat: enrichedRows,
        voteScore,
        obstructionCount,
        primaryAbstentionCount,
      });
      setStatus('success');
    } catch (e) {
      if (thisReq !== reqIdRef.current) return;
      setError(e instanceof Error ? e : new Error(String(e)));
      setStatus('error');
    }
  }, [member, apiBase]);

  const reset = useCallback(() => {
    reqIdRef.current++;
    setStatus('idle');
    setData(null);
    setError(null);
  }, []);

  return { status, data, error, load, reset };
}

// Helpers re-exported for tests & consumers that need them.
export type { Valence } from '../services/valence';

// Helper bills to reference if consumers want the curated bill details for a given cluster.
export type { CuratedBill };
