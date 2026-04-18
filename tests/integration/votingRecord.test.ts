/**
 * Voting Record Integration Tests (v2.5.2 — KV roll-call rosters, ADR-012)
 *
 * Traces to: FR-5, FR-6, FR-11\u2013FR-17 (REVISED v2.5.2), FR-23, FR-32 AC-32.15.
 *
 * These tests exercise useVotingRecord against mocked
 * /api/roll-call-rosters/{chamber}/{c}/{s}/{rc} responses (not upstream
 * Congress.gov / Senate.gov). The bundled-roster no-op facade is left in
 * place as-is — it returns undefined for every call, so nothing interferes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

import { useVotingRecord } from '../../src/hooks/useVotingRecord';
import { getCuratedVotesForChamber } from '../../src/services/ukraineFilter';
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

/**
 * Build a House roster-route response where the target member's cast is
 * `memberCast` and the rest of the roster contains enough other members
 * to satisfy any party-line downstream logic.
 */
function houseRosterFor(bioguideId: string, memberCast: string) {
  const casts: Record<string, string> = { [bioguideId]: memberCast };
  for (let i = 0; i < 200; i++) casts[`D${i}`] = 'Yea';
  for (let i = 0; i < 200; i++) casts[`R${i}`] = 'Nay';
  return {
    rollCallId: 'house:119:1:1',
    chamber: 'house',
    congress: 119,
    session: 1,
    rollCall: 1,
    casts,
    generatedAt: '2026-04-19T02:00:00Z',
    schemaVersion: 1,
  };
}

/** Build a Senate roster-route response where (lastName, state) = cast. */
function senateRosterFor(lastName: string, state: string, cast: string) {
  return {
    rollCallId: 'senate:119:1:1',
    chamber: 'senate',
    congress: 119,
    session: 1,
    rollCall: 1,
    casts: [
      { lastName, state, cast, firstName: 'X', party: 'D' },
    ],
    generatedAt: '2026-04-19T02:00:00Z',
    schemaVersion: 1,
  };
}

type Route = { match: (u: string) => boolean; body: unknown; status?: number };

function routeFetch(routes: Route[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const route = routes.find((r) => r.match(url));
    if (!route) return new Response(`No mock for ${url}`, { status: 500 });
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('useVotingRecord (v2.5.2 \u2014 KV roll-call rosters)', () => {
  beforeEach(() => vi.restoreAllMocks());

  describe('House path', () => {
    it('returns clusters with one primary per bill+chamber and nests procedurals', async () => {
      routeFetch([
        {
          match: (u) => /\/api\/roll-call-rosters\/house\//.test(u),
          body: houseRosterFor(houseRep.bioguideId, 'Yea'),
        },
      ]);

      const { result } = renderHook(() => useVotingRecord(houseRep, ''));
      await act(async () => { await result.current.load(); });
      await waitFor(() => expect(result.current.status).toBe('success'));

      const { clusters, flat, voteScore } = result.current.data!;
      expect(clusters.length).toBeGreaterThan(0);
      expect(flat.length).toBeGreaterThan(0);
      expect(clusters.length).toBeLessThanOrEqual(flat.length);
      for (const c of clusters) {
        for (const p of c.procedural) {
          expect(p.vote.weight).toBeLessThanOrEqual(c.primary.vote.weight);
        }
      }
      expect(voteScore.score).toBeGreaterThan(0.5);
    });

    it('produces voted-pro valence on normal-direction pro-UA Aye votes', async () => {
      routeFetch([
        {
          match: (u) => /\/api\/roll-call-rosters\/house\//.test(u),
          body: houseRosterFor(houseRep.bioguideId, 'Yea'),
        },
      ]);
      const { result } = renderHook(() => useVotingRecord(houseRep, ''));
      await act(async () => { await result.current.load(); });
      await waitFor(() => expect(result.current.status).toBe('success'));

      const rowsToCheck = result.current.data!.flat.filter(
        (r) => r.bill.direction === 'pro-ukraine' && r.memberVote === 'Aye' &&
               r.vote.directionMultiplier === 1,
      );
      expect(rowsToCheck.length).toBeGreaterThan(0);
      rowsToCheck.forEach((r) => expect(r.valence).toBe('voted-pro'));
    });

    it('FR-23: member absent from every roster \u2192 Did Not Serve \u2192 rows filtered out', async () => {
      routeFetch([
        {
          match: (u) => /\/api\/roll-call-rosters\/house\//.test(u),
          body: {
            rollCallId: 'house:119:1:1',
            chamber: 'house',
            congress: 119,
            session: 1,
            rollCall: 1,
            casts: { OTHER1: 'Yea', OTHER2: 'Nay' },
            generatedAt: '2026-04-19T02:00:00Z',
            schemaVersion: 1,
          },
        },
      ]);
      const { result } = renderHook(() => useVotingRecord(houseRep, ''));
      await act(async () => { await result.current.load(); });
      await waitFor(() => expect(result.current.status).toBe('success'));

      expect(result.current.data!.flat).toHaveLength(0);
      expect(result.current.data!.clusters).toHaveLength(0);
      for (const row of result.current.data!.flat) {
        expect(row.memberVote).not.toBe('Did Not Serve');
      }
    });

    it('FR-23: member in roster with Not Voting \u2192 real abstention, row KEPT', async () => {
      routeFetch([
        {
          match: (u) => /\/api\/roll-call-rosters\/house\//.test(u),
          body: {
            rollCallId: 'house:119:1:1',
            chamber: 'house',
            congress: 119,
            session: 1,
            rollCall: 1,
            casts: {
              [houseRep.bioguideId]: 'Not Voting',
              OTHER1: 'Yea',
            },
            generatedAt: '2026-04-19T02:00:00Z',
            schemaVersion: 1,
          },
        },
      ]);
      const { result } = renderHook(() => useVotingRecord(houseRep, ''));
      await act(async () => { await result.current.load(); });
      await waitFor(() => expect(result.current.status).toBe('success'));

      expect(result.current.data!.flat.length).toBeGreaterThan(0);
      for (const row of result.current.data!.flat) {
        expect(row.memberVote).toBe('Not Voting');
        expect(row.valence).toBe('unstated');
      }
    });

    it('FR-23 AC-23.5: primaryAbstentionCount reports primary-weight abstentions', async () => {
      routeFetch([
        {
          match: (u) => /\/api\/roll-call-rosters\/house\//.test(u),
          body: {
            rollCallId: 'house:119:1:1',
            chamber: 'house',
            congress: 119,
            session: 1,
            rollCall: 1,
            casts: { [houseRep.bioguideId]: 'Not Voting' },
            generatedAt: '2026-04-19T02:00:00Z',
            schemaVersion: 1,
          },
        },
      ]);
      const { result } = renderHook(() => useVotingRecord(houseRep, ''));
      await act(async () => { await result.current.load(); });
      await waitFor(() => expect(result.current.status).toBe('success'));

      const primaryAbstentions = result.current.data!.flat.filter(
        (r) => r.bill.direction === 'pro-ukraine'
            && r.vote.weight >= 0.7
            && r.memberVote === 'Not Voting',
      );
      expect(primaryAbstentions.length).toBeGreaterThan(0);
      expect(result.current.data!.primaryAbstentionCount).toBe(primaryAbstentions.length);
    });

    it('House member Aye on motion-to-recommit = obstruction event', async () => {
      routeFetch([
        {
          match: (u) => /\/api\/roll-call-rosters\/house\//.test(u),
          body: houseRosterFor(houseRep.bioguideId, 'Yea'),
        },
      ]);
      const { result } = renderHook(() => useVotingRecord(houseRep, ''));
      await act(async () => { await result.current.load(); });
      await waitFor(() => expect(result.current.status).toBe('success'));

      const obs = result.current.data!.flat.filter((r) => r.isObstruction);
      for (const row of obs) {
        expect(row.valence).toBe('voted-anti');
      }
      expect(result.current.data!.obstructionCount).toBe(obs.length);
      expect(result.current.data!.obstructionCount).toBeGreaterThan(0);
    });

    it('Dem voting Nay on pro-UA bill produces voted-anti valence (normal-direction rows)', async () => {
      routeFetch([
        {
          match: (u) => /\/api\/roll-call-rosters\/house\//.test(u),
          body: houseRosterFor(houseRep.bioguideId, 'Nay'),
        },
      ]);
      const { result } = renderHook(() => useVotingRecord(houseRep, ''));
      await act(async () => { await result.current.load(); });
      await waitFor(() => expect(result.current.status).toBe('success'));

      const antiRows = result.current.data!.flat.filter(
        (r) => r.bill.direction === 'pro-ukraine' && r.memberVote === 'Nay' &&
               r.vote.directionMultiplier === 1,
      );
      expect(antiRows.length).toBeGreaterThan(0);
      antiRows.forEach((r) => expect(r.valence).toBe('voted-anti'));
      expect(result.current.data!.voteScore.score).toBeLessThan(0);
    });
  });

  describe('Senate path', () => {
    it('matches by last-name + state and normalizes Yea \u2192 Aye', async () => {
      const curated = getCuratedVotesForChamber('Senate');
      expect(curated.length).toBeGreaterThan(0);

      routeFetch([
        {
          match: (u) => /\/api\/roll-call-rosters\/senate\//.test(u),
          body: senateRosterFor('Durbin', 'IL', 'Yea'),
        },
      ]);
      const { result } = renderHook(() => useVotingRecord(senator, ''));
      await act(async () => { await result.current.load(); });
      await waitFor(() => expect(result.current.status).toBe('success'));

      for (const row of result.current.data!.flat) {
        expect(row.memberVote).toBe('Aye');
      }
    });
  });
});
