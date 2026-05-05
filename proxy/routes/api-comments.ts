/**
 * /api/comments/{billId} — embed-facing read of researcher comments
 * attached to a bill (consumed by VoteList row expand, AC-53.1).
 *
 * AC-52.51 — KV → D1 read-through. AC-52.48 — cold-D1 → 404 with trace.
 *
 * Traces: FR-51 AC-51.4, FR-53 AC-53.1, AC-53.5, AC-52.46, AC-52.48, AC-52.51.
 */
import type { ProxyEnv } from '../env';
import type { DispatchResult } from './common';
import { jsonResponse } from './common';
import { corsHeaders } from '../security/origin-allowlist';
import { readCommentsThroughD1 } from '../services/read-through-cache';
import { logEvent } from '../observability/log';

export async function handleComments(
  billId: string,
  request: Request,
  env: ProxyEnv,
  origin: string,
  traceId?: string,
): Promise<DispatchResult> {
  if (!/^[\w-]+$/.test(billId)) {
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
    record = await readCommentsThroughD1(ctx, billId);
  } else {
    record = (await env.KV_VOTER_INFO.get(`comment:v1:${billId}`, 'text')) as string | null;
  }
  if (!record) {
    logEvent(
      { env: ctx.env, traceId: ctx.traceId },
      {
        event: 'embed_read_cold',
        level: 'warn',
        routeClass: 'comments',
        billId,
      },
    );
    return {
      response: jsonResponse(404, { error: 'comments_not_found', billId }, corsHeaders(origin)),
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
