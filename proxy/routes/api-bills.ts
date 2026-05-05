/**
 * /api/bills/{billId} — KV-backed curator bill record.
 *
 * AC-52.51 — read-through cache: KV → D1 fallthrough. On KV miss, the
 * Worker queries D1, projects via `kv-projector`, writes back to KV,
 * returns the projection. Cold-D1 → 404 per AC-52.48.
 *
 * Traces: FR-32 AC-32.2, FR-42, AC-52.46, AC-52.51, AC-52.48.
 */
import type { ProxyEnv } from '../env';
import type { DispatchResult } from './common';
import { jsonResponse } from './common';
import { corsHeaders } from '../security/origin-allowlist';
import { readBillThroughD1 } from '../services/read-through-cache';
import { logEvent } from '../observability/log';

export async function handleBill(
  billId: string,
  request: Request,
  env: ProxyEnv,
  origin: string,
  traceId?: string,
): Promise<DispatchResult> {
  // Accept both pre-V4 ("HR2471") and V4 ("117-HR-2471") bill-id shapes.
  if (!/^[A-Z]+\d+$|^\d+-[A-Z]+-\d+$/i.test(billId)) {
    return {
      response: jsonResponse(400, { error: 'invalid_bill_id' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }
  const ctx = {
    env: env.ENV_NAME ?? 'unknown',
    traceId: traceId ?? '',
    d1: env.D1_VOTER_INFO!,
    kv: env.KV_VOTER_INFO,
  };
  let record: string | null = null;
  if (env.D1_VOTER_INFO) {
    record = await readBillThroughD1(ctx, billId);
  } else {
    // No D1 (legacy env) — KV-only.
    record = (await env.KV_VOTER_INFO.get(`bill:v1:${billId}`, 'text')) as string | null;
  }
  if (!record) {
    // AC-52.48 — cold-D1 trace so ops can grep for "researcher hasn't
    // imported this bill yet" patterns.
    logEvent(
      { env: ctx.env, traceId: ctx.traceId },
      {
        event: 'embed_read_cold',
        level: 'warn',
        routeClass: 'bills',
        billId,
      },
    );
    return {
      response: jsonResponse(404, { error: 'bill_not_found', billId }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }
  const headers = new Headers(corsHeaders(origin));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'public, max-age=60, s-maxage=300');
  return {
    response: new Response(request.method === 'HEAD' ? null : record, {
      status: 200,
      headers,
    }),
    shape: 'api-proxied',
  };
}
