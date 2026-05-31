-- Rollback of 0012 — drop the durable vote_casts table. Casts remain
-- available via KV rosters (the route falls back to KV when D1 is empty).
DROP INDEX IF EXISTS idx_vote_casts_member;
DROP INDEX IF EXISTS idx_vote_casts_roll_call;
DROP TABLE IF EXISTS vote_casts;
