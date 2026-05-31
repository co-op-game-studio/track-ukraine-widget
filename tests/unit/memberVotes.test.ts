/**
 * resolveMemberVotes — FR-32 AC-32.30..32.33.
 *
 * Pure resolver shared by the widget (useVotingRecord) and the admin Bills
 * matrix. Tests inject a fake `fetchRoster` (no network) and drive it against
 * the REAL curated bill set, so the assertions track whatever votes the
 * curator has defined for each chamber.
 */
import { describe, it, expect } from 'vitest';
import { resolveMemberVotes, type MemberIdentity } from '../../src/services/memberVotes';
import { getCuratedVotesForChamber } from '../../src/services/ukraineFilter';
import type { RollCallRoster } from '../../src/services/rollCallRosters';

const houseCurated = getCuratedVotesForChamber('House');
const senateCurated = getCuratedVotesForChamber('Senate');

const HOUSE_MEMBER: MemberIdentity = { bioguideId: 'H000001', chamber: 'house', lastName: 'Smith', state: 'CA' };
const SENATE_MEMBER: MemberIdentity = { bioguideId: 'S000001', chamber: 'senate', lastName: 'Durbin', state: 'IL' };

const ROSTER_META = { rollCallId: 'x', congress: 0, session: 0, rollCall: 0, generatedAt: '2026-01-01T00:00:00Z', schemaVersion: 1 } as const;

/** A fake fetchRoster that returns a House roster casting `cast` for our member
 *  on every roll-call. */
function houseRoster(casts: Record<string, string>): RollCallRoster {
  return { chamber: 'house', ...ROSTER_META, casts } as RollCallRoster;
}
function houseRosterReturning(cast: string): RollCallRoster {
  return houseRoster({ [HOUSE_MEMBER.bioguideId]: cast });
}
function senateRosterReturning(cast: string): RollCallRoster {
  return {
    chamber: 'senate', ...ROSTER_META,
    casts: [{ lastName: SENATE_MEMBER.lastName, state: SENATE_MEMBER.state, cast }],
  } as RollCallRoster;
}

const totalCurated = houseCurated.length + senateCurated.length;

describe('resolveMemberVotes (FR-32 AC-32.30..32.35)', () => {
  it('AC-32.30/34 — returns one row per curated roll-call across BOTH chambers', async () => {
    // House member: matched in House rosters; Senate rolls resolve Did Not Serve.
    const rows = await resolveMemberVotes(HOUSE_MEMBER, {
      fetchRoster: async (chamber) => (chamber === 'House' ? houseRosterReturning('Yea') : senateRosterReturning('Nay')),
    });
    expect(rows.length).toBe(totalCurated);
    // House rolls → Aye (matched by bioguide); Senate rolls → our member's
    // lastName/state isn't in the senate fake (SENATE_MEMBER), so Did Not Serve.
    const houseRows = rows.filter((r) => r.vote.chamber === 'House');
    expect(houseRows.length).toBe(houseCurated.length);
    expect(houseRows.every((r) => r.cast === 'Aye' && r.inRoster)).toBe(true);
  });

  it('AC-32.35 — a chamber-switcher surfaces BOTH chambers’ votes', async () => {
    // Member present in House rosters (by bioguide) AND Senate rosters (by name+state).
    const SWITCHER: MemberIdentity = { bioguideId: 'S001150', chamber: 'senate', lastName: 'Schiff', state: 'CA' };
    const rows = await resolveMemberVotes(SWITCHER, {
      fetchRoster: async (chamber) =>
        chamber === 'House'
          ? houseRoster({ S001150: 'Yea' })
          : ({ chamber: 'senate', ...ROSTER_META, casts: [{ lastName: 'Schiff', state: 'CA', cast: 'Yea' }] } as RollCallRoster),
    });
    const inRoster = rows.filter((r) => r.inRoster);
    // Both chambers matched (assuming the curated set has both House and Senate votes).
    if (houseCurated.length > 0) expect(inRoster.some((r) => r.vote.chamber === 'House')).toBe(true);
    if (senateCurated.length > 0) expect(inRoster.some((r) => r.vote.chamber === 'Senate')).toBe(true);
    expect(inRoster.length).toBe(totalCurated);
  });

  it('AC-32.32 — Aye on a pro-ukraine bill is "for"; Nay is "against"', async () => {
    const proVote = houseCurated.find((c) => c.bill.direction === 'pro-ukraine' && c.vote.directionMultiplier === 1);
    if (!proVote) return; // no pro-UA House vote in the curated set — skip assertion
    const aye = await resolveMemberVotes(HOUSE_MEMBER, { fetchRoster: async () => houseRosterReturning('Yea') });
    const ayeRow = aye.find((r) => r.bill === proVote.bill && r.vote === proVote.vote)!;
    expect(ayeRow.forAgainstUkraine).toBe('for');
    expect(ayeRow.valence).toBe('voted-pro');

    const nay = await resolveMemberVotes(HOUSE_MEMBER, { fetchRoster: async () => houseRosterReturning('Nay') });
    const nayRow = nay.find((r) => r.bill === proVote.bill && r.vote === proVote.vote)!;
    expect(nayRow.forAgainstUkraine).toBe('against');
  });

  it('AC-32.32 — directionMultiplier -1 inverts (Aye becomes against)', async () => {
    const flipVote = houseCurated.find((c) => c.vote.directionMultiplier === -1);
    if (!flipVote) return;
    const aye = await resolveMemberVotes(HOUSE_MEMBER, { fetchRoster: async () => houseRosterReturning('Yea') });
    const row = aye.find((r) => r.bill === flipVote.bill && r.vote === flipVote.vote)!;
    expect(row.forAgainstUkraine).toBe('against');
  });

  it('AC-32.33 — absent from roster → Did Not Serve, inRoster false', async () => {
    const rows = await resolveMemberVotes(HOUSE_MEMBER, {
      // Roster exists but does not contain our member.
      fetchRoster: async () => houseRoster({ OTHER: 'Yea' }),
    });
    expect(rows.every((r) => r.cast === 'Did Not Serve' && !r.inRoster)).toBe(true);
    expect(rows.every((r) => r.forAgainstUkraine === 'n/a')).toBe(true);
  });

  it('AC-32.33 — a thrown roster fetch degrades that row, never rejects', async () => {
    let calls = 0;
    const rows = await resolveMemberVotes(HOUSE_MEMBER, {
      fetchRoster: async () => {
        calls++;
        if (calls === 1) throw new Error('boom');
        return houseRosterReturning('Yea');
      },
      maxConcurrency: 1, // deterministic ordering so the first call is the throw
    });
    // First row degraded; the rest resolved (assuming >1 curated House vote).
    expect(rows[0]!.cast).toBe('Did Not Serve');
    expect(rows[0]!.inRoster).toBe(false);
  });

  it('AC-32.31 — Senate members match by lastName+state', async () => {
    if (senateCurated.length === 0) return;
    // Senate-shaped roster for every roll-call; our SENATE_MEMBER matches by
    // lastName+state. House rolls (now also fetched per AC-32.34) are looked up
    // against a senate-shaped roster too here, which still matches on name+state.
    const rows = await resolveMemberVotes(SENATE_MEMBER, {
      fetchRoster: async () => senateRosterReturning('Yea'),
    });
    expect(rows.length).toBe(totalCurated);
    const senateRows = rows.filter((r) => r.vote.chamber === 'Senate');
    expect(senateRows.every((r) => r.cast === 'Aye' && r.inRoster)).toBe(true);
  });

  it('treats Present and Not Voting as n/a', async () => {
    const present = await resolveMemberVotes(HOUSE_MEMBER, { fetchRoster: async () => houseRosterReturning('Present') });
    expect(present.every((r) => r.forAgainstUkraine === 'n/a')).toBe(true);
    const notVoting = await resolveMemberVotes(HOUSE_MEMBER, { fetchRoster: async () => houseRosterReturning('Not Voting') });
    expect(notVoting.every((r) => r.forAgainstUkraine === 'n/a')).toBe(true);
  });
});
