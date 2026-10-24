-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Preserve the existing one-submission guard until the additional writer and its
-- current authority/version fences are installed. Existing rows remain Initial.
ALTER TABLE rms_ordering.order_submission_record
  ADD COLUMN submission_kind text NOT NULL DEFAULT 'Initial'
    CHECK (submission_kind IN ('Initial', 'Additional'));

CREATE UNIQUE INDEX order_submission_initial_order_unique
  ON rms_ordering.order_submission_record (order_id)
  WHERE submission_kind = 'Initial';
