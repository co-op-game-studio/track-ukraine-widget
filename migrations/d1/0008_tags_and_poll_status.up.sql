-- FR-59 + curation pipeline overhaul: tags as a first-class primitive,
-- per-handle poll status (success + failure history), quote ↔ tag join.
--
-- Tags are a shared categorization primitive. Quotes are the first consumer.
-- Future resources (bills, comments) can use the same join pattern instead of
-- inventing per-resource enums.

CREATE TABLE IF NOT EXISTS tags (
  id          TEXT PRIMARY KEY,        -- ulid
  slug        TEXT NOT NULL UNIQUE,    -- machine-readable kebab-case
  label       TEXT NOT NULL,           -- human-readable badge text
  color       TEXT NOT NULL,           -- hex like #ef4444 — drives badge bg
  description TEXT,                    -- optional admin note
  created_at  TEXT NOT NULL,
  created_by  TEXT,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT
);

CREATE INDEX IF NOT EXISTS idx_tags_slug ON tags(slug);

-- Many-to-many: a quote has 0..N tags; a tag belongs to 0..N quotes.
CREATE TABLE IF NOT EXISTS quote_tags (
  quote_id    TEXT NOT NULL,
  tag_id      TEXT NOT NULL,
  applied_at  TEXT NOT NULL,
  applied_by  TEXT,
  PRIMARY KEY (quote_id, tag_id),
  FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quote_tags_quote ON quote_tags(quote_id);
CREATE INDEX IF NOT EXISTS idx_quote_tags_tag ON quote_tags(tag_id);

-- Persistent per-handle poll status. Today only `last_polled_at` is stored,
-- which means a failure is invisible after the cron tick. Add the four below
-- so a failure is durable and surfaces on the person profile + Settings >
-- Poll Status, with a trace ID an operator can copy and report.
ALTER TABLE mocs_social_handles ADD COLUMN last_poll_attempted_at TEXT;
ALTER TABLE mocs_social_handles ADD COLUMN last_poll_status TEXT;
ALTER TABLE mocs_social_handles ADD COLUMN last_poll_error TEXT;
ALTER TABLE mocs_social_handles ADD COLUMN last_poll_trace_id TEXT;

-- Optional ancillary links on a quote (e.g. official statement page,
-- related coverage). Stored as JSON array of {label, url}.
ALTER TABLE quotes ADD COLUMN links_json TEXT;

-- Seed a few sensible default tags so the system has something visible
-- on first deploy. Operators can edit/delete via Settings > Tags.
INSERT OR IGNORE INTO tags (id, slug, label, color, description, created_at, updated_at)
VALUES
  ('01J0000000000000000TAG001', 'on-floor', 'On floor', '#3b82f6', 'Spoken on the House/Senate floor.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('01J0000000000000000TAG002', 'press', 'Press', '#8b5cf6', 'Press release or official statement.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('01J0000000000000000TAG003', 'social', 'Social', '#ec4899', 'Originated from a social-media post.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('01J0000000000000000TAG004', 'needs-review', 'Needs review', '#eab308', 'Researcher flagged for follow-up.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('01J0000000000000000TAG005', 'verified', 'Verified', '#22c55e', 'Source verified against the original.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
