-- D1 schema for the V4 researcher-driven backend.
-- Traces to FR-49, ADR-017, design.md §4.16.
--
-- Apply with:
--   wrangler d1 migrations apply --env <dev|uat|stg|prod>
--
-- Conventions:
--   - PKs are ULIDs (text, 26 chars) — see lib/ulid.ts.
--   - Timestamps are ISO-8601 strings (UTC).
--   - Foreign keys CASCADE on parent delete EXCEPT audit_log,
--     which must outlive the row it audits.
--   - Booleans are 0/1 (SQLite convention).

PRAGMA foreign_keys = ON;

CREATE TABLE researchers (
  email TEXT PRIMARY KEY,
  display_name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE bills (
  id TEXT PRIMARY KEY,
  bill_id TEXT UNIQUE NOT NULL,
  congress INTEGER NOT NULL,
  type TEXT NOT NULL,
  number TEXT NOT NULL,
  featured INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  title TEXT NOT NULL,
  latest_action TEXT,
  latest_action_date TEXT,
  became_law INTEGER NOT NULL DEFAULT 0,
  congress_gov_url TEXT,
  direction TEXT NOT NULL,
  direction_reason TEXT,
  summary_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE votes (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL,
  chamber TEXT NOT NULL,
  congress INTEGER NOT NULL,
  session INTEGER NOT NULL,
  roll_call INTEGER NOT NULL,
  date TEXT NOT NULL,
  url TEXT,
  action TEXT,
  action_date TEXT,
  weight REAL NOT NULL,
  direction_multiplier REAL NOT NULL DEFAULT 1,
  kind TEXT NOT NULL,
  weight_reason TEXT,                -- FR-54 AC-54.6: standing rationale; nullable
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (chamber, congress, session, roll_call),
  FOREIGN KEY (bill_id) REFERENCES bills (bill_id) ON DELETE CASCADE
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL,
  attached_to_roll_call_id TEXT,
  body_markdown TEXT NOT NULL,
  score_adjustment REAL NOT NULL DEFAULT 0,
  author_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (bill_id) REFERENCES bills (bill_id) ON DELETE CASCADE,
  FOREIGN KEY (author_email) REFERENCES researchers (email)
);

CREATE TABLE social_posts (
  id TEXT PRIMARY KEY,
  bioguide_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  url TEXT NOT NULL,
  posted_at TEXT,
  body_text TEXT NOT NULL,
  score_adjustment REAL NOT NULL DEFAULT 0,
  comment TEXT,
  author_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (author_email) REFERENCES researchers (email)
);

CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  bioguide_id TEXT NOT NULL,
  media_kind TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_label TEXT,
  quoted_at TEXT,
  body_text TEXT NOT NULL,
  score_adjustment REAL NOT NULL DEFAULT 0,
  comment TEXT,
  author_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (author_email) REFERENCES researchers (email)
);

CREATE TABLE score_adjustments (
  id TEXT PRIMARY KEY,
  bioguide_id TEXT NOT NULL,
  delta REAL NOT NULL,
  reason TEXT NOT NULL,
  author_email TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target_table TEXT NOT NULL,
  row_id TEXT NOT NULL,
  row_title TEXT,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  trace_id TEXT NOT NULL,            -- FR-50 AC-50.7: trace ID of the inbound
                                     -- request that produced this audit row.
  created_at TEXT NOT NULL
);

CREATE INDEX idx_votes_bill ON votes (bill_id);
CREATE INDEX idx_comments_bill ON comments (bill_id);
CREATE INDEX idx_social_posts_bioguide ON social_posts (bioguide_id);
CREATE INDEX idx_quotes_bioguide ON quotes (bioguide_id);
CREATE INDEX idx_audit_created ON audit_log (created_at DESC);
CREATE INDEX idx_audit_actor ON audit_log (actor_email, created_at DESC);
CREATE INDEX idx_audit_trace ON audit_log (trace_id);
