-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_catalog.recipe_allergen_source_capture (
 snapshot_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
 captured_at timestamptz NOT NULL CHECK (isfinite(captured_at) AND captured_at=date_trunc('milliseconds',captured_at)),
 captured_by_actor_id platform_helpers.uuid_v7 NOT NULL,
 coverage_json jsonb NOT NULL,
 UNIQUE (tenant_id,brand_id,content_digest),
 CHECK ((jsonb_typeof(coverage_json)='object' AND coverage_json->>'family'='Allergen'
  AND coverage_json->>'tenantReference'=tenant_id::text AND coverage_json->>'brandReference'=brand_id::text
  AND coverage_json->>'snapshotReference'=snapshot_id::text AND coverage_json->>'digest'=content_digest
  AND coverage_json->'complete'='true'::jsonb AND jsonb_typeof(coverage_json->'dependencies')='array'
  AND jsonb_array_length(coverage_json->'dependencies')<=2048) IS TRUE)
);
CREATE RULE recipe_allergen_source_capture_no_update AS ON UPDATE TO rms_catalog.recipe_allergen_source_capture DO INSTEAD NOTHING;
CREATE RULE recipe_allergen_source_capture_no_delete AS ON DELETE TO rms_catalog.recipe_allergen_source_capture DO INSTEAD NOTHING;
ALTER TABLE rms_catalog.recipe_allergen_source_capture ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.recipe_allergen_source_capture FORCE ROW LEVEL SECURITY;
CREATE POLICY recipe_allergen_source_capture_scope ON rms_catalog.recipe_allergen_source_capture
 USING (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
 WITH CHECK (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON rms_catalog.recipe_allergen_source_capture FROM PUBLIC;
