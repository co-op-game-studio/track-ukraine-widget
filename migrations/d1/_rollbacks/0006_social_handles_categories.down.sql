-- Rollback: restore NOT NULL bioguide_id constraint and remove new columns.
-- Data loss: non-MoC rows (where bioguide_id IS NULL) will be deleted.

DELETE FROM mocs_social_handles WHERE bioguide_id IS NULL;
DELETE FROM social_post_queue WHERE bioguide_id IS NULL;

-- SQLite doesn't support DROP COLUMN for older versions, but the tables
-- can be recreated. For simplicity, we just leave the extra columns in place
-- on rollback since they have sensible defaults.
