-- 0003 down — remove the freshness columns + index.

DROP INDEX IF EXISTS idx_bills_freshness;
ALTER TABLE bills DROP COLUMN last_freshness_check_at;
ALTER TABLE bills DROP COLUMN congress_update_date;
ALTER TABLE votes DROP COLUMN congress_update_date;
