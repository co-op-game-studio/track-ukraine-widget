-- FR-59: Expand social handles for non-MoC accounts (influencers, journalists, etc.)

-- Allow bioguide_id to be nullable for non-MoC accounts.
-- SQLite doesn't support ALTER COLUMN, so we recreate the table.
-- Since this is early in the lifecycle, the table is empty or near-empty.

CREATE TABLE IF NOT EXISTS mocs_social_handles_new (
  id              TEXT PRIMARY KEY,
  bioguide_id     TEXT,           -- NULL for non-MoC accounts
  entity_name     TEXT,           -- Display name for non-MoC (e.g. "Jake Sullivan")
  account_category TEXT NOT NULL DEFAULT 'congress',  -- congress, influencer, journalist, bureaucrat, thinktank, ngo, foreign_official, military, other
  platform        TEXT NOT NULL,
  account_kind    TEXT NOT NULL DEFAULT 'official',
  handle          TEXT NOT NULL,
  platform_id     TEXT NOT NULL,
  display_name    TEXT,
  avatar_url      TEXT,
  active_from     TEXT NOT NULL,
  active_to       TEXT,
  source          TEXT,
  last_polled_at  TEXT,
  last_seen_post_id TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (platform, platform_id, active_from)
);

-- Copy existing data
INSERT INTO mocs_social_handles_new
  SELECT id, bioguide_id, display_name, 'congress', platform, account_kind,
         handle, platform_id, display_name, avatar_url, active_from, active_to,
         source, last_polled_at, last_seen_post_id, created_at, updated_at
  FROM mocs_social_handles;

DROP TABLE mocs_social_handles;
ALTER TABLE mocs_social_handles_new RENAME TO mocs_social_handles;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_mocs_social_handles_bioguide
  ON mocs_social_handles (bioguide_id);
CREATE INDEX IF NOT EXISTS idx_mocs_social_handles_platform
  ON mocs_social_handles (platform, active_to);
CREATE INDEX IF NOT EXISTS idx_mocs_social_handles_category
  ON mocs_social_handles (account_category);

-- Also expand social_post_queue to allow nullable bioguide_id
CREATE TABLE IF NOT EXISTS social_post_queue_new (
  id                TEXT PRIMARY KEY,
  bioguide_id       TEXT,            -- NULL for non-MoC posts
  platform          TEXT NOT NULL,
  platform_post_id  TEXT NOT NULL,
  author_handle     TEXT NOT NULL,
  posted_at         TEXT NOT NULL,
  url               TEXT NOT NULL,
  body_text         TEXT NOT NULL,
  media_refs_json   TEXT NOT NULL DEFAULT '[]',
  raw_payload_json  TEXT NOT NULL DEFAULT '{}',
  ingested_at       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  matched_keywords  TEXT,
  reviewed_by       TEXT,
  reviewed_at       TEXT,
  UNIQUE (platform, platform_post_id)
);

INSERT INTO social_post_queue_new SELECT * FROM social_post_queue;
DROP TABLE social_post_queue;
ALTER TABLE social_post_queue_new RENAME TO social_post_queue;

CREATE INDEX IF NOT EXISTS idx_social_post_queue_status
  ON social_post_queue (status, ingested_at);
CREATE INDEX IF NOT EXISTS idx_social_post_queue_bioguide
  ON social_post_queue (bioguide_id, posted_at);
