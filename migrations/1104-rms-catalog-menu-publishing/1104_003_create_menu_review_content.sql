-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_catalog.menu_review_content (
  lifecycle_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  menu_id platform_helpers.uuid_v7 NOT NULL,
  menu_version_id platform_helpers.uuid_v7 NOT NULL,
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  audit_reference platform_helpers.uuid_v7 NOT NULL,
  data_classification text NOT NULL DEFAULT 'ConfigurationMetadata'
    CHECK (data_classification = 'ConfigurationMetadata'),
  FOREIGN KEY (menu_version_id,menu_id,brand_id)
    REFERENCES rms_catalog.menu_version (menu_version_id,menu_id,brand_id),
  UNIQUE (menu_version_id,snapshot_digest),
  CHECK ((snapshot_json->>'lifecycleReference') IS NOT DISTINCT FROM lifecycle_id::text),
  CHECK ((snapshot_json->>'snapshotDigest') IS NOT DISTINCT FROM snapshot_digest),
  CHECK ((snapshot_json#>>'{content,brandReference}') IS NOT DISTINCT FROM brand_id::text),
  CHECK ((snapshot_json#>>'{content,menuReference}') IS NOT DISTINCT FROM menu_id::text),
  CHECK ((snapshot_json#>>'{content,menuVersionReference}') IS NOT DISTINCT FROM menu_version_id::text)
);
CREATE RULE menu_review_content_no_update AS
  ON UPDATE TO rms_catalog.menu_review_content DO INSTEAD NOTHING;
CREATE RULE menu_review_content_no_delete AS
  ON DELETE TO rms_catalog.menu_review_content DO INSTEAD NOTHING;
ALTER TABLE rms_catalog.menu_review_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.menu_review_content FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_review_content_brand ON rms_catalog.menu_review_content
  USING (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON TABLE rms_catalog.menu_review_content FROM PUBLIC;
