/**
 * useVotingRecord — iterate curated Ukraine bills and fetch member's position
 * on each roll-call vote, emitting clustered + valence-tagged results.
 *
 * Traces to: FR-5, FR-6, FR-8, FR-11–FR-17 (REVISED v2.5.2 to use
 * KV-backed roll-call rosters per ADR-012), design.md §3.2.4, §4.4b,
 * §4.8–4.10.
 *
 * Output shape:
 *   - clusters: grouped votes (procedurals nested under their passage/primary)
 *   - score:    weighted [-1, +1] Ukraine Support Score over all actions
 *
 * Data source (v2.5.2): every curated roll-call resolves via
 * `/api/roll-call-rosters/{chamber}/{c}/{s}/{rc}`, a KV-backed Worker
 * route. No upstream Congress.gov / Senate.gov calls are made by the
 * widget. See FR-12 REVISED v2.5.2.
 */
import { useCallback, useRef, useState } from 'react';
import {
  getCuratedVotesForChamber,
  type CuratedBill,
} from '../services/ukraineFilter';
import { mapWithConcurrency } from '../utils/limitConcurrency';
import { computeValence, type Valence } from '../services/valence';
import { computeUkraineScore, type UkraineScore } from '../services/ukraineScore';
import { isObstructionVote } from '../services/obstruction';
import {
  fetchRollCallRoster,
  normalizeVoteCast,
  type HouseRollCallRoster,
  type SenateRollCallRoster,
} from '../services/rollCallRosters';
import {
  clusterMemberVotes,
  type VoteForMember,
} from '../services/voteClustering';
import type { Representative } from '../types/domain';

/**
 * Concurrency cap for roster fetches. These are KV reads served from
 * the edge (~5-50 ms each) so higher concurrency is fine — 8 keeps us
 * well below the per-IP rate limit (AC-27.21) and parallelizes the
 * worst-case ~27 fetches into a couple of network round-trips.
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
  const curated = getCuratedVotesForChamber('House');

  const rows = await mapWithConcurrency(curated, MAX_CONCURRENCY, async ({ bill, vote }) => {
    let roster;
    try {
      roster = (await fetchRollCallRoster(
        'House',
        vote.congress,
        vote.session,
        vote.rollCall,
        apiBase,
      )) as HouseRollCallRoster | null;
    } catch {
      // Transient network/roster error: surface as Did Not Vote rather
      // than failing the whole record; the UI still renders other bills.
      return { bill, vote, memberVote: 'Did Not Serve' as const, inRoster: false };
    }
    if (!roster) {
      // Curator has not (yet) written this roster: treat as Did Not Serve
      // so the row renders neutrally. Observed in practice only when a
      // curated vote is added without re-running the curator.
      return { bill, vote, memberVote: 'Did Not Serve' as const, inRoster: false };
    }
    const cast = roster.casts[member.bioguideId];
    if (cast === undefined) {
      // Member was not in this roll-call roster — either Did Not Serve
      // (not in Congress at all) or Not Voting (in office but absent).
      // The roster only surfaces the latter; widget callers can cross-
      // reference `state-members:v1:{state}` if finer distinction is
      // required. Default to Did Not Serve to match prior behavior.
      return { bill, vote, memberVote: 'Did Not Serve' as const, inRoster: false };
    }
    const memberVote = normalizeVoteCast(cast) as VoteForMember['memberVote'];
    return { bill, vote, memberVote, inRoster: true };
  });

  return rows;
}

// ─── Senate path ───
//
// Senate rosters are keyed by (lastName, state) — Senate XML carries no
// bioguide IDs, so the curator preserves the same lookup key (see
// design.md §4.3 for the matching algorithm). Widget does the lookup here.

async function loadSenateRecord(
  member: Representative,
  apiBase: string,
): Promise<RawRow[]> {
  const lastName = member.name.split(',')[0]?.trim() ?? member.name;
  const curated = getCuratedVotesForChamber('Senate');

  const rows = await mapWithConcurrency(curated, MAX_CONCURRENCY, async ({ bill, vote }) => {
    let roster;
    try {
      roster = (await fetchRollCallRoster(
        'Senate',
        vote.congress,
        vote.session,
        vote.rollCall,
        apiBase,
      )) as SenateRollCallRoster | null;
    } catch {
      return { bill, vote, memberVote: 'Did Not Serve' as const, inRoster: false };
    }
    if (!roster) {
      return { bill, vote, memberVote: 'Did Not Serve' as const, inRoster: false };
    }
    const mine = roster.casts.find(
      (c) => c.lastName === lastName && c.state === member.state,
    );
    if (!mine) {
      return { bill, vote, memberVote: 'Did Not Serve' as const, inRoster: false };
    }
    const memberVote = normalizeVoteCast(mine.cast) as VoteForMember['memberVote'];
    return { bill, vote, memberVote, inRoster: true };
  });

  return rows;
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
