-- v4.1.2 — FR-32 AC-32.39: durable member identity in D1.
--
-- Member profiles (member:v1:*), the per-state roster (state-members:v1:*), and
-- the name-search index (name-index:v1:*) were the last KV-only, upstream-sourced
-- data — a KV wipe lost them, regenerable only by re-hitting Congress.gov. This
-- single table is the durable source of truth for all three: `lw members seed`
-- populates it from upstream, and `lw kv publish` projects the three KV prefixes
-- from it (no upstream fetch at publish time).
--
-- One row per current-Congress member. Carries everything the three projections
-- need: identity + chamber/state/district/party, photo/website, year_entered,
-- non-voting flag, socials (JSON), sponsored/cosponsored legislation (JSON), the
-- normalized search_key for name-index sharding, and the freshness columns that
-- mirror the bills-seed gate (congress_update_date).
CREATE TABLE IF NOT EXISTS members (
  bioguide_id             TEXT PRIMARY KEY,
  first                   TEXT NOT NULL,
  last                    TEXT NOT NULL,
  official_name           TEXT NOT NULL,
  state                   TEXT NOT NULL,         -- two-letter code
  chamber                 TEXT NOT NULL,         -- 'House' | 'Senate'
  district                INTEGER,               -- NULL for Senators
  party                   TEXT NOT NULL,         -- single-letter code (D/R/I/…)
  photo_url               TEXT,
  website                 TEXT,
  search_key              TEXT NOT NULL,         -- normalizeSearchKey("first last")
  year_entered            INTEGER,               -- earliest term.startYear
  is_non_voting           INTEGER NOT NULL DEFAULT 0,
  socials_json            TEXT,                  -- {twitter?,youtube?,…} or NULL
  sponsored_json          TEXT NOT NULL DEFAULT '[]',
  cosponsored_json        TEXT NOT NULL DEFAULT '[]',
  congress_update_date    TEXT,                  -- upstream member.updateDate (freshness gate)
  last_freshness_check_at TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_members_state ON members (state);
CREATE INDEX IF NOT EXISTS idx_members_chamber ON members (chamber);
