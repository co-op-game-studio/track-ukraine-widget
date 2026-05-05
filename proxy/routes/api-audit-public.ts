/**
 * /api/audit/public — public, redacted audit feed for the embed's
 * "Recent researcher updates" panel (AC-53.4).
 *
 * Reads from KV `audit-feed:v1:public` (written by FR-51 publish pipeline).
 * Email domain is stripped at publish time so this route just returns the
 * pre-redacted record verbatim.
 *
 * Traces: FR-58 AC-58.2, AC-58.4, FR-53 AC-53.4.
 */
import type { ProxyEnv } from '../env';
import type { DispatchResult } from './common';
import { jsonResponse } from './common';
import { corsHeaders } from '../security/origin-allowlist';
import { KV_PREFIXES } from '../kv/prefixes';

export async function handleAuditPublic(
  request: Request,
  env: ProxyEnv,
  origin: string,
): Promise<DispatchResult> {
  const record = await env.KV_VOTER_INFO.get(KV_PREFIXES.auditFeed + 'public', 'text');
  if (!record) {
    return {
      response: jsonResponse(404, { error: 'audit_feed_not_found' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }
  const headers = new Headers(corsHeaders(origin));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'public, max-age=60, s-maxage=120');
  return {
    response: new Response(request.method === 'HEAD' ? null : (record as string), {
      status: 200,
      headers,
    }),
    shape: 'api-proxied',
  };
}
