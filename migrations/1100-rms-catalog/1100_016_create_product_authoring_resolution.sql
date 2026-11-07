-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Identity-only terminal authoring outcome; no preallocated Product/Version is
-- invented for an abandoned Create. Product roots and source heads stay intact.
CREATE TABLE rms_catalog.product_authoring_operation_abandonment (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 action_code text NOT NULL CHECK(action_code IN ('Create','ReplaceDraft')),
 product_id platform_helpers.uuid_v7,
 expected_aggregate_version integer,
 command_json jsonb NOT NULL CHECK(jsonb_typeof(command_json)='object' AND octet_length(command_json::text)<=2048),
 snapshot_json jsonb NOT NULL CHECK(jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=4096),
 resolution_digest text NOT NULL CHECK(resolution_digest ~ '^sha256:[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at) AND date_trunc('milliseconds',recorded_at)=recorded_at),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 data_classification text NOT NULL DEFAULT 'ConfigurationMetadata' CHECK(data_classification='ConfigurationMetadata'),
 FOREIGN KEY(product_id,brand_id) REFERENCES rms_catalog.product(product_id,brand_id),
 CHECK(((action_code='Create' AND product_id IS NULL AND expected_aggregate_version IS NULL)
    OR (action_code='ReplaceDraft' AND product_id IS NOT NULL AND expected_aggregate_version>0)) IS TRUE),
 CHECK((command_json ?& ARRAY['profile','tenantReference','brandReference','actorReference','action','operationReference','productReference','expectedAggregateVersion']
    AND command_json-ARRAY['profile','tenantReference','brandReference','actorReference','action','operationReference','productReference','expectedAggregateVersion']='{}'::jsonb) IS TRUE),
 CHECK((command_json->>'profile') IS NOT DISTINCT FROM 'CatalogProductAuthoringResolutionCommandV1'),
 CHECK((command_json->>'tenantReference') IS NOT DISTINCT FROM tenant_id::text),
 CHECK((command_json->>'brandReference') IS NOT DISTINCT FROM brand_id::text),
 CHECK((command_json->>'actorReference') IS NOT DISTINCT FROM actor_id::text),
 CHECK((command_json->>'action') IS NOT DISTINCT FROM action_code),
 CHECK((command_json->>'operationReference') IS NOT DISTINCT FROM operation_id::text),
 CHECK((command_json->>'productReference') IS NOT DISTINCT FROM product_id::text),
 CHECK((command_json->'expectedAggregateVersion') IS NOT DISTINCT FROM COALESCE(to_jsonb(expected_aggregate_version),'null'::jsonb)),
 CHECK((snapshot_json ?& ARRAY['profile','outcome','command','productReference','versionReference','aggregateVersion','originalIntentDigest','recordedAt','digest']
    AND snapshot_json-ARRAY['profile','outcome','command','productReference','versionReference','aggregateVersion','originalIntentDigest','recordedAt','digest']='{}'::jsonb) IS TRUE),
 CHECK((snapshot_json->>'profile') IS NOT DISTINCT FROM 'CatalogProductAuthoringResolutionV1'),
 CHECK((snapshot_json->>'outcome') IS NOT DISTINCT FROM 'Abandoned'),
 CHECK((snapshot_json->'command') IS NOT DISTINCT FROM command_json),
 CHECK((snapshot_json->>'productReference') IS NOT DISTINCT FROM product_id::text),
 CHECK((snapshot_json->'versionReference') IS NOT DISTINCT FROM 'null'::jsonb),
 CHECK((snapshot_json->'aggregateVersion') IS NOT DISTINCT FROM 'null'::jsonb),
 CHECK((snapshot_json->'originalIntentDigest') IS NOT DISTINCT FROM 'null'::jsonb),
 CHECK((snapshot_json->>'digest') IS NOT DISTINCT FROM resolution_digest),
 CHECK((snapshot_json->>'recordedAt') IS NOT DISTINCT FROM to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
CREATE RULE product_authoring_abandonment_no_update AS ON UPDATE TO rms_catalog.product_authoring_operation_abandonment DO INSTEAD NOTHING;
CREATE RULE product_authoring_abandonment_no_delete AS ON DELETE TO rms_catalog.product_authoring_operation_abandonment DO INSTEAD NOTHING;
ALTER TABLE rms_catalog.product_authoring_operation_abandonment ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_authoring_operation_abandonment FORCE ROW LEVEL SECURITY;
CREATE POLICY product_authoring_abandonment_scope ON rms_catalog.product_authoring_operation_abandonment
 USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE)
 WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE);
REVOKE ALL ON TABLE rms_catalog.product_authoring_operation_abandonment FROM PUBLIC;

-- Trigger-only visibility prevents a hidden conflicting Actor/Tenant from being
-- mistaken for absence. Existing publication guard continues to run unchanged.
CREATE FUNCTION rms_catalog.product_authoring_abandonment_fence_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE check_authoring boolean;
BEGIN
 IF TG_TABLE_SCHEMA<>'rms_catalog' OR TG_TABLE_NAME NOT IN ('product_authoring_operation_abandonment','product_operation_record','product_publication_operation_abandonment') OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
 THEN RAISE EXCEPTION 'PRODUCT_AUTHORING_RESOLUTION_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 IF current_setting('transaction_isolation')<>'read committed'
 THEN RAISE EXCEPTION 'PRODUCT_AUTHORING_RESOLUTION_UNAVAILABLE' USING ERRCODE='25000'; END IF;
 IF (NEW.brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS NOT TRUE
 THEN RAISE EXCEPTION 'PRODUCT_AUTHORING_RESOLUTION_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='product_authoring_operation_abandonment' THEN
   IF (NEW.tenant_id::text=current_setting('bop.tenant_id',true)) IS NOT TRUE
   THEN RAISE EXCEPTION 'PRODUCT_AUTHORING_RESOLUTION_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('CatalogProductSource:'||NEW.brand_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('CatalogProductOperation:'||NEW.brand_id::text||':'||NEW.operation_id::text,0));
 IF TG_TABLE_NAME='product_authoring_operation_abandonment' THEN
   IF EXISTS(SELECT 1 FROM rms_catalog.product_operation_record WHERE brand_id=NEW.brand_id AND operation_id=NEW.operation_id)
      OR EXISTS(SELECT 1 FROM rms_catalog.product_publication_operation_abandonment WHERE operation_namespace='CatalogProductOperation' AND brand_id=NEW.brand_id AND operation_id=NEW.operation_id)
   THEN RAISE EXCEPTION 'PRODUCT_AUTHORING_OPERATION_CONFLICT' USING ERRCODE='23514'; END IF;
 ELSE
   IF TG_TABLE_NAME='product_operation_record' THEN check_authoring:=true;
   ELSE check_authoring:=(NEW.operation_namespace='CatalogProductOperation'); END IF;
   IF check_authoring AND EXISTS(SELECT 1 FROM rms_catalog.product_authoring_operation_abandonment WHERE brand_id=NEW.brand_id AND operation_id=NEW.operation_id)
   THEN RAISE EXCEPTION 'PRODUCT_AUTHORING_OPERATION_ABANDONED' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.product_authoring_abandonment_fence_guard() FROM PUBLIC;
CREATE TRIGGER product_authoring_abandonment_guard BEFORE INSERT ON rms_catalog.product_authoring_operation_abandonment
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_authoring_abandonment_fence_guard();
CREATE TRIGGER product_authoring_abandonment_fence BEFORE INSERT ON rms_catalog.product_operation_record
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_authoring_abandonment_fence_guard();
CREATE TRIGGER product_authoring_abandonment_fence BEFORE INSERT ON rms_catalog.product_publication_operation_abandonment
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_authoring_abandonment_fence_guard();
