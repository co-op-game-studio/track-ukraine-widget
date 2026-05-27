-- Rollback of 0010 — revert HR-2445 + S-2552 back to anti-ukraine.
-- Only restores the rows that the original migration changed.

UPDATE bills
SET direction = 'anti-ukraine',
    direction_reason = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE bill_id = '118-HR-2445'
  AND direction_reason LIKE 'AC-59.7%';

UPDATE bills
SET direction = 'anti-ukraine',
    direction_reason = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE bill_id = '118-S-2552'
  AND direction_reason LIKE 'AC-59.7%';

DELETE FROM audit_log
WHERE id IN ('audit_v4_1_0_hr2445', 'audit_v4_1_0_s2552');
