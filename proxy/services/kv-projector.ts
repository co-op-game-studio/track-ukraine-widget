/**
 * Shared KV projector — D1 row → KV record shape.
 *
 * Used by:
 *   1. The legacy `scripts/publish-d1-to-kv.ts` warmer (manual / debug).
 *   2. The read-through fallthrough on /api/bills, /api/comments,
 *      /api/social-posts, /api/quotes (AC-52.51) — when KV misses, the
 *      Worker reads D1, projects via this module, writes back to KV.
 *
 * Pure functions, no I/O. Tests live next to the publish script's tests so
 * the existing snapshot fixtures keep working.
 *
 * Traces to AC-52.46, AC-52.51.
 */

/* -------------------------------------------------------------------------- */
/*                                D1 row shapes                                */
/* -------------------------------------------------------------------------- */

export interface D1Bill {
  id: string;
  bill_id: string;
  congress: number;
  type: string;
  number: string;
  featured: number;
  label: string | null;
  title: string;
  latest_action: string | null;
  latest_action_date: string | null;
  introduced_date?: string | null;
  became_law: number;
  congress_gov_url: string | null;
  direction: string;
  direction_reason: string | null;
  summary_json: string | null;
  congress_update_date?: string | null;
  last_freshness_check_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface D1Vote {
  id: string;
  bill_id: string;
  chamber: string;
  congress: number;
  session: number;
  roll_call: number;
  date: string;
  url: string | null;
  action: string | null;
  action_date: string | null;
  weight: number;
  /** FR-63 — explicit per-vote direction. Optional on the type for back-compat
   *  with any pre-migration row read; projector falls back to 'neutral'. */
  direction?: string | null;
  /** @deprecated FR-63 — kept for one release; no longer drives scoring. */
  direction_multiplier: number;
  kind: string;
  weight_reason?: string | null;
  congress_update_date?: string | null;
  created_at: string;
  updated_at: string;
}

export interface D1Comment {
  id: string;
  bill_id: string;
  attached_to_roll_call_id: string | null;
  body_markdown: string;
  weight: number;
  direction: number;
  author_email: string;
  created_at: string;
  updated_at: string;
}

export interface D1SocialPost {
  id: string;
  bioguide_id: string;
  platform: string;
  url: string;
  posted_at: string | null;
  body_text: string;
  weight: number;
  direction: number;
  comment: string | null;
  author_email: string;
  created_at: string;
  updated_at: string;
}

export interface D1Quote {
  id: string;
  bioguide_id: string;
  media_kind: string;
  source_url: string;
  source_label: string | null;
  quoted_at: string | null;
  body_text: string;
  weight: number;
  direction: number;
  comment: string | null;
  author_email: string;
  created_at: string;
  updated_at: string;
}

/* -------------------------------------------------------------------------- */
/*                              KV record shapes                               */
/* -------------------------------------------------------------------------- */

export interface BillKvRecord {
  billId: string;
  type: string;
  number: string;
  congress: number;
  title: string;
  shortTitle?: string | null;
  introducedDate: string | null;
  latestAction: string | null;
  latestActionDate: string | null;
  summary?: unknown;
  direction: string;
  weight: number;
  curatedRollCalls: Array<{
    chamber: string;
    congress: number;
    session: number;
    rollCall: number;
    date: string;
    weight: number;
    /** FR-63 — the vote's own Ukraine direction ('pro'|'anti'|'neutral'). */
    direction: string;
    /** @deprecated FR-63 — retained for one release. */
    directionMultiplier: number;
    kind: string;
  }>;
  generatedAt: string;
  schemaVersion: 1;
}

export interface CommentKvRecord {
  billId: string;
  comments: Array<{
    id: string;
    bodyMarkdown: string;
    weight: number;
    direction: number;
    attachedToRollCallId: string | null;
    authorEmail: string;
    createdAt: string;
    updatedAt: string;
  }>;
  generatedAt: string;
  schemaVersion: 1;
}

export interface SocialPostKvRecord {
  bioguideId: string;
  posts: Array<{
    id: string;
    platform: string;
    url: string;
    postedAt: string | null;
    bodyText: string;
    weight: number;
    direction: number;
    comment: string | null;
    authorEmail: string;
    createdAt: string;
  }>;
  generatedAt: string;
  schemaVersion: 1;
}

export interface QuoteKvRecord {
  bioguideId: string;
  quotes: Array<{
    id: string;
    mediaKind: string;
    sourceUrl: string;
    sourceLabel: string | null;
    quotedAt: string | null;
    bodyText: string;
    weight: number;
    direction: number;
    comment: string | null;
    authorEmail: string;
    createdAt: string;
  }>;
  generatedAt: string;
  schemaVersion: 1;
}

/* -------------------------------------------------------------------------- */
/*                              Pure projections                               */
/* -------------------------------------------------------------------------- */

export function projectBill(
  bill: D1Bill,
  votes: D1Vote[],
  generatedAt: string,
): BillKvRecord {
  const sortedVotes = [...votes].sort((a, b) => {
    if (a.chamber !== b.chamber) return a.chamber.localeCompare(b.chamber);
    if (a.congress !== b.congress) return a.congress - b.congress;
    if (a.session !== b.session) return a.session - b.session;
    return a.roll_call - b.roll_call;
  });
  const weightTotal = sortedVotes.reduce((acc, v) => acc + v.weight, 0);
  return {
    billId: bill.bill_id,
    type: bill.type,
    number: bill.number,
    congress: bill.congress,
    title: bill.title,
    shortTitle: bill.label ?? null,
    introducedDate: bill.introduced_date ?? null,
    latestAction: bill.latest_action,
    latestActionDate: bill.latest_action_date,
    summary: bill.summary_json ? JSON.parse(bill.summary_json) : null,
    direction: bill.direction,
    weight: weightTotal,
    curatedRollCalls: sortedVotes.map((v) => ({
      chamber: v.chamber,
      congress: v.congress,
      session: v.session,
      rollCall: v.roll_call,
      date: v.date,
      weight: v.weight,
      direction: v.direction ?? 'neutral',
      directionMultiplier: v.direction_multiplier,
      kind: v.kind,
    })),
    generatedAt,
    schemaVersion: 1,
  };
}

export function projectComments(
  billId: string,
  comments: D1Comment[],
  generatedAt: string,
): CommentKvRecord {
  const sorted = [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return {
    billId,
    comments: sorted.map((c) => ({
      id: c.id,
      bodyMarkdown: c.body_markdown,
      weight: c.weight,
      direction: c.direction,
      attachedToRollCallId: c.attached_to_roll_call_id,
      authorEmail: c.author_email,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    })),
    generatedAt,
    schemaVersion: 1,
  };
}

export function projectSocialPosts(
  bioguideId: string,
  posts: D1SocialPost[],
  generatedAt: string,
): SocialPostKvRecord {
  const sorted = [...posts].sort((a, b) => {
    const ap = a.posted_at ?? a.created_at;
    const bp = b.posted_at ?? b.created_at;
    return bp.localeCompare(ap);
  });
  return {
    bioguideId,
    posts: sorted.map((p) => ({
      id: p.id,
      platform: p.platform,
      url: p.url,
      postedAt: p.posted_at,
      bodyText: p.body_text,
      weight: p.weight,
      direction: p.direction,
      comment: p.comment,
      authorEmail: p.author_email,
      createdAt: p.created_at,
    })),
    generatedAt,
    schemaVersion: 1,
  };
}

export function projectQuotes(
  bioguideId: string,
  quotes: D1Quote[],
  generatedAt: string,
): QuoteKvRecord {
  const sorted = [...quotes].sort((a, b) => {
    const ap = a.quoted_at ?? a.created_at;
    const bp = b.quoted_at ?? b.created_at;
    return bp.localeCompare(ap);
  });
  return {
    bioguideId,
    quotes: sorted.map((q) => ({
      id: q.id,
      mediaKind: q.media_kind,
      sourceUrl: q.source_url,
      sourceLabel: q.source_label,
      quotedAt: q.quoted_at,
      bodyText: q.body_text,
      weight: q.weight,
      direction: q.direction,
      comment: q.comment,
      authorEmail: q.author_email,
      createdAt: q.created_at,
    })),
    generatedAt,
    schemaVersion: 1,
  };
}

/** AC-52.47 — KV key naming. Single source of truth. */
export const KV_KEY = {
  bill: (billId: string) => `bill:v1:${billId}`,
  comments: (billId: string) => `comment:v1:${billId}`,
  socialPosts: (bioguideId: string) => `social-post:v1:${bioguideId}`,
  quotes: (bioguideId: string) => `quote:v1:${bioguideId}`,
} as const;
