-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE rms_ordering.cart_operation_record
  ADD COLUMN result_presentation_snapshot_json jsonb
  CHECK (result_presentation_snapshot_json IS NULL OR jsonb_typeof(result_presentation_snapshot_json) = 'object');
