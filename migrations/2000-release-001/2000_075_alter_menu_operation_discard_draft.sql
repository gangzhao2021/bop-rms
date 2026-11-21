-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (v15 run 2026-10-16; Owner standing approval 2026-10-14): staff can discard a Menu's open
-- draft. The Menu points at its latest released version again; the discarded draft version keeps its
-- rows, and the discard is recorded as its own append-only Menu operation with its snapshot and audit.
ALTER TABLE rms_catalog.menu_operation_record DROP CONSTRAINT menu_operation_record_action_code_check;
ALTER TABLE rms_catalog.menu_operation_record
  ADD CONSTRAINT menu_operation_record_action_code_check
  CHECK (action_code IN ('Create', 'ReplaceDraft', 'Revise', 'DiscardDraft'));
