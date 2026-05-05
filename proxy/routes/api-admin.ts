/**
 * Admin write API — `/api/admin/*` (FR-50, FR-58).
 *
 * Cloudflare Access gates the path at the edge; the Worker independently
 * verifies the CF Access JWT via `extractAdminActor` before any handler runs.
 * Each successful write produces one structured log line (FR-50 AC-50.6)
 * carrying the inbound trace ID and the actor email, so backend operations
 * are queryable from Logpush via `traceId`.
 *
 * Atomic mutation+audit happens inside `admin-store` (FR-50 AC-50.3); this
 * route layer just translates HTTP into store calls.
 *
 * Traces to FR-50, FR-58, FR-54 AC-54.1, ADR-017.
 */
import type { ProxyEnv } from '../env';
import type { DispatchResult, WaitUntilLike } from './common';
import { jsonResponse } from './common';
import { extractAdminActor, isAdminActor } from '../security/admin-actor';
import { logEvent } from '../observability/log';
import * as store from '../d1/admin-store';
import { handleIngest } from './api-admin-ingest';
import { getSocialPollStalenessMin } from '../services/cron-interval';
import * as tagsStore from '../d1/tags-store';
import { KV_PREFIXES } from '../kv/prefixes';

const ADMIN_ALLOW_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';

interface AdminCtx {
  email: string;
  traceId: string;
  envName: string;
  /** Optional change-notes from the writer — flows into audit_log.reason.
   *  Set per-request from the JSON body's `_reason` field or from the
   *  `?reason=…` query param on DELETE. */
  reason?: string;
  /** AC-52.47 — KV binding so admin-store can invalidate cache keys after
   *  a successful D1 batch. */
  env?: ProxyEnv;
}

/* -------------------------------------------------------------------------- */
/*                                 Top-level                                  */
/* -------------------------------------------------------------------------- */

/**
 * Entry point. Path is the trailing portion after `/api/admin/`.
 * Handles the OPTIONS preflight at the top, then the auth gate, then routes.
 */
export async function handleAdmin(
  rest: string,
  request: Request,
  env: ProxyEnv,
  ctx: WaitUntilLike,
  origin: string | null,
  traceId: string,
  envName: string,
): Promise<DispatchResult> {
  void ctx;
  void origin;
  if (request.method === 'OPTIONS') {
    return {
      response: new Response(null, {
        status: 204,
        headers: { Allow: ADMIN_ALLOW_METHODS },
      }),
      shape: 'api-proxied',
    };
  }
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)) {
    return {
      response: new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: ADMIN_ALLOW_METHODS },
      }),
      shape: 'worker-emitted',
    };
  }
  if (!env.D1_VOTER_INFO) {
    return {
      response: jsonResponse(503, {
        error: 'd1_unavailable',
        detail: 'D1 binding not configured for this environment.',
        traceId,
      }),
      shape: 'worker-emitted',
    };
  }
  // Auth gate.
  const actor = await extractAdminActor(request, env);
  if (!isAdminActor(actor)) return { response: actor, shape: 'worker-emitted' };
  const adminCtx: AdminCtx = { email: actor.email, traceId, envName, env };

  // Route by first path segment.
  const [resource, id, action] = rest.split('/');
  if (resource === 'whoami') return ok(adminCtx, { email: adminCtx.email });

  // GET /api/admin/config — read-only runtime knobs (all env-derived, no
  // user-tunable settings). Surfaces the values so the SPA can show them and
  // skip features that aren't configured.
  if (resource === 'config' && request.method === 'GET') {
    return await handleConfig(env, adminCtx);
  }

  // /api/admin/tags — Settings ▸ Tags CRUD.
  if (resource === 'tags') {
    return await handleTags(id, request, env, adminCtx);
  }

  // /api/admin/cache — operator-only KV inspection + purge (FR-58, AC-58.NEW).
  // Mitigates audit finding L: gives admins a controlled surface to invalidate
  // member-profile / bill / quote KV records when curated data has drifted,
  // rather than relying on TTL expiry. Inspection is GET; purge is POST.
  if (resource === 'cache') {
    return await handleCache(id, action, request, env, adminCtx);
  }

  if (resource === 'audit') return await handleAudit(request, env, adminCtx);
  if (resource === 'import-bill') return await handleImportBill(request, env, adminCtx);
  if (resource === 'backfill-bills') return await handleBackfillBills(request, env, adminCtx);
  if (resource === 'ingest') {
    const ingestSubpath = [id, action].filter(Boolean).join('/');
    return await handleIngest(ingestSubpath, request, env, {
      email: adminCtx.email,
      traceId: adminCtx.traceId,
    });
  }
  if (resource === 'cosponsors') return await handleListByBill(request, env, adminCtx, 'cosponsors');
  if (resource === 'actions') return await handleListByBill(request, env, adminCtx, 'actions');

  if (resource === undefined) {
    return badRequest(adminCtx, 'missing_resource', 'Path must include a resource segment.');
  }

  switch (resource) {
    case 'bills':
      return handleResource(request, env, adminCtx, 'bills', id, action, billsHandlers);
    case 'votes':
      return handleResource(request, env, adminCtx, 'votes', id, action, votesHandlers);
    case 'comments':
      return handleResource(request, env, adminCtx, 'comments', id, action, commentsHandlers);
    case 'social-posts':
      return handleResource(
        request,
        env,
        adminCtx,
        'social_posts',
        id,
        action,
        socialPostsHandlers,
      );
    case 'quotes':
      return handleResource(request, env, adminCtx, 'quotes', id, action, quotesHandlers);
    default:
      return notFound(adminCtx, `unknown resource: ${resource}`);
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/admin/config — returns runtime knobs the SPA needs to render
 * properly. All values are env-derived (no user-tunable settings):
 *   - `pollConcurrency` ← `POLL_CONCURRENCY` env var
 *   - `socialPollCron` ← `SOCIAL_POLL_CRON` env var (cron schedule)
 *   - `socialPollStalenessMin` ← derived from the cron schedule
 *     (cron interval minus a small safety margin)
 */
function handleConfig(env: ProxyEnv, ctx: AdminCtx): DispatchResult {
  const concurrency = parsePosInt(env.POLL_CONCURRENCY, 4);
  const cron = env.SOCIAL_POLL_CRON?.trim() || '0 * * * *';
  const stalenessMin = getSocialPollStalenessMin(env);
  return ok(ctx, {
    pollConcurrency: concurrency,
    socialPollCron: cron,
    socialPollStalenessMin: stalenessMin,
  });
}

/** Parse a string env var as a positive integer, falling back when missing/bad. */
function parsePosInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/* -------------------------------------------------------------------------- */
/*                                Cache control                               */
/* -------------------------------------------------------------------------- */

/**
 * Operator-only KV cache inspection + invalidation surface.
 *
 *   GET  /api/admin/cache              → counts per known prefix + per-prefix TTLs
 *   GET  /api/admin/cache/<prefix>     → list keys under a single prefix (capped)
 *   POST /api/admin/cache/<prefix>     → purge ALL keys under a prefix (with reason)
 *   DELETE /api/admin/cache/<prefix>/<key> → purge a single key
 *
 * Audited via `logEvent` so any purge appears in the structured log with the
 * actor + traceId + which prefix/key. Mitigates the AC-51.7 letter-vs-spirit
 * tension that admin-store invalidating cache keys post-D1-write opened up
 * (the operator now has an explicit, audited surface for the same action).
 */
async function handleCache(
  id: string | undefined,
  action: string | undefined,
  request: Request,
  env: ProxyEnv,
  ctx: AdminCtx,
): Promise<DispatchResult> {
  const kv = env.KV_VOTER_INFO;
  // Map of safe-to-touch prefix slugs (URL-friendly) → real KV prefix string.
  // Locked-down list so a stray POST to /api/admin/cache/secrets can't purge
  // anything we don't intend to expose.
  const PREFIX_MAP: Record<string, { prefix: string; description: string; ttlSec: number }> = {
    member:        { prefix: KV_PREFIXES.member,         description: 'Member profile read-through cache (Worker fills from upstream)', ttlSec: 30 * 24 * 3600 },
    bill:          { prefix: KV_PREFIXES.bill,           description: 'Curated bill snapshot (publish-d1-to-kv)',                       ttlSec: 0 /* no TTL, durable */ },
    'roll-call':   { prefix: KV_PREFIXES.rollCall,       description: 'Immutable roll-call metadata (publish-to-kv)',                   ttlSec: 0 },
    'roll-call-roster': { prefix: KV_PREFIXES.rollCallRoster, description: 'Per-vote member rosters (publish-to-kv)',                   ttlSec: 0 },
    'state-members': { prefix: KV_PREFIXES.stateMembers, description: 'Per-state member directory (publish-to-kv)',                     ttlSec: 0 },
    'name-index':  { prefix: KV_PREFIXES.nameIndex,      description: 'Name-search shards + meta (publish-to-kv)',                      ttlSec: 0 },
    cache:         { prefix: KV_PREFIXES.cache,          description: 'Generic Worker read-through cache (per-route TTLs)',             ttlSec: 0 },
    comment:       { prefix: KV_PREFIXES.comment,        description: 'Per-bill comments projection (publish-d1-to-kv)',                ttlSec: 0 },
    'social-post': { prefix: KV_PREFIXES.socialPost,     description: 'Per-rep social posts projection (publish-d1-to-kv)',             ttlSec: 0 },
    quote:         { prefix: KV_PREFIXES.quote,          description: 'Per-rep quotes projection (publish-d1-to-kv)',                   ttlSec: 0 },
    stats:         { prefix: KV_PREFIXES.stats,          description: 'Stats summary record (publish-d1-to-kv + party-priors overlay)', ttlSec: 0 },
    'audit-feed':  { prefix: KV_PREFIXES.auditFeed,      description: 'Audit feed projections (publish-d1-to-kv)',                      ttlSec: 0 },
    scores:        { prefix: KV_PREFIXES.scores,         description: 'Score-derived KV records (party priors)',                        ttlSec: 0 },
  };

  // GET /api/admin/cache — overview
  if (!id && request.method === 'GET') {
    // Counts per prefix. KV.list() is paginated; cap at 1k per prefix to
    // bound the inspection cost. The exact count for huge prefixes (member
    // can grow to 600+ records) is fine — just paginate.
    const summaries = await Promise.all(
      Object.entries(PREFIX_MAP).map(async ([slug, meta]) => {
        let count = 0;
        let cursor: string | undefined = undefined;
        let pages = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          // Cap inspection at 5 pages so a runaway list can't burn budget.
          if (pages >= 5) break;
          const opts = cursor ? { prefix: meta.prefix, cursor } : { prefix: meta.prefix };
          const r = await kv.list(opts);
          count += r.keys.length;
          pages++;
          if (r.list_complete || !r.cursor) break;
          cursor = r.cursor;
        }
        return {
          slug,
          prefix: meta.prefix,
          description: meta.description,
          ttlSec: meta.ttlSec,
          approxCount: count,
          truncated: pages >= 5,
        };
      }),
    );
    return ok(ctx, { prefixes: summaries });
  }

  // /api/admin/cache/<slug> — single prefix
  if (id && !action) {
    const meta = PREFIX_MAP[id];
    if (!meta) return notFound(ctx, `unknown cache prefix slug: ${id}`);

    if (request.method === 'GET') {
      // List up to 200 keys under this prefix (one page).
      const r = await kv.list({ prefix: meta.prefix });
      const keys = r.keys.slice(0, 200).map((k) => k.name);
      return ok(ctx, {
        slug: id,
        prefix: meta.prefix,
        description: meta.description,
        ttlSec: meta.ttlSec,
        keys,
        truncated: !r.list_complete || r.keys.length > 200,
      });
    }

    if (request.method === 'POST') {
      // Purge ALL under this prefix. Requires `_reason` like other writes.
      const body = await readBody(request, ctx);
      if (isDispatchResult(body)) return body;
      if (!ctx.reason) return reasonRequiredError(ctx);

      let cursor: string | undefined = undefined;
      let purged = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const opts = cursor ? { prefix: meta.prefix, cursor } : { prefix: meta.prefix };
        const page = await kv.list(opts);
        await Promise.all(page.keys.map((k) => kv.delete(k.name).catch(() => { /* best-effort */ })));
        purged += page.keys.length;
        if (page.list_complete || !page.cursor) break;
        cursor = page.cursor;
      }

      logEvent(
        { env: ctx.envName, traceId: ctx.traceId },
        { event: 'admin.cache.purge_prefix', level: 'warn', slug: id, prefix: meta.prefix, purged, actor: ctx.email, reason: ctx.reason },
      );
      return ok(ctx, { slug: id, prefix: meta.prefix, purged, reason: ctx.reason });
    }
  }

  // /api/admin/cache/<slug>/<key-tail> — single key purge
  if (id && action && request.method === 'DELETE') {
    const meta = PREFIX_MAP[id];
    if (!meta) return notFound(ctx, `unknown cache prefix slug: ${id}`);
    const url = new URL(request.url);
    const queryReason = url.searchParams.get('reason')?.trim();
    if (queryReason) ctx.reason = queryReason;
    if (!ctx.reason) return reasonRequiredError(ctx);
    const fullKey = meta.prefix + action;
    await kv.delete(fullKey);
    logEvent(
      { env: ctx.envName, traceId: ctx.traceId },
      { event: 'admin.cache.purge_key', level: 'warn', key: fullKey, actor: ctx.email, reason: ctx.reason },
    );
    return ok(ctx, { key: fullKey, purged: 1, reason: ctx.reason });
  }

  return badRequest(ctx, 'method_not_allowed', 'Supported: GET /cache, GET /cache/<slug>, POST /cache/<slug>, DELETE /cache/<slug>/<key>');
}

/**
 * Tags CRUD: GET/POST /api/admin/tags, PATCH/DELETE /api/admin/tags/:id.
 * Tags are a shared categorization primitive (Settings ▸ Tags). Quotes are the
 * first consumer; future resources can apply tags via the same API.
 */
async function handleTags(
  id: string | undefined,
  request: Request,
  env: ProxyEnv,
  ctx: AdminCtx,
): Promise<DispatchResult> {
  const d1 = env.D1_VOTER_INFO!;

  if (request.method === 'GET') {
    if (id) {
      const tag = await tagsStore.getTag(d1, id);
      if (!tag) return notFound(ctx, `tag not found: ${id}`);
      return ok(ctx, { tag });
    }
    const tags = await tagsStore.listTags(d1);
    return ok(ctx, { items: tags });
  }

  if (request.method === 'POST') {
    const body = await readBody(request, ctx);
    if (isDispatchResult(body)) return body;
    try {
      const tag = await tagsStore.createTag(
        d1,
        {
          slug: String(body['slug'] ?? '').trim(),
          label: String(body['label'] ?? '').trim(),
          color: String(body['color'] ?? '').trim(),
          description: typeof body['description'] === 'string' ? body['description'] : null,
        },
        mctx(ctx),
      );
      logEvent(
        { env: ctx.envName, traceId: ctx.traceId },
        { event: 'admin.tag.create', level: 'info', tag_id: tag.id, slug: tag.slug, actor: ctx.email },
      );
      return created(ctx, { tag });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return badRequest(ctx, 'invalid_tag', msg);
    }
  }

  if (request.method === 'PATCH' && id) {
    const body = await readBody(request, ctx);
    if (isDispatchResult(body)) return body;
    // AC-50.8 — reason required on PATCH.
    if (!ctx.reason) return reasonRequiredError(ctx);
    try {
      const tag = await tagsStore.updateTag(
        d1,
        id,
        {
          slug: typeof body['slug'] === 'string' ? body['slug'] : undefined,
          label: typeof body['label'] === 'string' ? body['label'] : undefined,
          color: typeof body['color'] === 'string' ? body['color'] : undefined,
          description: body['description'] !== undefined ? (body['description'] as string | null) : undefined,
        },
        mctx(ctx),
      );
      if (!tag) return notFound(ctx, `tag not found: ${id}`);
      logEvent(
        { env: ctx.envName, traceId: ctx.traceId },
        { event: 'admin.tag.update', level: 'info', tag_id: id, actor: ctx.email },
      );
      return ok(ctx, { tag });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return badRequest(ctx, 'invalid_tag', msg);
    }
  }

  if (request.method === 'DELETE' && id) {
    // AC-50.8 — reason via ?reason=… query param.
    const url = new URL(request.url);
    const queryReason = url.searchParams.get('reason')?.trim();
    if (queryReason && queryReason.length > 0) ctx.reason = queryReason;
    if (!ctx.reason) return reasonRequiredError(ctx);
    const removed = await tagsStore.deleteTag(d1, id, mctx(ctx));
    if (!removed) return notFound(ctx, `tag not found: ${id}`);
    logEvent(
      { env: ctx.envName, traceId: ctx.traceId },
      { event: 'admin.tag.delete', level: 'info', tag_id: id, actor: ctx.email },
    );
    return ok(ctx, { deleted: true });
  }

  return badRequest(ctx, 'method_not_allowed', 'GET, POST, PATCH, DELETE supported.');
}

function ok(ctx: AdminCtx, body: unknown): DispatchResult {
  const r = jsonResponse(200, body);
  r.headers.set('Cache-Control', 'no-store');
  r.headers.set('X-Trace-Id', ctx.traceId);
  return { response: r, shape: 'api-proxied' };
}

function created(ctx: AdminCtx, body: unknown): DispatchResult {
  const r = jsonResponse(201, body);
  r.headers.set('Cache-Control', 'no-store');
  r.headers.set('X-Trace-Id', ctx.traceId);
  return { response: r, shape: 'api-proxied' };
}

function badRequest(ctx: AdminCtx, code: string, detail: string): DispatchResult {
  return {
    response: jsonResponse(400, { error: code, detail, traceId: ctx.traceId }),
    shape: 'worker-emitted',
  };
}

function notFound(ctx: AdminCtx, detail: string): DispatchResult {
  return {
    response: jsonResponse(404, { error: 'not_found', detail, traceId: ctx.traceId }),
    shape: 'worker-emitted',
  };
}

function serverError(ctx: AdminCtx, detail: string): DispatchResult {
  return {
    response: jsonResponse(500, { error: 'internal_error', detail, traceId: ctx.traceId }),
    shape: 'worker-emitted',
  };
}

/**
 * Parse a JSON body and split off the optional `_reason` field, mutating
 * `ctx.reason` so the underlying audit_log row picks it up. The Worker
 * SHALL strip `_reason` from the body before passing the payload to the
 * D1 store so it can never collide with a resource column (AC-50.8).
 */
async function readBody(request: Request, ctx: AdminCtx): Promise<Record<string, unknown> | DispatchResult> {
  const ct = request.headers.get('Content-Type') ?? '';
  if (!ct.includes('application/json')) {
    return {
      response: jsonResponse(415, {
        error: 'unsupported_media_type',
        detail: 'Content-Type must be application/json.',
        traceId: ctx.traceId,
      }),
      shape: 'worker-emitted',
    };
  }
  try {
    const json = (await request.json()) as Record<string, unknown>;
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      return badRequest(ctx, 'invalid_body', 'Body must be a JSON object.');
    }
    if (typeof json['_reason'] === 'string') {
      const trimmed = (json['_reason'] as string).trim();
      if (trimmed.length > 0) ctx.reason = trimmed;
      delete json['_reason'];
    }
    return json;
  } catch {
    return badRequest(ctx, 'invalid_body', 'Body is not valid JSON.');
  }
}

/** Build the per-call MutationContext, threading ctx.reason through so
 *  the audit row picks it up. Centralized so every call site stays in sync. */
function mctx(ctx: AdminCtx): {
  actorEmail: string;
  traceId: string;
  reason?: string;
  kv?: ProxyEnv['KV_VOTER_INFO'];
} {
  const base = { actorEmail: ctx.email, traceId: ctx.traceId, kv: ctx.env?.KV_VOTER_INFO };
  if (ctx.reason) return { ...base, reason: ctx.reason };
  return base;
}

/** AC-50.8 — block update / delete when no reason was supplied. */
function reasonRequiredError(ctx: AdminCtx): DispatchResult {
  return {
    response: jsonResponse(400, {
      error: 'reason_required',
      detail:
        'Update and delete operations require a non-empty `_reason` field ' +
        '(or `?reason=` query param on DELETE). The reason flows into ' +
        'audit_log.reason for traceability.',
      traceId: ctx.traceId,
    }),
    shape: 'worker-emitted',
  };
}

function isDispatchResult(v: unknown): v is DispatchResult {
  return (
    typeof v === 'object' &&
    v !== null &&
    'response' in v &&
    (v as { response: unknown }).response instanceof Response
  );
}

function logWrite(
  ctx: AdminCtx,
  outcome: 'ok' | 'validation_error' | 'not_found' | 'error',
  fields: {
    action: 'create' | 'update' | 'delete' | 'list' | 'get';
    table: string;
    rowId?: string;
    code?: string;
  },
): void {
  const level: 'info' | 'warn' | 'error' =
    outcome === 'ok' ? 'info' : outcome === 'error' ? 'error' : 'warn';
  logEvent(
    { env: ctx.envName, traceId: ctx.traceId },
    {
      event: 'admin_write',
      level,
      actor: ctx.email,
      action: fields.action,
      target_table: fields.table,
      row_id: fields.rowId ?? null,
      outcome,
      code: fields.code,
    },
  );
}

/* -------------------------------------------------------------------------- */
/*                          Per-resource handler tables                       */
/* -------------------------------------------------------------------------- */

interface ResourceHandlers {
  /** AC-52.22 — list may consult the request URL for filter params (`?billId=`). */
  list(env: ProxyEnv, ctx: AdminCtx, request: Request): Promise<DispatchResult>;
  get(env: ProxyEnv, ctx: AdminCtx, id: string): Promise<DispatchResult>;
  create(env: ProxyEnv, ctx: AdminCtx, body: Record<string, unknown>): Promise<DispatchResult>;
  update(
    env: ProxyEnv,
    ctx: AdminCtx,
    id: string,
    body: Record<string, unknown>,
  ): Promise<DispatchResult>;
  remove(env: ProxyEnv, ctx: AdminCtx, id: string): Promise<DispatchResult>;
}

async function handleResource(
  request: Request,
  env: ProxyEnv,
  ctx: AdminCtx,
  table: string,
  id: string | undefined,
  action: string | undefined,
  handlers: ResourceHandlers,
): Promise<DispatchResult> {
  if (action !== undefined && action !== '') {
    return notFound(ctx, `unknown sub-action for ${table}: ${action}`);
  }
  try {
    if (request.method === 'GET') {
      if (!id) {
        const r = await handlers.list(env, ctx, request);
        return r;
      }
      return await handlers.get(env, ctx, id);
    }
    if (request.method === 'POST') {
      if (id) return badRequest(ctx, 'invalid_path', 'POST does not take an id segment.');
      const body = await readBody(request, ctx);
      if (isDispatchResult(body)) return body;
      return await handlers.create(env, ctx, body);
    }
    if (request.method === 'PATCH') {
      if (!id) return badRequest(ctx, 'invalid_path', 'PATCH requires an id segment.');
      const body = await readBody(request, ctx);
      if (isDispatchResult(body)) return body;
      // AC-50.8 — reason required on PATCH.
      if (!ctx.reason) return reasonRequiredError(ctx);
      return await handlers.update(env, ctx, id, body);
    }
    if (request.method === 'DELETE') {
      if (!id) return badRequest(ctx, 'invalid_path', 'DELETE requires an id segment.');
      // AC-50.8 — reason via ?reason=… query param (DELETE has no body).
      // Optional body parsing: if Content-Type is JSON we honor `_reason`
      // there too, but that's not the documented path.
      const url = new URL(request.url);
      const queryReason = url.searchParams.get('reason')?.trim();
      if (queryReason && queryReason.length > 0) ctx.reason = queryReason;
      if (!ctx.reason) return reasonRequiredError(ctx);
      return await handlers.remove(env, ctx, id);
    }
    return notFound(ctx, 'unhandled method');
  } catch (err) {
    if (err instanceof store.ValidationError) {
      logWrite(ctx, 'validation_error', { action: 'create', table, code: err.code });
      return badRequest(ctx, err.code, err.message);
    }
    const rawMsg = (err as Error).message ?? String(err);
    // Translate common D1 errors into human-readable messages.
    let userMsg = rawMsg;
    if (/FOREIGN KEY constraint/i.test(rawMsg)) {
      userMsg = 'A referenced record does not exist. This may be a data setup issue — contact an administrator.';
    } else if (/UNIQUE constraint/i.test(rawMsg)) {
      userMsg = 'A record with this key already exists (duplicate).';
    }
    logWrite(ctx, 'error', { action: 'create' as const, table, code: rawMsg });
    return serverError(ctx, userMsg);
  }
}

const billsHandlers: ResourceHandlers = {
  async list(env, ctx, _request) {
    void _request;
    const rows = await store.listBills(env.D1_VOTER_INFO!);
    return ok(ctx, { items: rows });
  },
  async get(env, ctx, id) {
    const row = await store.getBill(env.D1_VOTER_INFO!, id);
    if (!row) return notFound(ctx, `bill not found: ${id}`);
    return ok(ctx, row);
  },
  async create(env, ctx, body) {
    const row = await store.createBill(
      env.D1_VOTER_INFO!,
      mctx(ctx),
      body as unknown as store.BillCreateInput,
    );
    logWrite(ctx, 'ok', { action: 'create', table: 'bills', rowId: row.id });
    return created(ctx, { row });
  },
  async update(env, ctx, id, body) {
    const row = await store.updateBill(
      env.D1_VOTER_INFO!,
      mctx(ctx),
      id,
      body as store.BillUpdate,
    );
    logWrite(ctx, 'ok', { action: 'update', table: 'bills', rowId: row.id });
    return ok(ctx, { row });
  },
  async remove(env, ctx, id) {
    await store.deleteBill(env.D1_VOTER_INFO!, mctx(ctx), id);
    logWrite(ctx, 'ok', { action: 'delete', table: 'bills', rowId: id });
    return ok(ctx, { deleted: true });
  },
};

const votesHandlers: ResourceHandlers = {
  async list(env, ctx, request) {
    // AC-52.22 — `?billId=` is the only supported filter; without it we
    // return an empty list so an unauthenticated bulk dump is impossible
    // and so we don't have to design a paginated cross-bill view.
    const billId = new URL(request.url).searchParams.get('billId');
    if (!billId) return ok(ctx, { items: [] });
    const rows = await store.listVotesByBill(env.D1_VOTER_INFO!, billId);
    return ok(ctx, { items: rows });
  },
  async get(env, ctx, id) {
    const row = await store.getVote(env.D1_VOTER_INFO!, id);
    if (!row) return notFound(ctx, `vote not found: ${id}`);
    return ok(ctx, row);
  },
  async create(env, ctx, body) {
    const row = await store.createVote(
      env.D1_VOTER_INFO!,
      mctx(ctx),
      body as unknown as store.VoteCreateInput,
    );
    logWrite(ctx, 'ok', { action: 'create', table: 'votes', rowId: row.id });
    return created(ctx, { row });
  },
  async update(env, ctx, id, body) {
    const row = await store.updateVote(
      env.D1_VOTER_INFO!,
      mctx(ctx),
      id,
      body as store.VoteUpdate,
    );
    logWrite(ctx, 'ok', { action: 'update', table: 'votes', rowId: row.id });
    return ok(ctx, { row });
  },
  async remove(env, ctx, id) {
    await store.deleteVote(env.D1_VOTER_INFO!, mctx(ctx), id);
    logWrite(ctx, 'ok', { action: 'delete', table: 'votes', rowId: id });
    return ok(ctx, { deleted: true });
  },
};

const commentsHandlers: ResourceHandlers = {
  async list(env, ctx, request) {
    // AC-52.22 — same shape as votes: `?billId=` is the only supported filter.
    const billId = new URL(request.url).searchParams.get('billId');
    if (!billId) return ok(ctx, { items: [] });
    const rows = await store.listCommentsByBill(env.D1_VOTER_INFO!, billId);
    return ok(ctx, { items: rows });
  },
  async get(env, ctx, id) {
    const row = await store.getComment(env.D1_VOTER_INFO!, id);
    if (!row) return notFound(ctx, `comment not found: ${id}`);
    return ok(ctx, row);
  },
  async create(env, ctx, body) {
    const row = await store.createComment(
      env.D1_VOTER_INFO!,
      mctx(ctx),
      body as unknown as store.CommentCreateInput,
    );
    logWrite(ctx, 'ok', { action: 'create', table: 'comments', rowId: row.id });
    return created(ctx, { row });
  },
  async update(env, ctx, id, body) {
    const row = await store.updateComment(
      env.D1_VOTER_INFO!,
      mctx(ctx),
      id,
      body as store.CommentUpdate,
    );
    logWrite(ctx, 'ok', { action: 'update', table: 'comments', rowId: row.id });
    return ok(ctx, { row });
  },
  async remove(env, ctx, id) {
    await store.deleteComment(env.D1_VOTER_INFO!, mctx(ctx), id);
    logWrite(ctx, 'ok', { action: 'delete', table: 'comments', rowId: id });
    return ok(ctx, { deleted: true });
  },
};

const socialPostsHandlers: ResourceHandlers = {
  async list(_env, ctx, _request) {
    void _env;
    void _request;
    return ok(ctx, { items: [] });
  },
  async get(env, ctx, id) {
    const row = await store.getSocialPost(env.D1_VOTER_INFO!, id);
    if (!row) return notFound(ctx, `social_post not found: ${id}`);
    return ok(ctx, row);
  },
  async create(env, ctx, body) {
    const row = await store.createSocialPost(
      env.D1_VOTER_INFO!,
      mctx(ctx),
      body as unknown as store.SocialPostCreateInput,
    );
    logWrite(ctx, 'ok', { action: 'create', table: 'social_posts', rowId: row.id });
    return created(ctx, { row });
  },
  async update(env, ctx, id, body) {
    const row = await store.updateSocialPost(
      env.D1_VOTER_INFO!,
      mctx(ctx),
      id,
      body as store.SocialPostUpdate,
    );
    logWrite(ctx, 'ok', { action: 'update', table: 'social_posts', rowId: row.id });
    return ok(ctx, { row });
  },
  async remove(env, ctx, id) {
    await store.deleteSocialPost(
      env.D1_VOTER_INFO!,
      mctx(ctx),
      id,
    );
    logWrite(ctx, 'ok', { action: 'delete', table: 'social_posts', rowId: id });
    return ok(ctx, { deleted: true });
  },
};

const quotesHandlers: ResourceHandlers = {
  async list(env, ctx, request) {
    const url = new URL(request.url);
    const bioguideId = url.searchParams.get('bioguideId') ?? undefined;
    const limit = Number(url.searchParams.get('limit') || 100);
    const offset = Number(url.searchParams.get('offset') || 0);
    const d1 = env.D1_VOTER_INFO!;
    const items = await store.listQuotes(d1, { bioguideId, limit, offset });
    // Attach tags in a single batch query (avoid N+1).
    const tagMap = await tagsStore.listTagsForQuotes(d1, items.map((q) => q.id));
    const enriched = items.map((q) => ({ ...q, tags: tagMap.get(q.id) ?? [] }));
    return ok(ctx, { items: enriched });
  },
  async get(env, ctx, id) {
    const d1 = env.D1_VOTER_INFO!;
    const row = await store.getQuote(d1, id);
    if (!row) return notFound(ctx, `quote not found: ${id}`);
    const tags = await tagsStore.listTagsForQuote(d1, id);
    return ok(ctx, { ...row, tags });
  },
  async create(env, ctx, body) {
    const row = await store.createQuote(
      env.D1_VOTER_INFO!,
      mctx(ctx),
      body as unknown as store.QuoteCreateInput,
    );
    logWrite(ctx, 'ok', { action: 'create', table: 'quotes', rowId: row.id });
    const tags = await tagsStore.listTagsForQuote(env.D1_VOTER_INFO!, row.id);
    return created(ctx, { row: { ...row, tags } });
  },
  async update(env, ctx, id, body) {
    const d1 = env.D1_VOTER_INFO!;
    // Pull tag_ids out before passing the body to updateQuote (which doesn't
    // know about tags). If present, reset the tag set to match.
    const bodyObj = body as Record<string, unknown>;
    const tagIds = Array.isArray(bodyObj['tag_ids']) ? (bodyObj['tag_ids'] as string[]) : null;
    delete bodyObj['tag_ids'];
    const row = await store.updateQuote(d1, mctx(ctx), id, bodyObj as store.QuoteUpdate);
    if (tagIds !== null) {
      await tagsStore.setQuoteTags(d1, id, tagIds, ctx.email);
    }
    logWrite(ctx, 'ok', { action: 'update', table: 'quotes', rowId: row.id });
    const tags = await tagsStore.listTagsForQuote(d1, id);
    return ok(ctx, { row: { ...row, tags } });
  },
  async remove(env, ctx, id) {
    await store.deleteQuote(
      env.D1_VOTER_INFO!,
      mctx(ctx),
      id,
    );
    logWrite(ctx, 'ok', { action: 'delete', table: 'quotes', rowId: id });
    return ok(ctx, { deleted: true });
  },
};

/* -------------------------------------------------------------------------- */
/*                                Audit feed                                  */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/admin/audit?limit=N[&since=ISO]
 *
 * FR-58 AC-58.1, AC-58.3 — serve from the denormalized
 * `audit-feed:v1:full` KV record written by `scripts/publish-d1-to-kv.ts`,
 * NOT from D1 per-request. The KV record carries the canonical snake_case
 * shape (matching D1 column names) so this handler is a thin filter on top
 * of the cached projection.
 *
 * Filtering: `since` and `limit` are applied to the cached items in memory.
 * The cached record holds up to 100 most-recent rows by default — wide
 * `since` ranges that need older data fall back to D1 (operator escape
 * hatch) by passing `?source=d1`.
 *
 * Cold-start: if the KV record is missing (publish hasn't run yet), fall
 * back to D1 once and warn in the response so it's visible to ops.
 */
async function handleAudit(
  request: Request,
  env: ProxyEnv,
  ctx: AdminCtx,
): Promise<DispatchResult> {
  if (request.method !== 'GET') {
    return badRequest(ctx, 'method_not_allowed', 'GET only');
  }
  const url = new URL(request.url);
  const limitParam = url.searchParams.get('limit');
  const since = url.searchParams.get('since') ?? undefined;
  const sourceOverride = url.searchParams.get('source'); // 'd1' for ops escape hatch
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 50, 1), 100) : 50;

  if (sourceOverride !== 'd1') {
    // Primary path: read the KV projection.
    try {
      const cached = await env.KV_VOTER_INFO.get(KV_PREFIXES.auditFeed + 'full', 'text');
      if (cached) {
        const record = JSON.parse(cached as string) as { items: Array<Record<string, unknown>> };
        let items = record.items;
        if (since) items = items.filter((r) => String(r['created_at'] ?? '') >= since);
        items = items.slice(0, limit);
        return ok(ctx, { items, source: 'kv' });
      }
    } catch {
      // Fall through to D1 fallback below.
    }
  }

  // Cold-start / explicit-override / KV miss fallback. Same shape as the KV
  // projection — keeps clients from caring which path served them.
  const rows = await store.listAudit(env.D1_VOTER_INFO!, { limit, ...(since ? { since } : {}) });
  const reshaped = rows.map((r) => ({
    id: r.id,
    actor_email: r.actor_email,
    action: r.action,
    target_table: r.target_table,
    row_id: r.row_id,
    row_title: r.row_title,
    before: r.before_json ? JSON.parse(r.before_json) : null,
    after: r.after_json ? JSON.parse(r.after_json) : null,
    reason: r.reason,
    trace_id: r.trace_id,
    created_at: r.created_at,
  }));
  return ok(ctx, { items: reshaped, source: sourceOverride === 'd1' ? 'd1' : 'd1-fallback' });
}

/* -------------------------------------------------------------------------- */
/*                  Bill cosponsors + actions read-only routes                */
/* -------------------------------------------------------------------------- */

/** AC-52.58 / AC-52.59 — read-only listings keyed off `?billId=`. Without
 *  the param, return an empty list (no bulk dump). */
async function handleListByBill(
  request: Request,
  env: ProxyEnv,
  ctx: AdminCtx,
  kind: 'cosponsors' | 'actions',
): Promise<DispatchResult> {
  if (request.method !== 'GET') {
    return badRequest(ctx, 'method_not_allowed', 'GET only');
  }
  const billId = new URL(request.url).searchParams.get('billId');
  if (!billId) return ok(ctx, { items: [] });
  const items = kind === 'cosponsors'
    ? await store.listCosponsorsByBill(env.D1_VOTER_INFO!, billId)
    : await store.listActionsByBill(env.D1_VOTER_INFO!, billId);
  return ok(ctx, { items });
}

/* -------------------------------------------------------------------------- */
/*                            Bill onboarding (AC-52.49)                      */
/* -------------------------------------------------------------------------- */

import { importBillFromCongress } from '../services/import-bill';

async function handleImportBill(
  request: Request,
  env: ProxyEnv,
  ctx: AdminCtx,
): Promise<DispatchResult> {
  if (request.method !== 'POST') {
    return badRequest(ctx, 'method_not_allowed', 'POST only');
  }
  const body = await readBody(request, ctx);
  if (isDispatchResult(body)) return body;
  const congress = Number((body as Record<string, unknown>)['congress']);
  const type = String((body as Record<string, unknown>)['type'] ?? '');
  const number = String((body as Record<string, unknown>)['number'] ?? '');
  const force = Boolean((body as Record<string, unknown>)['force']);
  if (!Number.isInteger(congress) || congress < 100 || congress > 200) {
    return badRequest(ctx, 'invalid_congress', 'congress must be an integer 100..200');
  }
  if (!/^[A-Za-z]+$/.test(type)) {
    return badRequest(ctx, 'invalid_type', 'type must be alphabetic (HR / S / HJRES / …)');
  }
  if (!/^\d+$/.test(number)) {
    return badRequest(ctx, 'invalid_number', 'number must be numeric');
  }
  try {
    const url = new URL(request.url);
    const workerOrigin = `${url.protocol}//${url.host}`;
    const result = await importBillFromCongress(
      {
        congress,
        type,
        number,
        force,
        actorEmail: ctx.email,
        traceId: ctx.traceId,
      },
      { env, workerOrigin },
    );
    logEvent(
      { env: ctx.envName, traceId: ctx.traceId },
      {
        event: 'bill_import',
        level: 'info',
        actor: ctx.email,
        bill_id: result.bill.bill_id,
        votes_imported: result.votes_imported,
        votes_updated: result.votes_updated,
        votes_skipped: result.votes_skipped,
        cosponsors_imported: result.cosponsors_imported,
        actions_imported: result.actions_imported,
        cached: result.cached,
        duration_ms: result.duration_ms,
      },
    );
    return ok(ctx, result);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'bill_not_found') {
      return {
        response: jsonResponse(404, {
          error: 'bill_not_found',
          detail: `Congress.gov has no bill ${congress}-${type.toUpperCase()}-${number}`,
          traceId: ctx.traceId,
        }),
        shape: 'worker-emitted',
      };
    }
    if (msg.startsWith('congress_upstream_')) {
      return {
        response: jsonResponse(502, {
          error: 'upstream_failed',
          detail: msg,
          traceId: ctx.traceId,
        }),
        shape: 'worker-emitted',
      };
    }
    return serverError(ctx, msg);
  }
}

/* -------------------------------------------------------------------------- */
/*                       Backfill-all (one-shot operator)                     */
/* -------------------------------------------------------------------------- */

/** POST /api/admin/backfill-bills?after=<bill_id>&limit=N
 *
 *  Chunked re-import. Returns the next-cursor (`next_after`, or null when
 *  done) so the SPA can loop without blowing past Worker CPU limits or
 *  running afoul of Congress.gov rate limits. Default chunk size: 3 bills
 *  per call (each bill triggers ~10–40 upstream calls in turn).
 *
 *  Bills are ordered by `bill_id` ASC for stable cursoring.
 *  Researcher edits are preserved per AC-52.50 even with `force: true`. */
async function handleBackfillBills(
  request: Request,
  env: ProxyEnv,
  ctx: AdminCtx,
): Promise<DispatchResult> {
  if (request.method !== 'POST') {
    return badRequest(ctx, 'method_not_allowed', 'POST only');
  }
  const d1 = env.D1_VOTER_INFO!;
  const url = new URL(request.url);
  const after = url.searchParams.get('after') ?? '';
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '3', 10) || 3, 1), 25);
  const result = await d1
    .prepare(
      'SELECT congress, type, number, bill_id FROM bills WHERE bill_id > ? ORDER BY bill_id ASC LIMIT ?',
    )
    .bind(after, limit)
    .all<{ congress: number; type: string; number: string; bill_id: string }>();
  const rows = result.results ?? [];
  const workerOrigin = `${url.protocol}//${url.host}`;
  const summary: Array<{ bill_id: string; ok: boolean; error?: string; cosponsors?: number; actions?: number }> = [];
  let ok = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const r = await importBillFromCongress(
        {
          congress: row.congress,
          type: row.type,
          number: row.number,
          force: true,
          actorEmail: ctx.email,
          traceId: ctx.traceId,
        },
        { env, workerOrigin },
      );
      summary.push({
        bill_id: row.bill_id,
        ok: true,
        cosponsors: r.cosponsors_imported,
        actions: r.actions_imported,
      });
      ok++;
    } catch (err) {
      summary.push({
        bill_id: row.bill_id,
        ok: false,
        error: (err as Error).message,
      });
      failed++;
    }
  }
  // If we filled the limit, there may be more; return the last bill_id
  // processed as the next cursor. Otherwise we're done.
  const nextAfter = rows.length === limit ? rows[rows.length - 1]!.bill_id : null;
  logEvent(
    { env: ctx.envName, traceId: ctx.traceId },
    {
      event: 'backfill_bills_chunk',
      level: 'info',
      actor: ctx.email,
      after,
      processed: rows.length,
      ok,
      failed,
      next_after: nextAfter,
    },
  );
  return ok_(ctx, {
    processed: rows.length,
    ok,
    failed,
    next_after: nextAfter,
    done: nextAfter === null,
    summary,
  });
}

// Local re-export with safer name; the existing `ok` helper above also
// returns DispatchResult, but TypeScript already saw it. Aliasing avoids the
// "ok already declared" trap if this file gains another inline ok().
function ok_(ctx: AdminCtx, body: unknown): DispatchResult {
  return ok(ctx, body);
}
