-- v4.3.0 — FR-63 / ADR-021: explicit per-vote direction (replaces inversion).
--
-- Each vote gets its OWN direction ('pro' | 'anti' | 'neutral') meaning
-- "an Aye on this vote is pro/anti/neutral toward Ukraine". Scoring reads this
-- directly and no longer derives it from bills.direction × direction_multiplier.
--
-- Step 1 here is the SCORE-PRESERVING backfill: derive `direction` from the
-- legacy (bills.direction, votes.direction_multiplier) pair so every member's
-- score is unchanged immediately after this migration (proven equivalent by the
-- AC-63.4 test in tests/unit/valence.test.ts). Step 2 (a researcher re-review of
-- every vote, where scores may intentionally change) happens in the admin UI,
-- not in this migration.
--
-- `direction_multiplier` is kept (deprecated, no longer read) for one release so
-- a rollback is possible; a later migration drops it (AC-63.2).

-- New columns. SQLite/D1 ALTER ADD COLUMN can't carry a CHECK that references a
-- subquery, but a plain enum-default column is fine; the app + a later tightening
-- migration enforce the {pro,anti,neutral} domain. Default 'neutral' is the safe
-- no-op direction for any row the backfill below somehow misses.
ALTER TABLE votes ADD COLUMN direction TEXT NOT NULL DEFAULT 'neutral';
ALTER TABLE votes ADD COLUMN direction_reviewed_at TEXT;   -- set when a researcher confirms
ALTER TABLE votes ADD COLUMN direction_reviewed_by TEXT;   -- actor email of the confirmer

-- AC-63.1 conversion table, applied as four targeted UPDATEs joined to bills.
-- (dm = 0 → 'neutral' is already the column default, so no UPDATE needed.)

-- pro bill, dm=+1  → pro      |  anti bill, dm=-1 → pro
UPDATE votes SET direction = 'pro'
WHERE direction_multiplier <> 0
  AND bill_id IN (SELECT bill_id FROM bills WHERE direction = 'pro-ukraine')
  AND direction_multiplier = 1;
UPDATE votes SET direction = 'pro'
WHERE direction_multiplier <> 0
  AND bill_id IN (SELECT bill_id FROM bills WHERE direction = 'anti-ukraine')
  AND direction_multiplier = -1;

-- pro bill, dm=-1  → anti     |  anti bill, dm=+1 → anti     |  neutral bill, dm=-1 → anti
UPDATE votes SET direction = 'anti'
WHERE direction_multiplier <> 0
  AND bill_id IN (SELECT bill_id FROM bills WHERE direction = 'pro-ukraine')
  AND direction_multiplier = -1;
UPDATE votes SET direction = 'anti'
WHERE direction_multiplier <> 0
  AND bill_id IN (SELECT bill_id FROM bills WHERE direction = 'anti-ukraine')
  AND direction_multiplier = 1;
UPDATE votes SET direction = 'anti'
WHERE direction_multiplier <> 0
  AND bill_id IN (SELECT bill_id FROM bills WHERE direction = 'neutral')
  AND direction_multiplier = -1;

-- neutral bill, dm=+1 → neutral (matches legacy: +1 on a neutral bill was a
-- no-op/unstated). Already 'neutral' by default; explicit for clarity/idempotency.
UPDATE votes SET direction = 'neutral'
WHERE direction_multiplier <> 0
  AND bill_id IN (SELECT bill_id FROM bills WHERE direction = 'neutral')
  AND direction_multiplier = 1;
