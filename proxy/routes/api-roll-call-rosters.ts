/**
 * /api/roll-call-rosters/{chamber}/{congress}/{session}/{rollCall} —
 * curator-written member-roster records. Immutable after session close.
 *
 * Owns its implementation as of Phase 12 T-075 (2026-04-19).
 *
 * Traces: FR-32 AC-32.15. FR-12 v2.5.2. FR-42.
 */
import type { ProxyEnv } from '../env';
import type { DispatchResult } from './common';
import { jsonResponse } from './common';
import { corsHeaders } from '../security/origin-allowlist';
import { KV_PREFIXES } from '../kv/prefixes';

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
  const record = await env.KV_VOTER_INFO.get(
    `${KV_PREFIXES.rollCallRoster}${chamber.toLowerCase()}:${congress}:${session}:${rollCall}`,
    'text',
  );
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
