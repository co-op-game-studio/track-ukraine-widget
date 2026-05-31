/**
 * resolveMemberVotes — pure resolver for "how did this member vote on each
 * curated Ukraine roll-call?" Shared by the public widget's useVotingRecord
 * hook and the admin Bills matrix so the two can never diverge.
 *
 * Member casts live only in KV-backed roll-call rosters (Senate XML has no
 * bioguide, so Senate rosters key on lastName+state; House rosters key on
 * bioguideId). This resolver iterates the curated votes for the member's
 * chamber, fetches each roster (injected `fetchRoster` for testability), and
 * resolves the member's cast, degrading a missing/erroring roster to
 * 'Did Not Serve' without failing the batch.
 *
 * Traces to: FR-32 AC-32.30..32.33, FR-12 (REVISED v2.5.2 — KV rosters),
 * design.md §4.3 (Senate matching).
 */
import {
  getCuratedVotesForChamber,
  type CuratedBill,
  type CuratedBillVote,
} from './ukraineFilter';
import { mapWithConcurrency } from '../utils/limitConcurrency';
import { computeValence, type Valence } from './valence';
import {
  normalizeVoteCast,
  type HouseRollCallRoster,
  type SenateRollCallRoster,
  type RollCallRoster,
} from './rollCallRosters';

/** Same default the widget uses — KV reads are cheap, 8 keeps us under the
 *  per-IP rate limit while parallelizing the ~27 roster fetches. */
const DEFAULT_CONCURRENCY = 8;

export type MemberCast = 'Aye' | 'Nay' | 'Present' | 'Not Voting' | 'Did Not Serve';

/** Minimal member identity the resolver needs — decoupled from `Representative`
 *  so the admin side can build it straight from `/api/members/{id}`. */
export interface MemberIdentity {
  bioguideId: string;
  chamber: 'house' | 'senate';
  /** Senate rosters match on lastName+state; House uses bioguideId. */
  lastName: string;
  /** Two-letter state code (Senate match key). */
  state: string;
}

export interface MemberBillPosition {
  bill: CuratedBill;
  vote: CuratedBillVote;
  direction: CuratedBill['direction'];
  becameLaw: boolean;
  cast: MemberCast;
  weight: number;
  kind: CuratedBillVote['kind'];
  /** Derived from valence: 'for' (voted-pro), 'against' (voted-anti), 'n/a'
   *  (Present / Not Voting / Did Not Serve / directionMultiplier 0). Single
   *  source of truth shared with the widget so admin can't drift. */
  forAgainstUkraine: 'for' | 'against' | 'n/a';
  valence: Valence;
  /** True only when the member was actually present in that roll-call roster
   *  (distinguishes a real abstention from never having served). */
  inRoster: boolean;
}

export interface ResolveDeps {
  /** Injected for tests; production binds the real fetchRollCallRoster to an
   *  apiBase. Returns null when the roster isn't published. */
  fetchRoster: (
    chamber: 'House' | 'Senate',
    congress: number,
    session: number,
    rollCall: number,
  ) => Promise<RollCallRoster | null>;
  maxConcurrency?: number;
}

function actionFromCast(
  cast: MemberCast,
): 'voted-aye' | 'voted-nay' | 'voted-present' | 'not-voted' {
  switch (cast) {
    case 'Aye': return 'voted-aye';
    case 'Nay': return 'voted-nay';
    case 'Present': return 'voted-present';
    default: return 'not-voted';
  }
}

function forAgainstFromValence(valence: Valence): 'for' | 'against' | 'n/a' {
  if (valence === 'voted-pro') return 'for';
  if (valence === 'voted-anti') return 'against';
  return 'n/a';
}

/**
 * Resolve a member's cast on every curated roll-call for their chamber.
 * Never rejects on a single roster failure — that bill degrades to
 * 'Did Not Serve' / inRoster:false.
 */
export async function resolveMemberVotes(
  member: MemberIdentity,
  deps: ResolveDeps,
): Promise<MemberBillPosition[]> {
  // FR-32 AC-32.34 — resolve across BOTH chambers, not just the member's
  // current one. Each curated vote carries its own `chamber`; we look the
  // member up by the chamber-appropriate key (House → bioguideId; Senate →
  // lastName+state). A chamber-switcher (e.g. House→Senate) thus surfaces
  // their prior-chamber votes; a member who never served in a chamber simply
  // resolves to Did Not Serve for that chamber's roll-calls.
  const curated = [...getCuratedVotesForChamber('House'), ...getCuratedVotesForChamber('Senate')];
  const concurrency = deps.maxConcurrency ?? DEFAULT_CONCURRENCY;

  return mapWithConcurrency(curated, concurrency, async ({ bill, vote }) => {
    let cast: MemberCast = 'Did Not Serve';
    let inRoster = false;
    try {
      const roster = await deps.fetchRoster(vote.chamber, vote.congress, vote.session, vote.rollCall);
      if (roster) {
        const raw = lookupCast(roster, member);
        if (raw !== undefined) {
          cast = normalizeVoteCast(raw) as MemberCast;
          inRoster = true;
        }
      }
    } catch {
      // Transient roster failure → leave as Did Not Serve; never fail the batch.
    }

    const valence = computeValence(bill.direction, actionFromCast(cast), vote.directionMultiplier);
    return {
      bill,
      vote,
      direction: bill.direction,
      becameLaw: bill.becameLaw,
      cast,
      weight: vote.weight,
      kind: vote.kind,
      forAgainstUkraine: forAgainstFromValence(valence),
      valence,
      inRoster,
    };
  });
}

/** Chamber-specific roster lookup. House: by bioguideId. Senate: by
 *  (lastName, state) — Senate XML carries no bioguide. */
function lookupCast(roster: RollCallRoster, member: MemberIdentity): string | undefined {
  if (roster.chamber === 'house') {
    return (roster as HouseRollCallRoster).casts[member.bioguideId];
  }
  const mine = (roster as SenateRollCallRoster).casts.find(
    (c) => c.lastName === member.lastName && c.state === member.state,
  );
  return mine?.cast;
}
