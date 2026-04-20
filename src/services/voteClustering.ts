/**
 * Vote Clustering — groups curated votes by (bill, chamber) and picks a primary
 * vote per group; other votes become "procedural" children that collapse by
 * default in the UI.
 *
 * See docs/design.md §4.8. Traces to: FR-17.
 */
import type { CuratedBill, CuratedBillVote } from './ukraineFilter';

export interface ClusteredVote {
  /** The highest-weight vote in the cluster — the one users see by default. */
  primary: CuratedBillVote;
  /** All other votes on the same bill + chamber (cloture, motions, etc.). */
  procedural: CuratedBillVote[];
  bill: CuratedBill;
}

export interface VoteForMember {
  bill: CuratedBill;
  vote: CuratedBillVote;
  memberVote: 'Aye' | 'Nay' | 'Present' | 'Not Voting';
}

export interface ClusteredMemberVote {
  primary: VoteForMember;
  procedural: VoteForMember[];
}

/**
 * Group a list of (bill, vote, memberVote) triples by (bill.congress|number, vote.chamber).
 * In each group, the highest-weight vote becomes `primary`; the rest are `procedural`.
 * Ties broken by latest date.
 */
export function clusterMemberVotes(
  input: VoteForMember[],
): ClusteredMemberVote[] {
  const groups = new Map<string, VoteForMember[]>();
  for (const row of input) {
    const key = `${row.bill.congress}|${row.bill.type}|${row.bill.number}|${row.vote.chamber}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const clusters: ClusteredMemberVote[] = [];
  for (const rows of groups.values()) {
    if (rows.length === 0) continue;

    // Primary selection:
    //   1. If the bill became law and a `concur` vote exists (conference
    //      report), prefer it — that is the authoritative final vote.
    //   2. Otherwise fall back to highest weight, tiebroken by latest date.
    const billBecameLaw = rows[0]!.bill.becameLaw;
    const concur = billBecameLaw
      ? rows
          .filter((r) => r.vote.kind === 'concur')
          .sort((a, b) => b.vote.date.localeCompare(a.vote.date))[0]
      : undefined;

    // Sort desc by weight, then by date
    const sorted = rows.slice().sort((a, b) => {
      const wDiff = b.vote.weight - a.vote.weight;
      if (wDiff !== 0) return wDiff;
      return b.vote.date.localeCompare(a.vote.date);
    });

    const primary = concur ?? sorted[0]!;
    const procedural = sorted.filter((r) => r !== primary);
    clusters.push({ primary, procedural });
  }

  // Order clusters: featured bills first, then newest primary vote first
  clusters.sort((a, b) => {
    if (a.primary.bill.featured !== b.primary.bill.featured) {
      return a.primary.bill.featured ? -1 : 1;
    }
    return b.primary.vote.date.localeCompare(a.primary.vote.date);
  });

  return clusters;
}
