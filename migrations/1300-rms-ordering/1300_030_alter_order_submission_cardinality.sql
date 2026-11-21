-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2402: current-authorized Additional writer and claim fences are installed.
-- Keep the partial Initial index from 1300_027, scoped foreign keys and immutable
-- history guards. This schema expansion does not publish or activate a workflow.
ALTER TABLE rms_ordering.order_submission_record
  DROP CONSTRAINT order_submission_order_unique;
