/**
 * /api/name-search?q=<query> — searches curator-written name-index shards.
 *
 * Owns its implementation as of Phase 12 T-075 (2026-04-19).
 *
 * Traces: FR-31 AC-31.1..AC-31.12. FR-32 AC-32.4. FR-42.
 */
import type { ProxyEnv } from '../env';
import type { DispatchResult } from './common';
import { jsonResponse } from './common';
import { corsHeaders } from '../security/origin-allowlist';
import {
  normalizeSearchKey,
  rankMatches,
  type NameIndexEntry,
} from '../kv/name-index';
import { KV_PREFIXES } from '../kv/prefixes';

export async function handleNameSearch(
  request: Request,
  url: URL,
  env: ProxyEnv,
  origin: string,
): Promise<DispatchResult> {
  const q = url.searchParams.get('q') ?? '';
  const normalized = normalizeSearchKey(q);
  if (normalized.length < 2) {
    return {
      response: jsonResponse(400, { error: 'query_too_short' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }
  const meta = await env.KV_VOTER_INFO.get(KV_PREFIXES.nameIndex + 'meta', 'text');
  if (!meta) {
    return {
      response: jsonResponse(503, { error: 'index_not_ready' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }
  const letters = new Set<string>();
  for (const word of normalized.split(' ')) {
    const first = word[0];
    if (first) letters.add(first);
  }
  const allEntries: NameIndexEntry[] = [];
  const seen = new Set<string>();
  for (const letter of letters) {
    const shardJson = await env.KV_VOTER_INFO.get(KV_PREFIXES.nameIndex + letter, 'text');
    if (!shardJson) continue;
    const shard = JSON.parse(shardJson as string) as { entries: NameIndexEntry[] };
    for (const entry of shard.entries) {
      if (seen.has(entry.bioguideId)) continue;
      seen.add(entry.bioguideId);
      allEntries.push(entry);
    }
  }
  const ranked = rankMatches(normalized, allEntries);
  const truncated = ranked.length > 10;
  const results = ranked.slice(0, 10);
  const headers = new Headers(corsHeaders(origin));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'public, max-age=60, s-maxage=300');
  return {
    response: new Response(
      request.method === 'HEAD' ? null : JSON.stringify({ results, truncated }),
      { status: 200, headers },
    ),
    shape: 'api-proxied',
  };
}
