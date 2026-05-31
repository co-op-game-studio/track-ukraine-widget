-- Rollback of 0013 — drop the durable members table. member:v1: / state-members:v1:
-- / name-index:v1: remain available via KV (routes fall back to KV when D1 empty),
-- and `publish-to-kv` (legacy upstream path) can still repopulate them.
DROP INDEX IF EXISTS idx_members_chamber;
DROP INDEX IF EXISTS idx_members_state;
DROP TABLE IF EXISTS members;
