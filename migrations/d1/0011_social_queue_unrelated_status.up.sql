-- v4.1.1 — FR-59 AC-59.23: keyword-relatedness classification of ingested posts.
--
-- The poll loop already matches each post body against active keyword watches
-- and stores hits in social_post_queue.matched_keywords, but historically every
-- row was enqueued status='pending' regardless of whether anything matched. As
-- of v4.1.1 the enqueue derives status: matched -> 'pending', no match ->
-- 'unrelated'. This migration reconciles pre-existing rows so old data agrees
-- with the new classification.
--
-- Scope guard: only reclassify rows that are still 'pending', have NO matched
-- keywords, and were NEVER reviewed. A curator may have already actioned an
-- old keyword-less row (curated/dismissed) — those carry a reviewed_at and are
-- left untouched. Idempotent: re-running affects nothing new.
--
-- No schema change: `status` has been a free TEXT column since 0005, and
-- idx_social_post_queue_status already supports cheap status filtering. We do
-- NOT add a CHECK constraint (D1/SQLite cannot ALTER ADD CONSTRAINT without a
-- full table rebuild; the application layer is the gatekeeper).
UPDATE social_post_queue
   SET status = 'unrelated'
 WHERE status = 'pending'
   AND matched_keywords IS NULL
   AND reviewed_at IS NULL;
