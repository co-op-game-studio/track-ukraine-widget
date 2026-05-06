/**
 * /api/rep-bundle/{bioguideId} — single-call render bundle for the embed.
 *
 * Replaces the per-visitor fan-out of:
 *   1× /api/members/{id}
 *   1× /api/social-posts/{id}
 *   1× /api/quotes/{id}
 *   N× /api/comments/{billId}
 *   N× /api/roll-calls/{c}/{s}/{r}/{rc}
 * (~30 calls per rep × 3 reps ≈ 90 calls per visitor) with ONE KV read.
 *
 * Design:
 *   - The bundle is a denormalized, cached projection of the smaller
 *     per-resource KV records. It's NOT a separate source of truth — D1
 *     (admin writes) and the per-resource KV records (publish output)
 *     stay authoritative.
 *   - Read-through fill: if `rep-bundle:v1:{id}` is missing, the Worker
 *     composes it on the fly from the underlying records and writes it
 *     back with a 30-min TTL. Invalidation = key deletion (handled
 *     elsewhere when admins mutate D1).
 *   - 30-min TTL caps staleness for the eventual-consistency case where
 *     an admin mutation didn't invalidate the bundle key directly.
 *
 * Per-resource endpoints (`/api/members/{id}`, `/api/comments/{billId}`,
 * etc.) stay live for admin and any non-widget consumer.
 */
import type { ProxyEnv } from '../env';
import type { DispatchResult } from './common';
import { jsonResponse } from './common';
import { corsHeaders } from '../security/origin-allowlist';
import { KV_PREFIXES } from '../kv/prefixes';
import { handleMemberProfile } from './api-members';

const BUNDLE_TTL_SECONDS = 30 * 60;

interface BillRecordLite {
  billId: string;
  votes?: Array<{
    chamber: string;
    congress: number;
    session: number;
    rollCall: number;
  }>;
}

interface MemberLite {
  bioguideId: string;
  sponsored?: Array<{ billId?: string; bill_id?: string; type?: string; number?: string | number; congress?: number }>;
  cosponsored?: Array<{ billId?: string; bill_id?: string; type?: string; number?: string | number; congress?: number }>;
}

/**
 * Compose the bundle. Reads the member profile via the existing
 * read-through handler (so cold-fill from upstream Congress.gov still
 * works the same), then enumerates referenced bills, roll calls, and
 * comments and reads each from KV in parallel.
 */
async function composeBundle(
  bioguideId: string,
  request: Request,
  env: ProxyEnv,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
  origin: string,
): Promise<{ bundle: Record<string, unknown> | null; status: number }> {
  const kv = env.KV_VOTER_INFO;

  // 1. Member profile — reuse the canonical handler so partyPrior stamping,
  //    cold-fill from upstream, error envelope, etc. all stay consistent.
  const memberResult = await handleMemberProfile(bioguideId, request, env, ctx, origin);
  if (memberResult.response.status !== 200) {
    return { bundle: null, status: memberResult.response.status };
  }
  const memberJson = (await memberResult.response.clone().json()) as MemberLite & Record<string, unknown>;

  // 2. Enumerate bill IDs the rep is connected to (sponsored + cosponsored).
  //    The publish pipeline normalizes to billId = `{type}{number}` (no congress
  //    prefix), but older records may have variants. Be permissive.
  const billIdSet = new Set<string>();
  function addBill(item: { billId?: string; bill_id?: string; type?: string; number?: string | number; congress?: number } | undefined): void {
    if (!item) return;
    const id = item.billId ?? item.bill_id;
    if (typeof id === 'string' && id) { billIdSet.add(id); return; }
    if (item.type && item.number != null) {
      billIdSet.add(`${item.type}${item.number}`);
    }
  }
  for (const s of memberJson.sponsored ?? []) addBill(s);
  for (const s of memberJson.cosponsored ?? []) addBill(s);

  // 3. Per-rep curated content + per-bill record/comments/roll-calls — all
  //    in parallel.
  const [socialPostsRaw, quotesRaw, billRecords, commentRecords] = await Promise.all([
    kv.get(`${KV_PREFIXES.socialPost}${bioguideId}`, 'text'),
    kv.get(`${KV_PREFIXES.quote}${bioguideId}`, 'text'),
    Promise.all(
      Array.from(billIdSet).map(async (billId) => {
        const raw = await kv.get(`${KV_PREFIXES.bill}${billId}`, 'text');
        return [billId, raw ? safeParse(raw as string) : null] as const;
      }),
    ),
    Promise.all(
      Array.from(billIdSet).map(async (billId) => {
        const raw = await kv.get(`${KV_PREFIXES.comment}${billId}`, 'text');
        return [billId, raw ? safeParse(raw as string) : null] as const;
      }),
    ),
  ]);

  // 4. From the bills we just loaded, enumerate every roll call referenced
  //    and bulk-fetch them. (Roll calls are coordinate-keyed under a
  //    different prefix, not by billId.)
  const rollCallKeys = new Set<string>();
  const billsMap: Record<string, unknown> = {};
  for (const [billId, rec] of billRecords) {
    if (!rec) continue;
    billsMap[billId] = rec;
    const bill = rec as BillRecordLite;
    for (const v of bill.votes ?? []) {
      const k = `${String(v.chamber).toLowerCase()}:${v.congress}:${v.session}:${v.rollCall}`;
      rollCallKeys.add(k);
    }
  }
  const rollCallEntries = await Promise.all(
    Array.from(rollCallKeys).map(async (key) => {
      const raw = await kv.get(`${KV_PREFIXES.rollCall}${key}`, 'text');
      return [key, raw ? safeParse(raw as string) : null] as const;
    }),
  );
  const rollCallsMap: Record<string, unknown> = {};
  for (const [k, v] of rollCallEntries) if (v) rollCallsMap[k] = v;

  const commentsMap: Record<string, unknown> = {};
  for (const [k, v] of commentRecords) if (v) commentsMap[k] = v;

  const bundle = {
    bioguideId,
    member: memberJson,
    bills: billsMap,
    rollCalls: rollCallsMap,
    comments: commentsMap,
    socialPosts: socialPostsRaw ? safeParse(socialPostsRaw as string) : null,
    quotes: quotesRaw ? safeParse(quotesRaw as string) : null,
    bundledAt: new Date().toISOString(),
  };
  return { bundle, status: 200 };
}

export async function handleRepBundle(
  bioguideId: string,
  request: Request,
  env: ProxyEnv,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
  origin: string,
): Promise<DispatchResult> {
  if (!/^[A-Z]\d{6}$/i.test(bioguideId)) {
    return {
      response: jsonResponse(400, { error: 'invalid_bioguide_id' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }
  const kv = env.KV_VOTER_INFO;
  const cacheKey = `${KV_PREFIXES.repBundle}${bioguideId}`;
  const cached = (await kv.get(cacheKey, 'text')) as string | null;
  if (cached) {
    const headers = new Headers(corsHeaders(origin));
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Cache-Control', 'public, max-age=60, s-maxage=600');
    headers.set('X-Bundle-Cache', 'hit');
    return {
      response: new Response(request.method === 'HEAD' ? null : cached, { status: 200, headers }),
      shape: 'api-proxied',
    };
  }

  const { bundle, status } = await composeBundle(bioguideId, request, env, ctx, origin);
  if (!bundle) {
    return {
      response: jsonResponse(status, { error: 'rep_bundle_unavailable', bioguideId }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }
  const body = JSON.stringify(bundle);
  // Background-write the cache so the response isn't blocked on it.
  ctx.waitUntil(kv.put(cacheKey, body, { expirationTtl: BUNDLE_TTL_SECONDS }));

  const headers = new Headers(corsHeaders(origin));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'public, max-age=60, s-maxage=600');
  headers.set('X-Bundle-Cache', 'miss');
  return {
    response: new Response(request.method === 'HEAD' ? null : body, { status: 200, headers }),
    shape: 'api-proxied',
  };
}

function safeParse(s: string): unknown | null {
  try { return JSON.parse(s); } catch { return null; }
}
