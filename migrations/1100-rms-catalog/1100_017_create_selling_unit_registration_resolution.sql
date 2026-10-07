-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Identity-only terminal original-operation absence. No dictionary is changed.
CREATE TABLE rms_catalog.selling_unit_registration_abandonment (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 action_code text NOT NULL CHECK(action_code IN ('Create','ReplaceDraft')),
 expected_registry_version integer NOT NULL CHECK(expected_registry_version>=0 AND expected_registry_version<2147483647),
 command_json jsonb NOT NULL CHECK(jsonb_typeof(command_json)='object' AND octet_length(command_json::text)<=2048),
 snapshot_json jsonb NOT NULL CHECK(jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=4096),
 resolution_digest text NOT NULL CHECK(resolution_digest ~ '^sha256:[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at) AND date_trunc('milliseconds',recorded_at)=recorded_at),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 data_classification text NOT NULL DEFAULT 'ConfigurationMetadata' CHECK(data_classification='ConfigurationMetadata'),
 CHECK((command_json ?& ARRAY['profile','tenantReference','brandReference','actorReference','action','operationReference','expectedRegistryVersion']
   AND command_json-ARRAY['profile','tenantReference','brandReference','actorReference','action','operationReference','expectedRegistryVersion']='{}'::jsonb) IS TRUE),
 CHECK((command_json->>'profile') IS NOT DISTINCT FROM 'CatalogSellingUnitRegistrationResolutionCommandV1'),
 CHECK((command_json->>'tenantReference') IS NOT DISTINCT FROM tenant_id::text),
 CHECK((command_json->>'brandReference') IS NOT DISTINCT FROM brand_id::text),
 CHECK((command_json->>'actorReference') IS NOT DISTINCT FROM actor_id::text),
 CHECK((command_json->>'action') IS NOT DISTINCT FROM action_code),
 CHECK((command_json->>'operationReference') IS NOT DISTINCT FROM operation_id::text),
 CHECK((command_json->'expectedRegistryVersion') IS NOT DISTINCT FROM to_jsonb(expected_registry_version)),
 CHECK((snapshot_json ?& ARRAY['profile','outcome','command','registryReference','versionReference','registryVersion','originalIntentDigest','snapshotDigest','recordedAt','digest']
   AND snapshot_json-ARRAY['profile','outcome','command','registryReference','versionReference','registryVersion','originalIntentDigest','snapshotDigest','recordedAt','digest']='{}'::jsonb) IS TRUE),
 CHECK((snapshot_json->>'profile') IS NOT DISTINCT FROM 'CatalogSellingUnitRegistrationResolutionV1'),
 CHECK((snapshot_json->>'outcome') IS NOT DISTINCT FROM 'Abandoned'),
 CHECK((snapshot_json->'command') IS NOT DISTINCT FROM command_json),
 CHECK((snapshot_json->'registryReference') IS NOT DISTINCT FROM 'null'::jsonb),
 CHECK((snapshot_json->'versionReference') IS NOT DISTINCT FROM 'null'::jsonb),
 CHECK((snapshot_json->'registryVersion') IS NOT DISTINCT FROM 'null'::jsonb),
 CHECK((snapshot_json->'originalIntentDigest') IS NOT DISTINCT FROM 'null'::jsonb),
 CHECK((snapshot_json->'snapshotDigest') IS NOT DISTINCT FROM 'null'::jsonb),
 CHECK((snapshot_json->>'digest') IS NOT DISTINCT FROM resolution_digest),
 CHECK((snapshot_json->>'recordedAt') IS NOT DISTINCT FROM to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
CREATE TRIGGER selling_unit_registration_abandonment_immutable BEFORE UPDATE OR DELETE ON rms_catalog.selling_unit_registration_abandonment
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_publication_immutable();
CREATE TRIGGER selling_unit_registration_abandonment_no_truncate BEFORE TRUNCATE ON rms_catalog.selling_unit_registration_abandonment
 FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.product_publication_immutable();
ALTER TABLE rms_catalog.selling_unit_registration_abandonment ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.selling_unit_registration_abandonment FORCE ROW LEVEL SECURITY;
CREATE POLICY selling_unit_registration_abandonment_scope ON rms_catalog.selling_unit_registration_abandonment
 USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE)
 WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE);
REVOKE ALL ON TABLE rms_catalog.selling_unit_registration_abandonment FROM PUBLIC;

-- Trigger-only global operation visibility closes hidden Tenant/Actor races.
-- Strict relation/context guards and fixed search_path prohibit general reads.
CREATE FUNCTION rms_catalog.selling_unit_registration_fence_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
 IF TG_TABLE_SCHEMA<>'rms_catalog' OR TG_TABLE_NAME NOT IN ('selling_unit_registration_abandonment','selling_unit_registry_record') OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
 THEN RAISE EXCEPTION 'SELLING_UNIT_RESOLUTION_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 IF current_setting('transaction_isolation')<>'read committed'
 THEN RAISE EXCEPTION 'SELLING_UNIT_RESOLUTION_UNAVAILABLE' USING ERRCODE='25000'; END IF;
 IF (NEW.tenant_id::text=current_setting('bop.tenant_id',true) AND NEW.brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS NOT TRUE
 THEN RAISE EXCEPTION 'SELLING_UNIT_RESOLUTION_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('CatalogProductSource:'||NEW.brand_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('CatalogSellingUnitRegistry:'||NEW.tenant_id::text||':'||NEW.brand_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('CatalogSellingUnitOperation:'||NEW.operation_id::text,0));
 IF TG_TABLE_NAME='selling_unit_registration_abandonment' THEN
   IF EXISTS(SELECT 1 FROM rms_catalog.selling_unit_registry_record WHERE operation_id=NEW.operation_id)
   THEN RAISE EXCEPTION 'SELLING_UNIT_OPERATION_ALREADY_COMMITTED' USING ERRCODE='23514'; END IF;
 ELSE
   IF EXISTS(SELECT 1 FROM rms_catalog.selling_unit_registration_abandonment WHERE operation_id=NEW.operation_id)
   THEN RAISE EXCEPTION 'SELLING_UNIT_OPERATION_ABANDONED' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.selling_unit_registration_fence_guard() FROM PUBLIC;
CREATE TRIGGER selling_unit_registration_abandonment_guard BEFORE INSERT ON rms_catalog.selling_unit_registration_abandonment
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.selling_unit_registration_fence_guard();
CREATE TRIGGER selling_unit_registration_abandonment_fence BEFORE INSERT ON rms_catalog.selling_unit_registry_record
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.selling_unit_registration_fence_guard();
