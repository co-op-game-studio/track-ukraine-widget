/**
 * /api/state-members/{stateCode} — curator-written per-state member list.
 *
 * Owns its implementation as of Phase 12 T-075 (2026-04-19).
 *
 * Traces: FR-32 AC-32.16. FR-42.
 */
import type { ProxyEnv } from '../env';
import type { DispatchResult } from './common';
import { jsonResponse } from './common';
import { corsHeaders } from '../security/origin-allowlist';
import { KV_PREFIXES } from '../kv/prefixes';

export async function handleStateMembers(
  rawCode: string,
  request: Request,
  env: ProxyEnv,
  origin: string,
): Promise<DispatchResult> {
  if (!/^[A-Za-z]{2}$/.test(rawCode)) {
    return {
      response: jsonResponse(400, { error: 'invalid_state_code' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }
  const stateCode = rawCode.toUpperCase();
  const record = await env.KV_VOTER_INFO.get(
    `${KV_PREFIXES.stateMembers}${stateCode}`,
    'text',
  );
  if (!record) {
    return {
      response: jsonResponse(404, { error: 'state_members_not_found' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }
  const headers = new Headers(corsHeaders(origin));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=3600');
  return {
    response: new Response(request.method === 'HEAD' ? null : (record as string), {
      status: 200,
      headers,
    }),
    shape: 'api-proxied',
  };
}
