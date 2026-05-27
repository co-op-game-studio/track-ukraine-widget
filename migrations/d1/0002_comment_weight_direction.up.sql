-- 0002_comment_weight_direction.up.sql
--
-- AC-52.38 / AC-52.39 — replace `score_adjustment REAL` on comments,
-- social_posts, and quotes with `weight REAL` + `direction INTEGER` so they
-- compose with `votes.weight` + `votes.direction_multiplier` in the score
-- formula (AC-52.44).
--
-- Mapping per AC-52.39: direction = sign(score_adjustment),
--                       weight    = MIN(5, ABS(score_adjustment) * 5).
--
-- D1 (SQLite ≥ 3.35) supports ALTER TABLE … DROP COLUMN. If a future runtime
-- regresses, fall back to the table-rebuild dance: CREATE comments_new,
-- INSERT … SELECT, DROP comments, RENAME.

-- comments
ALTER TABLE comments ADD COLUMN weight REAL NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN direction INTEGER NOT NULL DEFAULT 0;
UPDATE comments
   SET direction = CASE
                     WHEN score_adjustment > 0 THEN 1
                     WHEN score_adjustment < 0 THEN -1
                     ELSE 0
                   END,
       weight    = CASE
                     WHEN ABS(score_adjustment) * 5 > 5 THEN 5
                     ELSE ABS(score_adjustment) * 5
                   END;
ALTER TABLE comments DROP COLUMN score_adjustment;

-- social_posts
ALTER TABLE social_posts ADD COLUMN weight REAL NOT NULL DEFAULT 0;
ALTER TABLE social_posts ADD COLUMN direction INTEGER NOT NULL DEFAULT 0;
UPDATE social_posts
   SET direction = CASE
                     WHEN score_adjustment > 0 THEN 1
                     WHEN score_adjustment < 0 THEN -1
                     ELSE 0
                   END,
       weight    = CASE
                     WHEN ABS(score_adjustment) * 5 > 5 THEN 5
                     ELSE ABS(score_adjustment) * 5
                   END;
ALTER TABLE social_posts DROP COLUMN score_adjustment;

-- quotes
ALTER TABLE quotes ADD COLUMN weight REAL NOT NULL DEFAULT 0;
ALTER TABLE quotes ADD COLUMN direction INTEGER NOT NULL DEFAULT 0;
UPDATE quotes
   SET direction = CASE
                     WHEN score_adjustment > 0 THEN 1
                     WHEN score_adjustment < 0 THEN -1
                     ELSE 0
                   END,
       weight    = CASE
                     WHEN ABS(score_adjustment) * 5 > 5 THEN 5
                     ELSE ABS(score_adjustment) * 5
                   END;
ALTER TABLE quotes DROP COLUMN score_adjustment;
