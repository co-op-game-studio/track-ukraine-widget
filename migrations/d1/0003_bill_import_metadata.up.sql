-- 0003_bill_import_metadata.up.sql
--
-- AC-52.49 — track per-row Congress.gov updateDate + last-time-we-asked
-- so the scaling-backoff cron and the admin "Refresh from Congress now"
-- button can decide whether a refetch is needed.

ALTER TABLE bills ADD COLUMN congress_update_date TEXT;
ALTER TABLE bills ADD COLUMN last_freshness_check_at TEXT;

ALTER TABLE votes ADD COLUMN congress_update_date TEXT;

-- Indexes to keep the cron's "next due" scan cheap as the corpus grows.
CREATE INDEX IF NOT EXISTS idx_bills_freshness
  ON bills(last_freshness_check_at);
