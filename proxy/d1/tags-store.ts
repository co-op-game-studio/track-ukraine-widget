/**
 * Tags store — typed CRUD over the `tags` and `quote_tags` join.
 *
 * Tags are a shared categorization primitive (Settings ▸ Tags). Quotes are the
 * first consumer; future resources can use the same join pattern instead of
 * inventing per-resource enums.
 *
 * All writes record actor + timestamps; deletes cascade via FK to quote_tags.
 * Audit events flow through the existing audit_log table via runMutationWithAudit
 * — same pattern as bills/quotes/comments.
 *
 * Traces to the curation pipeline overhaul (FR-59 successor work).
 */
import type { D1Like } from '../env';
import type { TagRow, MutationContext } from './admin-store';
import { runMutationWithAudit } from './admin-store';
import { newUlid } from '../../src/utils/ulid';

export interface TagCreateInput {
  slug: string;
  label: string;
  color: string;
  description?: string | null;
}

export interface TagUpdateInput {
  slug?: string;
  label?: string;
  color?: string;
  description?: string | null;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function validateColor(color: string): void {
  if (!HEX_RE.test(color)) {
    throw new Error(`invalid_color: must be a 6-digit hex like #ef4444 (got ${color})`);
  }
}

function validateSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`invalid_slug: must be lowercase kebab-case, 1-64 chars (got ${slug})`);
  }
}

export async function listTags(d1: D1Like): Promise<TagRow[]> {
  const r = await d1
    .prepare('SELECT * FROM tags ORDER BY label')
    .all<TagRow>();
  return r.results ?? [];
}

export async function getTag(d1: D1Like, id: string): Promise<TagRow | null> {
  return d1.prepare('SELECT * FROM tags WHERE id = ?').bind(id).first<TagRow>();
}

export async function createTag(
  d1: D1Like,
  input: TagCreateInput,
  ctx: MutationContext,
): Promise<TagRow> {
  validateSlug(input.slug);
  validateColor(input.color);
  if (!input.label.trim()) throw new Error('invalid_label: label is required');

  const now = new Date().toISOString();
  const row: TagRow = {
    id: newUlid(),
    slug: input.slug,
    label: input.label.trim(),
    color: input.color,
    description: input.description?.trim() || null,
    created_at: now,
    created_by: ctx.actorEmail,
    updated_at: now,
    updated_by: ctx.actorEmail,
  };
  const stmt = d1
    .prepare(
      `INSERT INTO tags (id, slug, label, color, description, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.id, row.slug, row.label, row.color, row.description, row.created_at, row.created_by, row.updated_at, row.updated_by);
  await runMutationWithAudit(d1, ctx, stmt, {
    action: 'create',
    targetTable: 'tags',
    rowId: row.id,
    rowTitle: row.label,
    before: null,
    after: row,
  });
  return row;
}

export async function updateTag(
  d1: D1Like,
  id: string,
  patch: TagUpdateInput,
  ctx: MutationContext,
): Promise<TagRow | null> {
  const before = await getTag(d1, id);
  if (!before) return null;

  const next = {
    slug: patch.slug ?? before.slug,
    label: patch.label ?? before.label,
    color: patch.color ?? before.color,
    description: patch.description !== undefined ? patch.description : before.description,
  };
  validateSlug(next.slug);
  validateColor(next.color);
  if (!next.label.trim()) throw new Error('invalid_label: label is required');

  const now = new Date().toISOString();
  const after: TagRow = { ...before, ...next, label: next.label.trim(), description: next.description?.trim() || null, updated_at: now, updated_by: ctx.actorEmail };
  const stmt = d1
    .prepare(
      `UPDATE tags SET slug = ?, label = ?, color = ?, description = ?, updated_at = ?, updated_by = ?
       WHERE id = ?`,
    )
    .bind(after.slug, after.label, after.color, after.description, after.updated_at, after.updated_by, id);
  await runMutationWithAudit(d1, ctx, stmt, {
    action: 'update',
    targetTable: 'tags',
    rowId: id,
    rowTitle: after.label,
    before,
    after,
  });
  return after;
}

export async function deleteTag(d1: D1Like, id: string, ctx: MutationContext): Promise<boolean> {
  const before = await getTag(d1, id);
  if (!before) return false;
  const stmt = d1.prepare('DELETE FROM tags WHERE id = ?').bind(id);
  // FK ON DELETE CASCADE wipes quote_tags.
  await runMutationWithAudit(d1, ctx, stmt, {
    action: 'delete',
    targetTable: 'tags',
    rowId: id,
    rowTitle: before.label,
    before,
    after: null,
  });
  return true;
}

/** All tags applied to a given quote, joined for display. */
export async function listTagsForQuote(d1: D1Like, quoteId: string): Promise<TagRow[]> {
  const r = await d1
    .prepare(
      `SELECT t.* FROM tags t
       INNER JOIN quote_tags qt ON qt.tag_id = t.id
       WHERE qt.quote_id = ?
       ORDER BY t.label`,
    )
    .bind(quoteId)
    .all<TagRow>();
  return r.results ?? [];
}

/** Bulk version: returns map of quote_id -> TagRow[] for a list of quotes. */
export async function listTagsForQuotes(
  d1: D1Like,
  quoteIds: string[],
): Promise<Map<string, TagRow[]>> {
  const map = new Map<string, TagRow[]>();
  if (quoteIds.length === 0) return map;
  const placeholders = quoteIds.map(() => '?').join(',');
  const r = await d1
    .prepare(
      `SELECT qt.quote_id, t.* FROM tags t
       INNER JOIN quote_tags qt ON qt.tag_id = t.id
       WHERE qt.quote_id IN (${placeholders})
       ORDER BY t.label`,
    )
    .bind(...quoteIds)
    .all<TagRow & { quote_id: string }>();
  for (const row of (r.results ?? [])) {
    const { quote_id, ...tag } = row;
    const list = map.get(quote_id) ?? [];
    list.push(tag as TagRow);
    map.set(quote_id, list);
  }
  return map;
}

/** Replace the full tag set for a quote. Used by edit flow. */
export async function setQuoteTags(
  d1: D1Like,
  quoteId: string,
  tagIds: string[],
  actorEmail: string,
): Promise<void> {
  await d1.prepare('DELETE FROM quote_tags WHERE quote_id = ?').bind(quoteId).run();
  if (tagIds.length === 0) return;
  const now = new Date().toISOString();
  for (const tagId of tagIds) {
    try {
      await d1
        .prepare(
          `INSERT OR IGNORE INTO quote_tags (quote_id, tag_id, applied_at, applied_by)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(quoteId, tagId, now, actorEmail)
        .run();
    } catch {
      // Tag may have been deleted; skip.
    }
  }
}
