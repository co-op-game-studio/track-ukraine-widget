/**
 * Ingest store — D1 CRUD for the social-ingest infrastructure.
 *
 * Tables: mocs_social_handles, social_post_queue, social_keyword_watches.
 *
 * Traces: FR-59.
 */
import type { D1Like } from '../env';
import { newUlid } from '../../src/utils/ulid';
import { runMutationWithAudit, type MutationContext } from './admin-store';

/* -------------------------------------------------------------------------- */
/*                           Row shapes (read side)                           */
/* -------------------------------------------------------------------------- */

export interface SocialHandleRow {
  id: string;
  bioguide_id: string | null;
  entity_name: string | null;
  account_category: string;
  platform: string;
  account_kind: string;
  handle: string;
  platform_id: string;
  display_name: string | null;
  avatar_url: string | null;
  active_from: string;
  active_to: string | null;
  source: string | null;
  last_polled_at: string | null;
  last_seen_post_id: string | null;
  /** Migration 0008 — durable failure tracking. */
  last_poll_attempted_at: string | null;
  last_poll_status: string | null;          // 'ok' | 'error' | null
  last_poll_error: string | null;
  last_poll_trace_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface QueueRow {
  id: string;
  bioguide_id: string | null;
  platform: string;
  platform_post_id: string;
  author_handle: string;
  posted_at: string;
  url: string;
  body_text: string;
  media_refs_json: string;
  raw_payload_json: string;
  ingested_at: string;
  status: string;
  matched_keywords: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

export interface KeywordWatchRow {
  id: string;
  watch_name: string;
  pattern: string;
  is_regex: number;
  active: number;
  notify: number;
  created_by: string;
  created_at: string;
}

/* -------------------------------------------------------------------------- */
/*                               Handles CRUD                                 */
/* -------------------------------------------------------------------------- */

export async function listHandles(
  d1: D1Like,
  filters?: {
    bioguideId?: string;
    platform?: string;
    activeOnly?: boolean;
    accountCategory?: string;
  },
): Promise<SocialHandleRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters?.bioguideId) {
    clauses.push('bioguide_id = ?');
    params.push(filters.bioguideId);
  }
  if (filters?.platform) {
    clauses.push('platform = ?');
    params.push(filters.platform);
  }
  if (filters?.accountCategory) {
    clauses.push('account_category = ?');
    params.push(filters.accountCategory);
  }
  if (filters?.activeOnly !== false) {
    clauses.push('active_to IS NULL');
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const r = await d1
    .prepare(`SELECT * FROM mocs_social_handles${where} ORDER BY account_category, COALESCE(entity_name, display_name, handle), platform`)
    .bind(...params)
    .all<SocialHandleRow>();
  return r.results ?? [];
}

export async function upsertHandle(
  d1: D1Like,
  input: {
    bioguideId?: string | null;
    entityName?: string | null;
    accountCategory?: string;
    platform: string;
    accountKind?: string;
    handle: string;
    platformId: string;
    displayName?: string;
    avatarUrl?: string;
    source?: string;
  },
): Promise<SocialHandleRow> {
  const now = new Date().toISOString();
  const id = newUlid();
  const row: SocialHandleRow = {
    id,
    bioguide_id: input.bioguideId ?? null,
    entity_name: input.entityName ?? null,
    account_category: input.accountCategory ?? 'congress',
    platform: input.platform,
    account_kind: input.accountKind ?? 'official',
    handle: input.handle,
    platform_id: input.platformId,
    display_name: input.displayName ?? null,
    avatar_url: input.avatarUrl ?? null,
    active_from: now.slice(0, 10),
    active_to: null,
    source: input.source ?? null,
    last_polled_at: null,
    last_seen_post_id: null,
    last_poll_attempted_at: null,
    last_poll_status: null,
    last_poll_error: null,
    last_poll_trace_id: null,
    created_at: now,
    updated_at: now,
  };
  await d1
    .prepare(
      `INSERT INTO mocs_social_handles
        (id, bioguide_id, entity_name, account_category, platform, account_kind,
         handle, platform_id, display_name, avatar_url, active_from, active_to,
         source, last_polled_at, last_seen_post_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (platform, platform_id, active_from) DO UPDATE SET
         handle = excluded.handle,
         display_name = excluded.display_name,
         avatar_url = excluded.avatar_url,
         entity_name = excluded.entity_name,
         account_category = excluded.account_category,
         updated_at = excluded.updated_at`,
    )
    .bind(
      row.id, row.bioguide_id, row.entity_name, row.account_category,
      row.platform, row.account_kind,
      row.handle, row.platform_id, row.display_name, row.avatar_url,
      row.active_from, row.active_to, row.source,
      row.last_polled_at, row.last_seen_post_id, row.created_at, row.updated_at,
    )
    .run();
  return row;
}

export async function updateHandlePollState(
  d1: D1Like,
  id: string,
  lastPolledAt: string,
  lastSeenPostId: string | null,
): Promise<void> {
  await d1
    .prepare(
      `UPDATE mocs_social_handles
       SET last_polled_at = ?, last_seen_post_id = ?,
           last_poll_attempted_at = ?, last_poll_status = 'ok',
           last_poll_error = NULL, last_poll_trace_id = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(lastPolledAt, lastSeenPostId, lastPolledAt, null, new Date().toISOString(), id)
    .run();
}

/**
 * Record a FAILED poll attempt. Does NOT update last_polled_at — that stays
 * pinned to the last success so the staleness gate keeps retrying. The error
 * + trace ID are surfaced on the person profile and Settings ▸ Poll Status
 * so an operator can copy the trace ID and report.
 */
export async function recordHandlePollFailure(
  d1: D1Like,
  id: string,
  errorText: string,
  traceId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await d1
    .prepare(
      `UPDATE mocs_social_handles
       SET last_poll_attempted_at = ?, last_poll_status = 'error',
           last_poll_error = ?, last_poll_trace_id = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(now, errorText.slice(0, 1000), traceId, now, id)
    .run();
}

/** Set the trace ID for a poll attempt that's about to start. Lets the cron
 *  reuse the same correlator on retries even before the outcome is known. */
export async function setHandlePollTrace(
  d1: D1Like,
  id: string,
  traceId: string,
): Promise<void> {
  await d1
    .prepare('UPDATE mocs_social_handles SET last_poll_trace_id = ? WHERE id = ?')
    .bind(traceId, id)
    .run();
}

/** Update editable fields on a handle row. */
export async function updateHandle(
  d1: D1Like,
  id: string,
  fields: {
    handle?: string;
    platformId?: string;
    displayName?: string;
    entityName?: string;
    accountCategory?: string;
    platform?: string;
  },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (fields.handle !== undefined) { sets.push('handle = ?'); params.push(fields.handle); }
  if (fields.platformId !== undefined) { sets.push('platform_id = ?'); params.push(fields.platformId); }
  if (fields.displayName !== undefined) { sets.push('display_name = ?'); params.push(fields.displayName); }
  if (fields.entityName !== undefined) { sets.push('entity_name = ?'); params.push(fields.entityName); }
  if (fields.accountCategory !== undefined) { sets.push('account_category = ?'); params.push(fields.accountCategory); }
  if (fields.platform !== undefined) { sets.push('platform = ?'); params.push(fields.platform); }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  await d1
    .prepare(`UPDATE mocs_social_handles SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...params)
    .run();
}

/** Soft-delete: set active_to to today. */
export async function deactivateHandle(d1: D1Like, id: string): Promise<void> {
  const now = new Date().toISOString();
  await d1
    .prepare('UPDATE mocs_social_handles SET active_to = ?, updated_at = ? WHERE id = ?')
    .bind(now.slice(0, 10), now, id)
    .run();
}

/* -------------------------------------------------------------------------- */
/*                                Queue CRUD                                  */
/* -------------------------------------------------------------------------- */

/** Lookup a queue row by its (platform, platform_post_id) natural key — used
 *  by the curate-from-Research flow to recover the existing row when an
 *  enqueue collides with a previous ingestion. */
export async function findQueueByPlatformPostId(
  d1: D1Like,
  platform: string,
  platformPostId: string,
): Promise<QueueRow | null> {
  return d1
    .prepare('SELECT * FROM social_post_queue WHERE platform = ? AND platform_post_id = ? LIMIT 1')
    .bind(platform, platformPostId)
    .first<QueueRow>();
}

export async function enqueuePost(
  d1: D1Like,
  input: {
    bioguideId: string | null;
    platform: string;
    platformPostId: string;
    authorHandle: string;
    postedAt: string;
    url: string;
    bodyText: string;
    mediaRefsJson: string;
    rawPayloadJson: string;
    matchedKeywords?: string[];
    /**
     * FR-59 AC-59.22 — override the keyword-derived status. The poll loop
     * omits this so the store classifies the post: ≥1 matched keyword →
     * 'pending' (enters the curation feed), none → 'unrelated' (stored,
     * persistent, but outside the default feed). Manual/direct adds pass
     * 'pending' explicitly so human intent is never auto-reclassified.
     */
    status?: 'pending' | 'unrelated';
  },
): Promise<QueueRow | null> {
  const now = new Date().toISOString();
  const id = newUlid();
  // AC-59.20 / AC-59.21 — derive from keyword matches unless overridden.
  const status: 'pending' | 'unrelated' =
    input.status ?? (input.matchedKeywords?.length ? 'pending' : 'unrelated');
  const row: QueueRow = {
    id,
    bioguide_id: input.bioguideId,
    platform: input.platform,
    platform_post_id: input.platformPostId,
    author_handle: input.authorHandle,
    posted_at: input.postedAt,
    url: input.url,
    body_text: input.bodyText,
    media_refs_json: input.mediaRefsJson,
    raw_payload_json: input.rawPayloadJson,
    ingested_at: now,
    status,
    matched_keywords: input.matchedKeywords?.length
      ? JSON.stringify(input.matchedKeywords)
      : null,
    reviewed_by: null,
    reviewed_at: null,
  };
  try {
    await d1
      .prepare(
        `INSERT INTO social_post_queue
          (id, bioguide_id, platform, platform_post_id, author_handle,
           posted_at, url, body_text, media_refs_json, raw_payload_json,
           ingested_at, status, matched_keywords, reviewed_by, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id, row.bioguide_id, row.platform, row.platform_post_id,
        row.author_handle, row.posted_at, row.url, row.body_text,
        row.media_refs_json, row.raw_payload_json, row.ingested_at,
        row.status, row.matched_keywords, row.reviewed_by, row.reviewed_at,
      )
      .run();
    return row;
  } catch (e) {
    // UNIQUE constraint on (platform, platform_post_id) → already ingested.
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE|constraint/i.test(msg)) return null;
    throw e;
  }
}

export async function listQueue(
  d1: D1Like,
  filters?: {
    status?: string;
    platform?: string;
    bioguideId?: string;
    keywordMatch?: boolean;
    limit?: number;
    offset?: number;
  },
): Promise<{ items: QueueRow[]; total: number }> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters?.status) {
    clauses.push('status = ?');
    params.push(filters.status);
  }
  if (filters?.platform) {
    clauses.push('platform = ?');
    params.push(filters.platform);
  }
  if (filters?.bioguideId) {
    clauses.push('bioguide_id = ?');
    params.push(filters.bioguideId);
  }
  if (filters?.keywordMatch) {
    clauses.push('matched_keywords IS NOT NULL');
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;

  const countR = await d1
    .prepare(`SELECT COUNT(*) as cnt FROM social_post_queue${where}`)
    .bind(...params)
    .first<{ cnt: number }>();
  const total = countR?.cnt ?? 0;

  const r = await d1
    .prepare(
      `SELECT * FROM social_post_queue${where}
       ORDER BY posted_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(...params, limit, offset)
    .all<QueueRow>();

  return { items: r.results ?? [], total };
}

export async function updateQueueStatus(
  d1: D1Like,
  id: string,
  status: 'curated' | 'dismissed',
  reviewerEmail: string,
): Promise<void> {
  await d1
    .prepare(
      `UPDATE social_post_queue
       SET status = ?, reviewed_by = ?, reviewed_at = ?
       WHERE id = ?`,
    )
    .bind(status, reviewerEmail, new Date().toISOString(), id)
    .run();
}

/* -------------------------------------------------------------------------- */
/*                            Keyword watches CRUD                            */
/* -------------------------------------------------------------------------- */

export async function listKeywordWatches(
  d1: D1Like,
  activeOnly = true,
): Promise<KeywordWatchRow[]> {
  const where = activeOnly ? ' WHERE active = 1' : '';
  const r = await d1
    .prepare(`SELECT * FROM social_keyword_watches${where} ORDER BY watch_name`)
    .all<KeywordWatchRow>();
  return r.results ?? [];
}

export async function createKeywordWatch(
  d1: D1Like,
  ctx: MutationContext,
  input: {
    watchName: string;
    pattern: string;
    isRegex?: boolean;
    notify?: boolean;
  },
): Promise<KeywordWatchRow> {
  const now = new Date().toISOString();
  const id = newUlid();
  const row: KeywordWatchRow = {
    id,
    watch_name: input.watchName,
    pattern: input.pattern,
    is_regex: input.isRegex ? 1 : 0,
    active: 1,
    notify: input.notify !== false ? 1 : 0,
    created_by: ctx.actorEmail,
    created_at: now,
  };
  const stmt = d1
    .prepare(
      `INSERT INTO social_keyword_watches
        (id, watch_name, pattern, is_regex, active, notify, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.id, row.watch_name, row.pattern, row.is_regex, row.active, row.notify, row.created_by, row.created_at);
  await runMutationWithAudit(d1, ctx, stmt, {
    action: 'create',
    targetTable: 'social_keyword_watches',
    rowId: row.id,
    rowTitle: row.watch_name,
    before: null,
    after: row,
  });
  return row;
}

export async function toggleKeywordWatch(
  d1: D1Like,
  ctx: MutationContext,
  id: string,
  active: boolean,
): Promise<void> {
  const before = await d1
    .prepare('SELECT * FROM social_keyword_watches WHERE id = ?')
    .bind(id)
    .first<KeywordWatchRow>();
  const stmt = d1
    .prepare('UPDATE social_keyword_watches SET active = ? WHERE id = ?')
    .bind(active ? 1 : 0, id);
  await runMutationWithAudit(d1, ctx, stmt, {
    action: 'update',
    targetTable: 'social_keyword_watches',
    rowId: id,
    rowTitle: before?.watch_name ?? id,
    before,
    after: before ? { ...before, active: active ? 1 : 0 } : null,
  });
}
