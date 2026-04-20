/**
 * State-members service — reads curator-authored per-state member rosters
 * from the Worker's KV-backed /api/state-members/{stateCode} route.
 * Pure async I/O; no React.
 *
 * Traces to: FR-1, FR-2, FR-32 AC-32.16, ADR-012, design.md §4.14.
 */

import { throwFromResponse } from './errorEnvelope';

export interface StateMemberSummary {
  bioguideId: string;
  first: string;
  last: string;
  officialName: string;
  state: string;
  district: number | null;
  chamber: 'Senate' | 'House';
  party: string;
  photoUrl: string | null;
  website: string | null;
  isNonVoting?: boolean;
  /** Year member first entered office. Optional — older KV records
   *  predate this field. */
  yearEntered?: number;
}

export interface StateMembersRecord {
  stateCode: string;
  senators: StateMemberSummary[];
  house: StateMemberSummary[];
  generatedAt: string;
  schemaVersion: 1;
}

/**
 * Fetch the state-members record for a given two-letter state code.
 * Returns `null` on 404 (curator has not written this state).
 * Throws on transient upstream errors so the caller can surface a
 * user-actionable error.
 */
export async function fetchStateMembers(
  stateCode: string,
  apiBase: string,
): Promise<StateMembersRecord | null> {
  const base = apiBase.replace(/\/+$/, '');
  const url = `${base}/api/state-members/${encodeURIComponent(stateCode.toUpperCase())}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    await throwFromResponse(res, `state-members ${stateCode}`);
  }
  return (await res.json()) as StateMembersRecord;
}
