/**
 * /api/roll-calls/{chamber}/{congress}/{session}/{rollCall} — KV-backed
 * curator roll-call metadata (NOT the full member roster — that's
 * /api/roll-call-rosters).
 *
 * Owns its implementation as of Phase 12 T-075 (2026-04-19).
 *
 * Traces: FR-32 AC-32.3. FR-42.
 */
import type { ProxyEnv } from '../env';
import type { DispatchResult } from './common';
import { jsonResponse } from './common';
import { corsHeaders } from '../security/origin-allowlist';
import { KV_PREFIXES } from '../kv/prefixes';

export async function handleRollCall(
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
    `${KV_PREFIXES.rollCall}${chamber.toLowerCase()}:${congress}:${session}:${rollCall}`,
    'text',
  );
  if (!record) {
    return {
      response: jsonResponse(404, { error: 'roll_call_not_found' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }
  const headers = new Headers(corsHeaders(origin));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'public, max-age=60, s-maxage=300');
  return {
    response: new Response(request.method === 'HEAD' ? null : (record as string), {
      status: 200,
      headers,
    }),
    shape: 'api-proxied',
  };
}
