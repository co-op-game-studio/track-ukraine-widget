-- 0004 backout.
DROP INDEX IF EXISTS idx_bill_actions_bill_date;
DROP INDEX IF EXISTS idx_bill_actions_bill;
DROP TABLE IF EXISTS bill_actions;
DROP INDEX IF EXISTS idx_bill_cosponsors_bill;
DROP TABLE IF EXISTS bill_cosponsors;
ALTER TABLE bills DROP COLUMN introduced_date;
ALTER TABLE bills DROP COLUMN sponsor_state;
ALTER TABLE bills DROP COLUMN sponsor_party;
ALTER TABLE bills DROP COLUMN sponsor_full_name;
ALTER TABLE bills DROP COLUMN sponsor_bioguide_id;
ALTER TABLE bills DROP COLUMN display_title;
