-- FR-59: Social ingest infrastructure — roster, queue, keyword watches.

CREATE TABLE IF NOT EXISTS mocs_social_handles (
  id              TEXT PRIMARY KEY,
  bioguide_id     TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_mocs_social_handles_bioguide
  ON mocs_social_handles (bioguide_id);
CREATE INDEX IF NOT EXISTS idx_mocs_social_handles_platform
  ON mocs_social_handles (platform, active_to);

CREATE TABLE IF NOT EXISTS social_post_queue (
  id                TEXT PRIMARY KEY,
  bioguide_id       TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_social_post_queue_status
  ON social_post_queue (status, ingested_at);
CREATE INDEX IF NOT EXISTS idx_social_post_queue_bioguide
  ON social_post_queue (bioguide_id, posted_at);

CREATE TABLE IF NOT EXISTS social_keyword_watches (
  id          TEXT PRIMARY KEY,
  watch_name  TEXT NOT NULL,
  pattern     TEXT NOT NULL,
  is_regex    INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  notify      INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
