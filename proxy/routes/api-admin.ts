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
        ctx.email,
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
        ctx.email,
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
    const removed = await tagsStore.deleteTag(d1, id);
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
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 50, 1), 100) : 50;
  const items = await store.listAudit(env.D1_VOTER_INFO!, { limit, ...(since ? { since } : {}) });
  // Reshape to API contract — JSON-parse before/after so consumers don't double-parse.
  const reshaped = items.map((r) => ({
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
  return ok(ctx, { items: reshaped });
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
