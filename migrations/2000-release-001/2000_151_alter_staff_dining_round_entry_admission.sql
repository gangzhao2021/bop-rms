-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (v15 2026-11-03): the Dining admission staff joined the table with to send this round, so
-- the table's page does not show staff as a guest's phone. Null on rounds before this change.
ALTER TABLE rms_ordering.staff_dining_round_entry
 ADD COLUMN dining_admission_id platform_helpers.uuid_v7;
