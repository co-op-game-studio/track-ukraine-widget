/**
 * /api/quotes/{bioguideId} — embed-facing read of researcher-curated quotes
 * for a representative (consumed by Quotes tab, AC-53.2).
 *
 * AC-52.51 — KV → D1 read-through. AC-52.48 — cold-D1 → 404 with trace.
 *
 * Traces: FR-51 AC-51.6, FR-53 AC-53.2, AC-53.5, AC-52.46, AC-52.48, AC-52.51.
 */
import type { ProxyEnv } from '../env';
import type { DispatchResult } from './common';
import { jsonResponse } from './common';
import { corsHeaders } from '../security/origin-allowlist';
import { readQuotesThroughD1 } from '../services/read-through-cache';
import { logEvent } from '../observability/log';

export async function handleQuotes(
  bioguideId: string,
  request: Request,
  env: ProxyEnv,
  origin: string,
  traceId?: string,
): Promise<DispatchResult> {
  if (!/^[A-Z]\d{6}$/.test(bioguideId)) {
    return {
      response: jsonResponse(400, { error: 'invalid_bioguide_id' }, corsHeaders(origin)),
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
    record = await readQuotesThroughD1(ctx, bioguideId);
  } else {
    record = (await env.KV_VOTER_INFO.get(`quote:v1:${bioguideId}`, 'text')) as string | null;
  }
  if (!record) {
    logEvent(
      { env: ctx.env, traceId: ctx.traceId },
      {
        event: 'embed_read_cold',
        level: 'warn',
        routeClass: 'quotes',
        bioguideId,
      },
    );
    return {
      response: jsonResponse(
        404,
        { error: 'quotes_not_found', bioguideId },
        corsHeaders(origin),
      ),
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
