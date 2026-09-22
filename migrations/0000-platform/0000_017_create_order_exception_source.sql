-- bop-rms-migration: 1
-- owner: shared-infrastructure/projection
-- schema: platform_projection
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA IF NOT EXISTS platform_projection;
REVOKE ALL ON SCHEMA platform_projection FROM PUBLIC;
CREATE TABLE platform_projection.order_exception_source (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 source_id platform_helpers.uuid_v7 NOT NULL,
 source_version bigint NOT NULL CHECK(source_version>0),
 checkpoint_id platform_helpers.uuid_v7 NOT NULL,
 record_json jsonb NOT NULL CHECK(jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=16384),
 PRIMARY KEY(tenant_id,brand_id,store_id,source_id,source_version),
 CHECK((record_json->>'tenantReference') IS NOT DISTINCT FROM tenant_id::text AND
 (record_json->>'brandReference') IS NOT DISTINCT FROM brand_id::text AND
 (record_json->>'storeReference') IS NOT DISTINCT FROM store_id::text AND
 (record_json->>'sourceReference') IS NOT DISTINCT FROM source_id::text AND
 (record_json->>'sourceVersion') IS NOT DISTINCT FROM source_version::text)
);
CREATE RULE order_exception_source_no_update AS ON UPDATE TO platform_projection.order_exception_source DO INSTEAD NOTHING;
CREATE RULE order_exception_source_no_delete AS ON DELETE TO platform_projection.order_exception_source DO INSTEAD NOTHING;
ALTER TABLE platform_projection.order_exception_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_projection.order_exception_source FORCE ROW LEVEL SECURITY;
CREATE POLICY order_exception_source_scope_policy ON platform_projection.order_exception_source
 USING(tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK(tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE platform_projection.order_exception_source FROM PUBLIC;
