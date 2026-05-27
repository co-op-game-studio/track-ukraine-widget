/**
 * /api/stats/v1/summary — public aggregate stats endpoint (FR-56).
 *
 * Returns the contents of KV `stats:v1:summary` verbatim. Stats are
 * computed at publish time (FR-51), not per request — this route is a
 * cache lookup. 503 with `Retry-After: 60` if the record is missing
 * (cold cache after fresh deploy) per AC-56.4.
 *
 * Traces: FR-56 AC-56.1..AC-56.4.
 */
import type { ProxyEnv } from '../env';
import type { DispatchResult } from './common';
import { jsonResponse } from './common';
import { corsHeaders } from '../security/origin-allowlist';
import { KV_PREFIXES } from '../kv/prefixes';

export async function handleStatsSummary(
  request: Request,
  env: ProxyEnv,
  origin: string,
): Promise<DispatchResult> {
  const record = await env.KV_VOTER_INFO.get(KV_PREFIXES.stats + 'summary', 'text');
  if (!record) {
    const headers = new Headers(corsHeaders(origin));
    headers.set('Retry-After', '60');
    return {
      response: jsonResponse(
        503,
        {
          error: 'stats_not_ready',
          retryAfterSeconds: 60,
          detail:
            'Stats record has not been published yet. Retry shortly; ' +
            'the publish pipeline runs every 15 minutes.',
        },
        Object.fromEntries(headers),
      ),
      shape: 'worker-emitted',
    };
  }
  const headers = new Headers(corsHeaders(origin));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'public, max-age=300, s-maxage=900');
  return {
    response: new Response(request.method === 'HEAD' ? null : (record as string), {
      status: 200,
      headers,
    }),
    shape: 'api-proxied',
  };
}
