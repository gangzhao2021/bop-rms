-- bop-rms-migration: 1
-- owner: @rms/inventory
-- schema: rms_inventory
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_inventory.recipe_configuration_source_version (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 item_id platform_helpers.uuid_v7 NOT NULL,
 item_version bigint NOT NULL CHECK (item_version BETWEEN 1 AND 9007199254740991),
 version_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
 PRIMARY KEY (tenant_id,brand_id,item_id,item_version),
 FOREIGN KEY (tenant_id,brand_id,item_id,item_version) REFERENCES rms_inventory.inventory_item_version(tenant_id,brand_id,item_id,version)
);
CREATE TABLE rms_inventory.recipe_configuration_source_capture (
 snapshot_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
 captured_at timestamptz NOT NULL CHECK (isfinite(captured_at) AND captured_at=date_trunc('milliseconds',captured_at)),
 captured_by_actor_id platform_helpers.uuid_v7 NOT NULL,
 coverage_json jsonb NOT NULL,
 UNIQUE (tenant_id,brand_id,content_digest),
 CHECK ((jsonb_typeof(coverage_json)='object'
  AND coverage_json->>'family'='Inventory'
  AND coverage_json->>'tenantReference'=tenant_id::text
  AND coverage_json->>'brandReference'=brand_id::text
  AND coverage_json->>'snapshotReference'=snapshot_id::text
  AND coverage_json->>'digest'=content_digest
  AND coverage_json->>'complete'='true'
  AND jsonb_array_length(coverage_json->'dependencies')<=2048
 ) IS TRUE)
);
CREATE TRIGGER recipe_configuration_source_version_immutable BEFORE UPDATE OR DELETE ON rms_inventory.recipe_configuration_source_version FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
CREATE TRIGGER recipe_configuration_source_version_no_truncate BEFORE TRUNCATE ON rms_inventory.recipe_configuration_source_version FOR EACH STATEMENT EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
CREATE TRIGGER recipe_configuration_source_capture_immutable BEFORE UPDATE OR DELETE ON rms_inventory.recipe_configuration_source_capture FOR EACH ROW EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
CREATE TRIGGER recipe_configuration_source_capture_no_truncate BEFORE TRUNCATE ON rms_inventory.recipe_configuration_source_capture FOR EACH STATEMENT EXECUTE FUNCTION rms_inventory.reject_item_history_mutation();
ALTER TABLE rms_inventory.recipe_configuration_source_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.recipe_configuration_source_version FORCE ROW LEVEL SECURITY;
CREATE POLICY recipe_configuration_source_version_scope ON rms_inventory.recipe_configuration_source_version USING (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid AND brand_id=platform_helpers.current_brand_id()) WITH CHECK (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid AND brand_id=platform_helpers.current_brand_id());
ALTER TABLE rms_inventory.recipe_configuration_source_capture ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_inventory.recipe_configuration_source_capture FORCE ROW LEVEL SECURITY;
CREATE POLICY recipe_configuration_source_capture_scope ON rms_inventory.recipe_configuration_source_capture USING (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid AND brand_id=platform_helpers.current_brand_id()) WITH CHECK (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid AND brand_id=platform_helpers.current_brand_id());
REVOKE ALL ON rms_inventory.recipe_configuration_source_version,rms_inventory.recipe_configuration_source_capture FROM PUBLIC;
