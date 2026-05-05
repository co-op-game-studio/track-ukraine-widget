-- 0004 — bill display_title + cosponsors + actions tables.
--
-- AC-52.57 — researcher-curated short blurb for the bills list.
-- AC-52.58 — sponsor + cosponsors persisted from /v3/bill/.../cosponsors.
-- AC-52.59 — full action list persisted from /v3/bill/.../actions, with
--            optional Congressional Record link surfaced where present.

-- ── Bills delta ──────────────────────────────────────────────────────────
ALTER TABLE bills ADD COLUMN display_title TEXT;
ALTER TABLE bills ADD COLUMN sponsor_bioguide_id TEXT;
ALTER TABLE bills ADD COLUMN sponsor_full_name TEXT;
ALTER TABLE bills ADD COLUMN sponsor_party TEXT;
ALTER TABLE bills ADD COLUMN sponsor_state TEXT;
ALTER TABLE bills ADD COLUMN introduced_date TEXT;

-- ── Cosponsors ───────────────────────────────────────────────────────────
CREATE TABLE bill_cosponsors (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(bill_id) ON DELETE CASCADE,
  bioguide_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  party TEXT,
  state TEXT,
  district TEXT,
  is_original_cosponsor INTEGER NOT NULL DEFAULT 0,  -- 0|1
  sponsorship_date TEXT,
  sponsorship_withdrawn_date TEXT,
  congress_update_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (bill_id, bioguide_id)
);
CREATE INDEX IF NOT EXISTS idx_bill_cosponsors_bill ON bill_cosponsors(bill_id);

-- ── Actions ──────────────────────────────────────────────────────────────
-- One row per action on the bill. We persist the full list so the freshness
-- cron can compare counts + dates and the SPA can surface Congressional
-- Record references inline. Roll-call references stay denormalized on
-- `votes`; this table is the broader action stream.
CREATE TABLE bill_actions (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(bill_id) ON DELETE CASCADE,
  action_date TEXT,
  action_text TEXT,
  action_code TEXT,
  -- Source system attribution from Congress.gov (e.g. "House floor actions",
  -- "Senate", "Library of Congress").
  source_system TEXT,
  -- If the action references the Congressional Record, surface its URL +
  -- citation so the SPA can show "↗ See in Congressional Record".
  congressional_record_url TEXT,
  congressional_record_citation TEXT,
  -- For actions that produced a recorded vote, the chamber + roll number
  -- so the SPA can correlate without joining strings.
  recorded_chamber TEXT,
  recorded_roll_call INTEGER,
  congress_update_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bill_actions_bill ON bill_actions(bill_id);
CREATE INDEX IF NOT EXISTS idx_bill_actions_bill_date ON bill_actions(bill_id, action_date);
