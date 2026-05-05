/**
 * Read-through cache: KV → D1 fallthrough for embed read routes.
 *
 * AC-52.51 — when KV misses on `bill:v1:*`, `comment:v1:*`,
 * `social-post:v1:*`, or `quote:v1:*`, query D1 directly, project via the
 * shared `kv-projector`, write back to KV (no TTL — invalidation is explicit
 * per AC-52.47), and return the projection. AC-52.48 governs the cold-D1
 * 404 path: if D1 is also empty, return null and let the caller emit the
 * FR-37 error envelope.
 *
 * Pure-ish: side effects are KV write + structured log line. No upstream
 * Congress.gov calls happen here — the freshness cron (AC-52.49) is the
 * only path that touches the API.
 *
 * Traces to AC-52.46, AC-52.48, AC-52.51.
 */
import type { D1Like, KVLike } from '../env';
import { logEvent } from '../observability/log';
import {
  projectBill,
  projectComments,
  projectSocialPosts,
  projectQuotes,
  KV_KEY,
  type D1Bill,
  type D1Vote,
  type D1Comment,
  type D1SocialPost,
  type D1Quote,
} from './kv-projector';

interface RtCtx {
  env: string;
  traceId: string;
  d1: D1Like;
  kv: KVLike;
}

function isoNow(): string {
  return new Date().toISOString();
}

async function logCacheEvent(
  ctx: RtCtx,
  outcome: 'cache_hit' | 'cache_miss' | 'cold_d1' | 'cache_filled',
  routeClass: string,
  key: string,
): Promise<void> {
  logEvent(
    { env: ctx.env, traceId: ctx.traceId },
    {
      event: 'embed_read_cache',
      level: outcome === 'cold_d1' ? 'warn' : 'info',
      outcome,
      routeClass,
      key,
    },
  );
}

/**
 * Generic body: try KV; on miss, run the D1 fetch + project, write KV, return.
 * On D1-empty, returns null (caller emits 404).
 */
async function readThrough<T>(
  ctx: RtCtx,
  routeClass: string,
  key: string,
  fetchAndProject: () => Promise<T | null>,
): Promise<string | null> {
  const cached = await ctx.kv.get(key, 'text');
  if (cached) {
    await logCacheEvent(ctx, 'cache_hit', routeClass, key);
    return cached as string;
  }
  const projected = await fetchAndProject();
  if (projected === null) {
    await logCacheEvent(ctx, 'cold_d1', routeClass, key);
    return null;
  }
  const body = JSON.stringify(projected);
  // Best-effort KV write — even if it fails (KV throttle, transient), we
  // still serve this request and the next one will refetch.
  await ctx.kv.put(key, body).catch(() => undefined);
  await logCacheEvent(ctx, 'cache_filled', routeClass, key);
  return body;
}

export async function readBillThroughD1(
  ctx: RtCtx,
  billId: string,
): Promise<string | null> {
  return readThrough(ctx, 'bills', KV_KEY.bill(billId), async () => {
    const bill = await ctx.d1
      .prepare('SELECT * FROM bills WHERE bill_id = ?')
      .bind(billId)
      .first<D1Bill>();
    if (!bill) return null;
    const votes = await ctx.d1
      .prepare('SELECT * FROM votes WHERE bill_id = ?')
      .bind(billId)
      .all<D1Vote>();
    return projectBill(bill, votes.results ?? [], isoNow());
  });
}

export async function readCommentsThroughD1(
  ctx: RtCtx,
  billId: string,
): Promise<string | null> {
  return readThrough(ctx, 'comments', KV_KEY.comments(billId), async () => {
    // For comments, an empty list is still a valid response (a bill with
    // zero comments). We only return null (→ 404) when the bill itself
    // doesn't exist in D1.
    const billExists = await ctx.d1
      .prepare('SELECT 1 FROM bills WHERE bill_id = ? LIMIT 1')
      .bind(billId)
      .first<{ '1': number }>();
    if (!billExists) return null;
    const result = await ctx.d1
      .prepare('SELECT * FROM comments WHERE bill_id = ?')
      .bind(billId)
      .all<D1Comment>();
    return projectComments(billId, result.results ?? [], isoNow());
  });
}

export async function readSocialPostsThroughD1(
  ctx: RtCtx,
  bioguideId: string,
): Promise<string | null> {
  return readThrough(ctx, 'social-posts', KV_KEY.socialPosts(bioguideId), async () => {
    const result = await ctx.d1
      .prepare('SELECT * FROM social_posts WHERE bioguide_id = ?')
      .bind(bioguideId)
      .all<D1SocialPost>();
    const rows = result.results ?? [];
    if (rows.length === 0) return null; // cold-D1 → 404
    return projectSocialPosts(bioguideId, rows, isoNow());
  });
}

export async function readQuotesThroughD1(
  ctx: RtCtx,
  bioguideId: string,
): Promise<string | null> {
  return readThrough(ctx, 'quotes', KV_KEY.quotes(bioguideId), async () => {
    const result = await ctx.d1
      .prepare('SELECT * FROM quotes WHERE bioguide_id = ?')
      .bind(bioguideId)
      .all<D1Quote>();
    const rows = result.results ?? [];
    if (rows.length === 0) return null;
    return projectQuotes(bioguideId, rows, isoNow());
  });
}
