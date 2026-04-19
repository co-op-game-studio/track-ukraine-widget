/**
 * useVotingRecord ↔ rollCallRosters ↔ valence ↔ ukraineScore integration.
 *
 * Catches the class of bug where each service passes its own unit suite but
 * the roster-shape → valence-key handoff is broken — e.g., a House roster
 * keyed by bioguide but a valence lookup that expected last-name + state, or
 * a "Yea" that never got normalized to "Aye" before hitting the valence
 * table.
 *
 * Traces: FR-44 AC-44.16 (T-092), FR-12, FR-16, FR-43 AC-43.1.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

import { useVotingRecord } from '../../src/hooks/useVotingRecord';
import {
  getCuratedVotesForChamber,
  type CuratedVoteWithBill,
} from '../../src/services/ukraineFilter';
import type { Representative } from '../../src/types/domain';

const houseRep: Representative = {
  bioguideId: 'B001315',
  name: 'Budzinski, Nikki',
  party: 'Democratic',
  partyAbbreviation: 'D',
  state: 'IL',
  district: 13,
  chamber: 'house',
  photoUrl: null,
  isNonVoting: false,
};

const senator: Representative = {
  bioguideId: 'D000563',
  name: 'Durbin, Richard J.',
  party: 'Democratic',
  partyAbbreviation: 'D',
  state: 'IL',
  district: null,
  chamber: 'senate',
  photoUrl: null,
  isNonVoting: false,
};

const ROSTER_META = {
  rollCallId: 'x',
  congress: 0,
  session: 0,
  rollCall: 0,
  generatedAt: '2026-04-19T00:00:00Z',
  schemaVersion: 1 as const,
};

function houseRoster(bioguideId: string, cast: string) {
  return { ...ROSTER_META, chamber: 'house' as const, casts: { [bioguideId]: cast } };
}

function senateRoster(lastName: string, state: string, cast: string) {
  return {
    ...ROSTER_META,
    chamber: 'senate' as const,
    casts: [{ lastName, state, cast, party: 'D' }],
  };
}

type Route = {
  match: (url: string) => boolean;
  body?: unknown;
  status?: number;
};

function routeFetch(routes: Route[]): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const route = routes.find((r) => r.match(url));
    if (!route) return new Response(`unmatched ${url}`, { status: 500 });
    if (route.status !== undefined && route.status !== 200) {
      return new Response('', { status: route.status });
    }
    return new Response(JSON.stringify(route.body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

/** Pick the first curated House pro-UA scoring vote (weight > 0, dm === 1). */
function firstScoringProHouseVote(): CuratedVoteWithBill {
  const cand = getCuratedVotesForChamber('House').find(
    (c) =>
      c.bill.direction === 'pro-ukraine' &&
      c.vote.weight > 0 &&
      c.vote.directionMultiplier === 1,
  );
  if (!cand) throw new Error('no scoring pro-UA House vote in curated set');
  return cand;
}

describe('useVotingRecord ↔ roster ↔ valence ↔ score (FR-44 AC-44.16)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('House Aye on pro-UA bill → voted-pro row + score contribution', async () => {
    routeFetch([
      {
        match: (u) => /\/api\/roll-call-rosters\/house\//.test(u),
        body: houseRoster(houseRep.bioguideId, 'Aye'),
      },
    ]);
    const { result } = renderHook(() => useVotingRecord(houseRep, ''));
    await act(async () => { await result.current.load(); });
    await waitFor(() => expect(result.current.status).toBe('success'));

    const target = firstScoringProHouseVote();
    const row = result.current.data!.flat.find(
      (r) =>
        r.bill.congress === target.bill.congress &&
        r.bill.number === target.bill.number &&
        r.vote.rollCall === target.vote.rollCall,
    );
    expect(row).toBeDefined();
    expect(row!.memberVote).toBe('Aye');
    expect(row!.valence).toBe('voted-pro');
    expect(result.current.data!.voteScore.contributing).toBeGreaterThan(0);
    expect(result.current.data!.voteScore.score).toBeGreaterThan(0);
  });

  it('Senate Yea is normalized to Aye → voted-pro on pro-UA bill', async () => {
    routeFetch([
      {
        match: (u) => /\/api\/roll-call-rosters\/senate\//.test(u),
        body: senateRoster('Durbin', 'IL', 'Yea'),
      },
    ]);
    const { result } = renderHook(() => useVotingRecord(senator, ''));
    await act(async () => { await result.current.load(); });
    await waitFor(() => expect(result.current.status).toBe('success'));

    const rows = result.current.data!.flat;
    expect(rows.length).toBeGreaterThan(0);
    // Chamber-unified Aye/Nay vocab: Senate "Yea" must have been normalized.
    for (const r of rows) {
      expect(r.memberVote).toBe('Aye');
    }
    const proRows = rows.filter(
      (r) => r.bill.direction === 'pro-ukraine' && r.vote.directionMultiplier === 1,
    );
    expect(proRows.length).toBeGreaterThan(0);
    for (const r of proRows) {
      expect(r.valence).toBe('voted-pro');
    }
  });

  it('House Nay on pro-UA bill → voted-anti + negative score contribution', async () => {
    routeFetch([
      {
        match: (u) => /\/api\/roll-call-rosters\/house\//.test(u),
        body: houseRoster(houseRep.bioguideId, 'Nay'),
      },
    ]);
    const { result } = renderHook(() => useVotingRecord(houseRep, ''));
    await act(async () => { await result.current.load(); });
    await waitFor(() => expect(result.current.status).toBe('success'));

    const antiRows = result.current.data!.flat.filter(
      (r) => r.bill.direction === 'pro-ukraine' && r.vote.directionMultiplier === 1,
    );
    expect(antiRows.length).toBeGreaterThan(0);
    for (const r of antiRows) {
      expect(r.memberVote).toBe('Nay');
      expect(r.valence).toBe('voted-anti');
    }
    expect(result.current.data!.voteScore.score).toBeLessThan(0);
  });

  it('Member absent from roster → row filtered (Did Not Serve) and not in contributing count', async () => {
    routeFetch([
      {
        match: (u) => /\/api\/roll-call-rosters\/house\//.test(u),
        // Roster exists but target bioguide is not among the casts.
        body: houseRoster('OTHER_MEMBER', 'Aye'),
      },
    ]);
    const { result } = renderHook(() => useVotingRecord(houseRep, ''));
    await act(async () => { await result.current.load(); });
    await waitFor(() => expect(result.current.status).toBe('success'));

    // Confirmed from useVotingRecord: member absent → 'Did Not Serve' →
    // filtered out before scoring. The flat list ends up empty, and no
    // row is credited to `contributing`.
    expect(result.current.data!.flat).toHaveLength(0);
    expect(result.current.data!.voteScore.contributing).toBe(0);
    expect(result.current.data!.voteScore.score).toBeNull();
  });

  it('Score aggregates across 2 scoring rolls → low-confidence tier (FR-43 AC-43.1)', async () => {
    // Only two specific House pro-UA scoring rolls return a roster; all
    // others 404. That lets us pin `contributing` to exactly 2, which is
    // below LOW_CONFIDENCE_THRESHOLD (3) → confidenceTier === 'low'.
    const all = getCuratedVotesForChamber('House').filter(
      (c) =>
        c.bill.direction === 'pro-ukraine' &&
        c.vote.weight > 0 &&
        c.vote.directionMultiplier === 1,
    );
    expect(all.length).toBeGreaterThanOrEqual(2);
    const [first, second] = [all[0]!, all[1]!];

    const liveUrls = new Set(
      [first.vote, second.vote].map(
        (v) =>
          `/api/roll-call-rosters/house/${v.congress}/${v.session}/${v.rollCall}`,
      ),
    );

    routeFetch([
      {
        match: (u) => Array.from(liveUrls).some((tail) => u.endsWith(tail)),
        body: houseRoster(houseRep.bioguideId, 'Aye'),
      },
      {
        match: (u) => /\/api\/roll-call-rosters\/house\//.test(u),
        status: 404,
      },
    ]);

    const { result } = renderHook(() => useVotingRecord(houseRep, ''));
    await act(async () => { await result.current.load(); });
    await waitFor(() => expect(result.current.status).toBe('success'));

    const score = result.current.data!.voteScore;
    expect(score.contributing).toBe(2);
    // Two Aye votes on pro-UA bills with weight > 0 → score === +1.
    expect(score.score).toBeCloseTo(1, 10);
    expect(score.confidenceTier).toBe('low');
    expect(score.lowConfidence).toBe(true);
  });
});
