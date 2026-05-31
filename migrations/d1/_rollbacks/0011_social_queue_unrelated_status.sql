-- Rollback of 0011 — restore 'pending' for rows the up-migration reclassified.
--
-- We can only safely reverse rows that still read 'unrelated', have no matched
-- keywords, and were never reviewed (a curator may have re-touched some since
-- the up-migration; those carry reviewed_at and are left alone). Idempotent.
UPDATE social_post_queue
   SET status = 'pending'
 WHERE status = 'unrelated'
   AND matched_keywords IS NULL
   AND reviewed_at IS NULL;
