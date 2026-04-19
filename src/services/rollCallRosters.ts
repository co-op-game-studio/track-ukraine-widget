/**
 * Roll-call roster service — reads curator-authored per-roll-call rosters
 * from the Worker's KV-backed /api/roll-call-rosters/{chamber}/{c}/{s}/{rc}
 * route. Pure async I/O; no React.
 *
 * Traces to: FR-12 (REVISED v2.5.2), FR-32 AC-32.15, ADR-012, design.md §3.2.4.
 */

import { throwFromResponse } from './errorEnvelope';

export interface HouseRollCallRoster {
  rollCallId: string;
  chamber: 'house';
  congress: number;
  session: number;
  rollCall: number;
  /** bioguideId → raw upstream cast ("Yea" | "Nay" | "Present" | "Not Voting"). */
  casts: Record<string, string>;
  generatedAt: string;
  schemaVersion: 1;
}

export interface SenateRollCallCast {
  lastName: string;
  state: string;
  cast: string;
  firstName?: string;
  party?: string;
}

export interface SenateRollCallRoster {
  rollCallId: string;
  chamber: 'senate';
  congress: number;
  session: number;
  rollCall: number;
  /** Array keyed by (lastName, state) — Senate XML carries no bioguide IDs. */
  casts: SenateRollCallCast[];
  generatedAt: string;
  schemaVersion: 1;
}

export type RollCallRoster = HouseRollCallRoster | SenateRollCallRoster;

/** Normalize upstream cast terminology to the domain's Aye/Nay convention.
 *  Both House ("Yea"/"Nay") and Senate ("Yea"/"Nay") rosters share this
 *  mapping. "Aye" is accepted as a pass-through for callers that already
 *  hold a normalized value. */
export function normalizeVoteCast(
  raw: string,
): 'Aye' | 'Nay' | 'Present' | 'Not Voting' {
  switch (raw) {
    case 'Yea':
    case 'Aye':
      return 'Aye';
    case 'Nay':
      return 'Nay';
    case 'Present':
      return 'Present';
    default:
      return 'Not Voting';
  }
}

/**
 * Fetch a single roll-call roster.
 *
 * Returns `null` on a 404 (curator has not written a roster for this
 * roll-call — caller SHALL treat the member's cast as "Did Not Vote"). A
 * non-404 upstream error is re-thrown so callers can distinguish transient
 * problems from missing-by-design records.
 */
export async function fetchRollCallRoster(
  chamber: 'House' | 'Senate',
  congress: number,
  session: number,
  rollCall: number,
  apiBase: string,
): Promise<RollCallRoster | null> {
  const base = apiBase.replace(/\/+$/, '');
  const chamberPath = chamber === 'House' ? 'house' : 'senate';
  const url = `${base}/api/roll-call-rosters/${chamberPath}/${congress}/${session}/${rollCall}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    await throwFromResponse(res, `roll-call roster ${chamberPath}/${congress}/${session}/${rollCall}`);
  }
  return (await res.json()) as RollCallRoster;
}
