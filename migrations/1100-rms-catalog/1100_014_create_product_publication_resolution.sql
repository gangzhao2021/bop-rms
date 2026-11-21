-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Permanent recovery of an unexecuted User request. This is not a Product
-- version transition: no Product root, source generation or Outbox is advanced.
CREATE TABLE rms_catalog.product_publication_operation_abandonment (
 operation_namespace text NOT NULL CHECK(operation_namespace IN ('CatalogProductOperation','CatalogProductWarningAcknowledgement')),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 product_id platform_helpers.uuid_v7 NOT NULL,
 product_version_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 original_kind text NOT NULL CHECK(original_kind IN ('PublicationV1','PublicationV2','WarningAcknowledgementV1')),
 intent_digest text NOT NULL CHECK(intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 resolution_digest text NOT NULL CHECK(resolution_digest ~ '^sha256:[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at) AND date_trunc('milliseconds',recorded_at)=recorded_at),
 command_json jsonb NOT NULL CHECK(jsonb_typeof(command_json)='object' AND octet_length(command_json::text)<=8388608),
 snapshot_json jsonb NOT NULL CHECK(jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=4096),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 data_classification text NOT NULL DEFAULT 'ConfigurationMetadata' CHECK(data_classification='ConfigurationMetadata'),
 PRIMARY KEY(operation_namespace,brand_id,operation_id),
 FOREIGN KEY(product_id,brand_id) REFERENCES rms_catalog.product(product_id,brand_id),
 CHECK((original_kind='WarningAcknowledgementV1')=(operation_namespace='CatalogProductWarningAcknowledgement')),
 CHECK((command_json ?& ARRAY['profile','originalKind','originalCommand'] AND command_json-ARRAY['profile','originalKind','originalCommand']='{}'::jsonb) IS TRUE),
 CHECK((command_json->>'profile') IS NOT DISTINCT FROM 'CatalogProductPublicationResolutionCommandV1'),
 CHECK((command_json->>'originalKind') IS NOT DISTINCT FROM original_kind),
 CHECK((jsonb_typeof(command_json->'originalCommand')='object') IS TRUE),
 CHECK((command_json#>>'{originalCommand,tenantReference}') IS NOT DISTINCT FROM tenant_id::text),
 CHECK((command_json#>>'{originalCommand,brandReference}') IS NOT DISTINCT FROM brand_id::text),
 CHECK((command_json#>>'{originalCommand,actorReference}') IS NOT DISTINCT FROM actor_id::text),
 CHECK((command_json#>>'{originalCommand,actorKind}') IS NOT DISTINCT FROM 'User'),
 CHECK((command_json#>>'{originalCommand,productReference}') IS NOT DISTINCT FROM product_id::text),
 CHECK((command_json#>>'{originalCommand,versionReference}') IS NOT DISTINCT FROM product_version_id::text),
 CHECK((command_json#>>'{originalCommand,operationReference}') IS NOT DISTINCT FROM operation_id::text),
 CHECK((snapshot_json ?& ARRAY['profile','outcome','originalKind','tenantReference','brandReference','actorReference','productReference','versionReference','operationReference','originalIntentDigest','recordedAt','digest']
  AND snapshot_json-ARRAY['profile','outcome','originalKind','tenantReference','brandReference','actorReference','productReference','versionReference','operationReference','originalIntentDigest','recordedAt','digest']='{}'::jsonb) IS TRUE),
 CHECK((snapshot_json->>'profile') IS NOT DISTINCT FROM 'CatalogProductPublicationResolutionV1'),
 CHECK((snapshot_json->>'outcome') IS NOT DISTINCT FROM 'Abandoned'),
 CHECK((snapshot_json->>'originalKind') IS NOT DISTINCT FROM original_kind),
 CHECK((snapshot_json->>'tenantReference') IS NOT DISTINCT FROM tenant_id::text),
 CHECK((snapshot_json->>'brandReference') IS NOT DISTINCT FROM brand_id::text),
 CHECK((snapshot_json->>'actorReference') IS NOT DISTINCT FROM actor_id::text),
 CHECK((snapshot_json->>'productReference') IS NOT DISTINCT FROM product_id::text),
 CHECK((snapshot_json->>'versionReference') IS NOT DISTINCT FROM product_version_id::text),
 CHECK((snapshot_json->>'operationReference') IS NOT DISTINCT FROM operation_id::text),
 CHECK((snapshot_json->>'originalIntentDigest') IS NOT DISTINCT FROM intent_digest),
 CHECK((snapshot_json->>'digest') IS NOT DISTINCT FROM resolution_digest),
 CHECK((snapshot_json->>'recordedAt') IS NOT DISTINCT FROM to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
ALTER TABLE rms_catalog.product_publication_operation_abandonment ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_publication_operation_abandonment FORCE ROW LEVEL SECURITY;
CREATE POLICY product_publication_operation_abandonment_scope ON rms_catalog.product_publication_operation_abandonment
 USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE)
 WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE);
REVOKE ALL ON TABLE rms_catalog.product_publication_operation_abandonment FROM PUBLIC;

-- These fixed trigger-only guards must observe a conflicting operation even if
-- its Tenant/Actor/digest differs. An invoker SELECT under RLS could mistake a
-- hidden conflict for absence. No rows or arbitrary query arguments are exposed.
-- row_security=off fails closed if the migration owner cannot bypass forced RLS.
CREATE FUNCTION rms_catalog.product_publication_abandonment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE
 original jsonb := NEW.command_json->'originalCommand';
 fields text[];
BEGIN
 IF TG_TABLE_SCHEMA<>'rms_catalog' OR TG_TABLE_NAME<>'product_publication_operation_abandonment' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
 THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_RESOLUTION_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 IF current_setting('transaction_isolation')<>'read committed'
 THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_RESOLUTION_UNAVAILABLE' USING ERRCODE='25000'; END IF;
 IF (NEW.tenant_id::text=current_setting('bop.tenant_id',true) AND NEW.brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS NOT TRUE
 THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_RESOLUTION_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('CatalogProductSource:'||NEW.brand_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.operation_namespace||':'||NEW.brand_id::text||':'||NEW.operation_id::text,0));
 IF NEW.original_kind='WarningAcknowledgementV1' THEN
  fields:=ARRAY['profile','purposeCode','action','tenantReference','brandReference','actorReference','actorKind','operationReference','productReference','versionReference','expectedProductAggregateVersion','reportOperationReference','reportDigest','warningBindingDigest','warningCodes','reasonCode','occurredAt'];
  IF (original->>'profile'='CatalogProductPublicationWarningAcknowledgementCommandV1'
    AND original->>'purposeCode'='CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT'
    AND original->>'action'='AcknowledgeProductPublicationWarnings') IS NOT TRUE
  THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_RESOLUTION_CONFLICT' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM rms_catalog.product_publication_warning_acknowledgement WHERE brand_id=NEW.brand_id AND operation_id=NEW.operation_id)
  THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_OPERATION_COMMITTED' USING ERRCODE='23514'; END IF;
 ELSE
  fields:=ARRAY['purposeCode','tenantReference','brandReference','actorReference','actorKind','operationReference','productReference','versionReference','expectedProductAggregateVersion','expectedPublicationVersion','action','contentDigest','configurationDigest','scopeSet','effectivePeriod','scheduleReference','replacementVersionReference','successorDraftVersionReference','occurredAt','reasonCode'];
  IF (original->>'purposeCode'='CATALOG_PRODUCT_VERSION_PUBLICATION'
    AND original->>'action' IN ('Validate','SubmitReview','Approve','Reject','Publish','SchedulePublish','ReschedulePublish','CancelScheduledPublish')) IS NOT TRUE
  THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_RESOLUTION_CONFLICT' USING ERRCODE='23514'; END IF;
  IF NEW.original_kind='PublicationV2' THEN
   fields:=fields||ARRAY['profile','replacementIntent','replacementIntentDigest'];
   IF (original->>'profile') IS DISTINCT FROM 'CatalogProductPublicationCommandV2'
   THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_RESOLUTION_CONFLICT' USING ERRCODE='23514'; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM rms_catalog.product_operation_record WHERE brand_id=NEW.brand_id AND operation_id=NEW.operation_id)
  THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_OPERATION_COMMITTED' USING ERRCODE='23514'; END IF;
 END IF;
 IF (original ?& fields AND original-fields='{}'::jsonb) IS NOT TRUE
 THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_RESOLUTION_CONFLICT' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.product_publication_abandonment_guard() FROM PUBLIC;
CREATE TRIGGER product_publication_abandonment_coherent BEFORE INSERT ON rms_catalog.product_publication_operation_abandonment
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_publication_abandonment_guard();
CREATE TRIGGER product_publication_abandonment_immutable BEFORE UPDATE OR DELETE ON rms_catalog.product_publication_operation_abandonment
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_publication_immutable();
CREATE TRIGGER product_publication_abandonment_no_truncate BEFORE TRUNCATE ON rms_catalog.product_publication_operation_abandonment
 FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.product_publication_immutable();

CREATE FUNCTION rms_catalog.product_operation_abandonment_fence_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE namespace text;
BEGIN
 IF TG_TABLE_SCHEMA<>'rms_catalog' OR TG_TABLE_NAME NOT IN ('product_operation_record','product_publication_warning_acknowledgement') OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
 THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_RESOLUTION_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 IF current_setting('transaction_isolation')<>'read committed'
 THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_RESOLUTION_UNAVAILABLE' USING ERRCODE='25000'; END IF;
 IF (NEW.brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS NOT TRUE
 THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_RESOLUTION_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 namespace:=CASE WHEN TG_TABLE_NAME='product_operation_record' THEN 'CatalogProductOperation' ELSE 'CatalogProductWarningAcknowledgement' END;
 PERFORM pg_advisory_xact_lock(hashtextextended('CatalogProductSource:'||NEW.brand_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(namespace||':'||NEW.brand_id::text||':'||NEW.operation_id::text,0));
 IF EXISTS(SELECT 1 FROM rms_catalog.product_publication_operation_abandonment WHERE operation_namespace=namespace AND brand_id=NEW.brand_id AND operation_id=NEW.operation_id)
 THEN RAISE EXCEPTION 'PRODUCT_PUBLICATION_OPERATION_ABANDONED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.product_operation_abandonment_fence_guard() FROM PUBLIC;
-- Alphabetically before other acknowledgement checks; acquire the common lock
-- order before those guards can take a Product row lock.
CREATE TRIGGER product_operation_abandonment_fence BEFORE INSERT ON rms_catalog.product_operation_record
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_operation_abandonment_fence_guard();
CREATE TRIGGER product_operation_abandonment_fence BEFORE INSERT ON rms_catalog.product_publication_warning_acknowledgement
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_operation_abandonment_fence_guard();
