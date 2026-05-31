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
import { projectNameIndex, type MemberRow } from '../services/member-projector';

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
  let meta = await env.KV_VOTER_INFO.get(KV_PREFIXES.nameIndex + 'meta', 'text');

  // FR-32 AC-32.41 — index missing: self-heal by rebuilding the whole
  // name-index from the durable D1 `members` table and write-through caching
  // every shard + meta, then continue serving this query from those shards.
  if (!meta && env.D1_VOTER_INFO) {
    try {
      const res = await env.D1_VOTER_INFO.prepare('SELECT * FROM members').all<MemberRow>();
      const rows = res.results ?? [];
      if (rows.length > 0) {
        const { shards, meta: metaRec } = projectNameIndex(rows, new Date().toISOString());
        for (const [letter, shard] of shards) {
          try { await env.KV_VOTER_INFO.put(KV_PREFIXES.nameIndex + letter, JSON.stringify(shard)); } catch { /* best-effort */ }
        }
        const metaJson = JSON.stringify(metaRec);
        meta = metaJson;
        try { await env.KV_VOTER_INFO.put(KV_PREFIXES.nameIndex + 'meta', metaJson); } catch { /* best-effort */ }
      }
    } catch { /* fall through to 503 */ }
  }

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
