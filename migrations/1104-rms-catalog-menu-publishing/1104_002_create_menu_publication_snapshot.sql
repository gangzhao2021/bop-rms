-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_catalog.menu_publication_operation_snapshot (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY
    REFERENCES rms_catalog.menu_publication_operation_record (operation_id),
  brand_id platform_helpers.uuid_v7 NOT NULL,
  menu_id platform_helpers.uuid_v7 NOT NULL,
  menu_version_id platform_helpers.uuid_v7 NOT NULL,
  lifecycle_id platform_helpers.uuid_v7 NOT NULL,
  lifecycle_version integer NOT NULL CHECK (lifecycle_version > 0),
  operation_json jsonb NOT NULL CHECK (jsonb_typeof(operation_json) = 'object'),
  data_classification text NOT NULL DEFAULT 'ConfigurationMetadata'
    CHECK (data_classification = 'ConfigurationMetadata'),
  FOREIGN KEY (menu_version_id,menu_id,brand_id)
    REFERENCES rms_catalog.menu_version (menu_version_id,menu_id,brand_id),
  FOREIGN KEY (lifecycle_id,lifecycle_version)
    REFERENCES rms_catalog.menu_publication_revision (lifecycle_id,lifecycle_version),
  UNIQUE (menu_version_id,lifecycle_version),
  CHECK ((operation_json#>>'{command,operationReference}') IS NOT DISTINCT FROM operation_id::text),
  CHECK ((operation_json#>>'{command,menuReference}') IS NOT DISTINCT FROM menu_id::text),
  CHECK ((operation_json#>>'{command,menuVersionReference}') IS NOT DISTINCT FROM menu_version_id::text),
  CHECK ((operation_json#>>'{result,lifecycle,scope,brandReference}') IS NOT DISTINCT FROM brand_id::text),
  CHECK ((operation_json#>>'{result,lifecycle,lifecycleId}') IS NOT DISTINCT FROM lifecycle_id::text),
  CHECK ((operation_json#>'{result,lifecycle,version}') IS NOT DISTINCT FROM to_jsonb(lifecycle_version))
);
CREATE RULE menu_publication_snapshot_no_update AS
  ON UPDATE TO rms_catalog.menu_publication_operation_snapshot DO INSTEAD NOTHING;
CREATE RULE menu_publication_snapshot_no_delete AS
  ON DELETE TO rms_catalog.menu_publication_operation_snapshot DO INSTEAD NOTHING;
ALTER TABLE rms_catalog.menu_publication_operation_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_publication_operation_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_publication_snapshot_brand ON rms_catalog.menu_publication_operation_snapshot
  USING (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON TABLE rms_catalog.menu_publication_operation_snapshot FROM PUBLIC;
