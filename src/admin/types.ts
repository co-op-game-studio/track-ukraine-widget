/** D1 row shapes returned by /api/admin/* — match proxy/d1/admin-store.ts. */

export interface BillRow {
  id: string;
  bill_id: string;
  congress: number;
  type: string;
  number: string;
  featured: number;
  label: string | null;
  title: string;
  /** AC-52.57 — researcher-curated short blurb. Falls back to `title`. */
  display_title: string | null;
  latest_action: string | null;
  latest_action_date: string | null;
  became_law: number;
  congress_gov_url: string | null;
  direction: string;
  direction_reason: string | null;
  summary_json: string | null;
  /** AC-52.58 — sponsor (denormalized; full cosponsor list in BillCosponsorRow). */
  sponsor_bioguide_id: string | null;
  sponsor_full_name: string | null;
  sponsor_party: string | null;
  sponsor_state: string | null;
  introduced_date: string | null;
  created_at: string;
  updated_at: string;
}

/** AC-52.58 — bill_cosponsors. */
export interface BillCosponsorRow {
  id: string;
  bill_id: string;
  bioguide_id: string;
  full_name: string;
  party: string | null;
  state: string | null;
  district: string | null;
  is_original_cosponsor: number;
  sponsorship_date: string | null;
  sponsorship_withdrawn_date: string | null;
  congress_update_date: string | null;
  created_at: string;
  updated_at: string;
}

/** AC-52.59 — bill_actions. */
export interface BillActionRow {
  id: string;
  bill_id: string;
  action_date: string | null;
  action_text: string | null;
  action_code: string | null;
  source_system: string | null;
  congressional_record_url: string | null;
  congressional_record_citation: string | null;
  recorded_chamber: string | null;
  recorded_roll_call: number | null;
  congress_update_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface VoteRow {
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
  direction_multiplier: number;
  kind: string;
  weight_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommentRow {
  id: string;
  bill_id: string;
  attached_to_roll_call_id: string | null;
  body_markdown: string;
  /** AC-52.38 — comments now compose with votes via weight + direction. */
  weight: number;
  direction: number;
  author_email: string;
  created_at: string;
  updated_at: string;
}

export interface SocialPostRow {
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

export interface QuoteRow {
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
  /** Optional ancillary links: JSON array of {label, url}. Migration 0008. */
  links_json: string | null;
  author_email: string;
  created_at: string;
  updated_at: string;
  /** Attached by the API on list/get; not stored on the quote row itself. */
  tags?: TagRow[];
}

/** A user-defined tag (Settings ▸ Tags). Migration 0008. */
export interface TagRow {
  id: string;
  slug: string;
  label: string;
  color: string;
  description: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
}

/** Per-handle poll status as returned by /api/admin/ingest/handle-status. */
export interface HandleStatusRow {
  handle_id: string;
  platform: string;
  handle: string;
  display_name: string | null;
  bioguide_id: string | null;
  last_polled_at: string | null;
  last_poll_attempted_at: string | null;
  last_poll_status: string | null;     // 'ok' | 'error' | null
  last_poll_error: string | null;
  last_poll_trace_id: string | null;
}

export interface AuditFullItem {
  id: string;
  actor_email: string;
  action: string;
  target_table: string;
  row_id: string;
  row_title: string | null;
  before: unknown | null;
  after: unknown | null;
  reason: string | null;
  trace_id: string;
  created_at: string;
}
