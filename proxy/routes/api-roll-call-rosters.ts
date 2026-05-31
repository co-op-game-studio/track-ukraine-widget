/**
 * /api/roll-call-rosters/{chamber}/{congress}/{session}/{rollCall} —
 * curator-written member-roster records. Immutable after session close.
 *
 * Owns its implementation as of Phase 12 T-075 (2026-04-19).
 *
 * Traces: FR-32 AC-32.15. FR-12 v2.5.2. FR-42.
 */
import type { ProxyEnv, D1Like } from '../env';
import type { DispatchResult } from './common';
import { jsonResponse } from './common';
import { corsHeaders } from '../security/origin-allowlist';
import { KV_PREFIXES } from '../kv/prefixes';

interface CastRow {
  bioguide_id: string | null;
  last_name: string | null;
  first_name: string | null;
  state: string | null;
  party: string | null;
  cast: string;
}

/**
 * Assemble a roll-call roster record from durable D1 `vote_casts` rows.
 * Returns null when no casts exist for the roll-call. House → `casts` keyed by
 * bioguideId; Senate → `casts` array (lastName/state/cast), matching the shape
 * the widget already consumes (AC-32.37).
 */
async function assembleRosterFromD1(
  d1: D1Like,
  chamber: 'house' | 'senate',
  congress: number,
  session: number,
  rollCall: number,
): Promise<Record<string, unknown> | null> {
  const chamberLabel = chamber === 'senate' ? 'Senate' : 'House';
  const res = await d1
    .prepare(
      'SELECT bioguide_id, last_name, first_name, state, party, cast FROM vote_casts WHERE chamber = ? AND congress = ? AND session = ? AND roll_call = ?',
    )
    .bind(chamberLabel, congress, session, rollCall)
    .all<CastRow>();
  const rows = res.results ?? [];
  if (rows.length === 0) return null;

  const base = {
    rollCallId: `${chamber}:${congress}:${session}:${rollCall}`,
    chamber,
    congress,
    session,
    rollCall,
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
  };
  if (chamber === 'house') {
    const casts: Record<string, string> = {};
    for (const r of rows) if (r.bioguide_id) casts[r.bioguide_id] = r.cast;
    return { ...base, casts };
  }
  const casts = rows
    .filter((r) => r.last_name && r.state)
    .map((r) => ({
      lastName: r.last_name as string,
      state: r.state as string,
      cast: r.cast,
      ...(r.first_name ? { firstName: r.first_name } : {}),
      ...(r.party ? { party: r.party } : {}),
    }));
  return { ...base, casts };
}

export async function handleRollCallRoster(
  key: string,
  request: Request,
  env: ProxyEnv,
  origin: string,
): Promise<DispatchResult> {
  const parts = key.split('/');
  if (parts.length !== 4) {
    return {
      response: jsonResponse(400, { error: 'invalid_roll_call_key' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }
  const [chamber, congress, session, rollCall] = parts as [string, string, string, string];
  if (
    !/^(house|senate)$/i.test(chamber) ||
    !/^\d+$/.test(congress) ||
    !/^\d+$/.test(session) ||
    !/^\d+$/.test(rollCall)
  ) {
    return {
      response: jsonResponse(400, { error: 'invalid_roll_call_key' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }
  const kvKey = `${KV_PREFIXES.rollCallRoster}${chamber.toLowerCase()}:${congress}:${session}:${rollCall}`;
  let record = await env.KV_VOTER_INFO.get(kvKey, 'text');

  // FR-32 AC-32.41 — KV is a cache; on a miss, assemble the roster from the
  // durable D1 `vote_casts` table and write it through to KV (self-healing).
  if (!record && env.D1_VOTER_INFO) {
    const assembled = await assembleRosterFromD1(
      env.D1_VOTER_INFO,
      chamber.toLowerCase() as 'house' | 'senate',
      Number(congress),
      Number(session),
      Number(rollCall),
    );
    if (assembled) {
      const assembledJson = JSON.stringify(assembled);
      record = assembledJson;
      // Write-through cache. Best-effort — a KV write failure still serves.
      try { await env.KV_VOTER_INFO.put(kvKey, assembledJson); } catch { /* serve anyway */ }
    }
  }

  if (!record) {
    return {
      response: jsonResponse(404, { error: 'roll_call_roster_not_found' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }
  const headers = new Headers(corsHeaders(origin));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  // AC-32.15: historical roll-call rosters never change; mark immutable.
  headers.set('Cache-Control', 'public, max-age=86400, s-maxage=31536000, immutable');
  return {
    response: new Response(request.method === 'HEAD' ? null : (record as string), {
      status: 200,
      headers,
    }),
    shape: 'api-proxied',
  };
}
