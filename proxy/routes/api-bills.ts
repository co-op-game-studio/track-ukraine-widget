/**
 * /api/bills/{billId} — KV-backed curator bill record.
 *
 * Owns its implementation as of Phase 12 T-075 (2026-04-19).
 *
 * Traces: FR-32 AC-32.2. FR-42.
 */
import type { ProxyEnv } from '../env';
import type { DispatchResult } from './common';
import { jsonResponse } from './common';
import { corsHeaders } from '../security/origin-allowlist';
import { KV_PREFIXES } from '../kv/prefixes';

export async function handleBill(
  billId: string,
  request: Request,
  env: ProxyEnv,
  origin: string,
): Promise<DispatchResult> {
  if (!/^[A-Z]+\d+$/i.test(billId)) {
    return {
      response: jsonResponse(400, { error: 'invalid_bill_id' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }
  const record = await env.KV_VOTER_INFO.get(KV_PREFIXES.bill + billId, 'text');
  if (!record) {
    return {
      response: jsonResponse(404, { error: 'bill_not_found', billId }, corsHeaders(origin)),
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
