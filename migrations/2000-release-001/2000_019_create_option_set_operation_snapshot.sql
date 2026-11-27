-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 slice 4: the exact Option Set each Brand back-office operation produced, so a retried request
-- returns what was recorded rather than the set's later state. Append-only.
CREATE TABLE rms_catalog.option_set_operation_snapshot (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY
    REFERENCES rms_catalog.option_set_operation_record (operation_id),
  brand_id platform_helpers.uuid_v7 NOT NULL,
  option_set_id platform_helpers.uuid_v7 NOT NULL,
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
  CONSTRAINT option_set_operation_snapshot_set_fk FOREIGN KEY (option_set_id, brand_id)
    REFERENCES rms_catalog.option_set (option_set_id, brand_id)
);
CREATE RULE option_set_operation_snapshot_no_update AS
  ON UPDATE TO rms_catalog.option_set_operation_snapshot DO INSTEAD NOTHING;
CREATE RULE option_set_operation_snapshot_no_delete AS
  ON DELETE TO rms_catalog.option_set_operation_snapshot DO INSTEAD NOTHING;
ALTER TABLE rms_catalog.option_set_operation_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.option_set_operation_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY option_set_operation_snapshot_brand_scope ON rms_catalog.option_set_operation_snapshot
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON TABLE rms_catalog.option_set_operation_snapshot FROM PUBLIC;
