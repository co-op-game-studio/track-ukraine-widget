-- Rollback: drop tag tables and the new handle/quote columns.
-- SQLite supports DROP COLUMN since 3.35 (D1 is current); we use it directly.

DROP TABLE IF EXISTS quote_tags;
DROP TABLE IF EXISTS tags;

ALTER TABLE mocs_social_handles DROP COLUMN last_poll_attempted_at;
ALTER TABLE mocs_social_handles DROP COLUMN last_poll_status;
ALTER TABLE mocs_social_handles DROP COLUMN last_poll_error;
ALTER TABLE mocs_social_handles DROP COLUMN last_poll_trace_id;

ALTER TABLE quotes DROP COLUMN links_json;
