-- v4.1.2 — FR-32 AC-32.36: durable per-member roll-call casts in D1.
--
-- Member casts (who voted Yea/Nay on each curated roll-call) previously lived
-- ONLY in KV roll-call-roster:v1:* records, populated by an ops warmer from
-- upstream. That is not durable — a KV wipe loses them. This table is the
-- durable source of truth, seeded by `lw rosters seed` from the curated
-- `votes` roll-calls; the /api/roll-call-rosters route serves from here and
-- caches to KV (AC-32.37). Immutable after a session closes.
--
-- House rows carry bioguide_id (Congress.gov house-vote members have it).
-- Senate rows carry last_name + state (Senate.gov XML has no bioguide), per
-- the two roster cast shapes the widget already consumes.
CREATE TABLE IF NOT EXISTS vote_casts (
  id            TEXT PRIMARY KEY,
  chamber       TEXT NOT NULL,            -- 'House' | 'Senate' (matches votes.chamber)
  congress      INTEGER NOT NULL,
  session       INTEGER NOT NULL,
  roll_call     INTEGER NOT NULL,
  bioguide_id   TEXT,                     -- House key; NULL for Senate
  last_name     TEXT,                     -- Senate key; NULL for House
  first_name    TEXT,
  state         TEXT,
  party         TEXT,
  cast          TEXT NOT NULL,            -- raw upstream cast (Yea/Nay/Present/Not Voting/…)
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  -- Idempotent re-seed: one row per (roll-call, member-key).
  UNIQUE (chamber, congress, session, roll_call, bioguide_id, last_name, state)
);

CREATE INDEX IF NOT EXISTS idx_vote_casts_roll_call
  ON vote_casts (chamber, congress, session, roll_call);
CREATE INDEX IF NOT EXISTS idx_vote_casts_member
  ON vote_casts (bioguide_id);
