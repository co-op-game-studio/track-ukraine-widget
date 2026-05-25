-- v4.1.0 — AC-59.7 direction corrections.
--
-- Two bills in the curated seed were classified `anti-ukraine` but are
-- oversight bills, not aid-blockers. Fixing the direction here so the
-- score computation stops treating an "establish a Special Inspector
-- General" sponsorship as an anti-Ukraine signal. Same posture as
-- 118-HR-855 (per `docs/curated-bills-v0.1.0.md` v0.1.1, which moved
-- "Independent and Objective Oversight of Ukrainian Assistance Act"
-- to pro-ukraine — for these two we settle on `neutral` since they
-- frame purely as accountability without a clear pro-stance).
--
-- Audit rows accompany each UPDATE so the change is visible in the
-- audit feed. Both rows share trace_id `tr_v4_1_0_release` to
-- correlate.

UPDATE bills
SET direction = 'neutral',
    direction_reason = 'AC-59.7 — oversight/SIG bill, not aid-blocking. Reclassified from anti-ukraine.',
    updated_at = CURRENT_TIMESTAMP
WHERE bill_id = '118-HR-2445' AND direction = 'anti-ukraine';

UPDATE bills
SET direction = 'neutral',
    direction_reason = 'AC-59.7 — oversight bill, not aid-blocking. Reclassified from anti-ukraine.',
    updated_at = CURRENT_TIMESTAMP
WHERE bill_id = '118-S-2552' AND direction = 'anti-ukraine';

-- INSERT OR IGNORE so the migration is safe to re-run (CI retry, multi-env
-- apply, hand-replay). PK conflict on `id` is silently swallowed.
INSERT OR IGNORE INTO audit_log (
  id, actor_email, action, target_table, row_id, row_title,
  before_json, after_json, reason, trace_id, created_at
) VALUES (
  'audit_v4_1_0_hr2445',
  'v4.1.0@release',
  'direction_corrected',
  'bills',
  '118-HR-2445',
  'Special Inspector General for Ukraine Assistance Act',
  '{"direction":"anti-ukraine"}',
  '{"direction":"neutral"}',
  'AC-59.7',
  'tr_v4_1_0_release',
  CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO audit_log (
  id, actor_email, action, target_table, row_id, row_title,
  before_json, after_json, reason, trace_id, created_at
) VALUES (
  'audit_v4_1_0_s2552',
  'v4.1.0@release',
  'direction_corrected',
  'bills',
  '118-S-2552',
  'Ukraine Aid Oversight Act',
  '{"direction":"anti-ukraine"}',
  '{"direction":"neutral"}',
  'AC-59.7',
  'tr_v4_1_0_release',
  CURRENT_TIMESTAMP
);
