-- 0002_comment_weight_direction.down.sql — backout for 0002.up.

ALTER TABLE comments ADD COLUMN score_adjustment REAL NOT NULL DEFAULT 0;
UPDATE comments SET score_adjustment = direction * weight / 5.0;
ALTER TABLE comments DROP COLUMN weight;
ALTER TABLE comments DROP COLUMN direction;

ALTER TABLE social_posts ADD COLUMN score_adjustment REAL NOT NULL DEFAULT 0;
UPDATE social_posts SET score_adjustment = direction * weight / 5.0;
ALTER TABLE social_posts DROP COLUMN weight;
ALTER TABLE social_posts DROP COLUMN direction;

ALTER TABLE quotes ADD COLUMN score_adjustment REAL NOT NULL DEFAULT 0;
UPDATE quotes SET score_adjustment = direction * weight / 5.0;
ALTER TABLE quotes DROP COLUMN weight;
ALTER TABLE quotes DROP COLUMN direction;
