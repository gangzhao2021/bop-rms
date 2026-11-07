-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Original owning metadata only; old operations are never backfilled.
CREATE TABLE rms_catalog.option_set_authoring_identity (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 action_code text NOT NULL CHECK(action_code IN ('Create','Edit')),
 reason_code text NOT NULL CHECK(reason_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
 requested_option_set_id platform_helpers.uuid_v7,
 expected_aggregate_version integer,
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 data_classification text NOT NULL DEFAULT 'ConfigurationMetadata' CHECK(data_classification='ConfigurationMetadata'),
 CHECK(((action_code='Create' AND requested_option_set_id IS NULL AND expected_aggregate_version IS NULL)
 OR(action_code='Edit' AND requested_option_set_id IS NOT NULL AND expected_aggregate_version>0 AND expected_aggregate_version<2147483647)) IS TRUE),
 option_set_id platform_helpers.uuid_v7 NOT NULL,
 option_set_version_id platform_helpers.uuid_v7 NOT NULL,
 source_operation_id platform_helpers.uuid_v7 NOT NULL CHECK(source_operation_id=operation_id),
 source_action_code text NOT NULL CHECK(source_action_code IN ('Create','ReplaceDraft')),
 result_aggregate_version integer NOT NULL CHECK(result_aggregate_version>0),
 original_occurred_at timestamptz NOT NULL CHECK(isfinite(original_occurred_at) AND date_trunc('milliseconds',original_occurred_at)=original_occurred_at),
 intent_digest text NOT NULL CHECK(intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 source_digest text NOT NULL CHECK(source_digest ~ '^sha256:[0-9a-f]{64}$'),
 content_digest text NOT NULL CHECK(content_digest ~ '^sha256:[0-9a-f]{64}$'),
 configuration_digest text NOT NULL CHECK(configuration_digest ~ '^sha256:[0-9a-f]{64}$'),
 identity_digest text NOT NULL CHECK(identity_digest ~ '^sha256:[0-9a-f]{64}$'),
 identity_json jsonb NOT NULL CHECK(octet_length(identity_json::text)<=4096),
 CONSTRAINT option_set_authoring_identity_source_fk
 FOREIGN KEY(source_operation_id,tenant_id,brand_id,option_set_id,option_set_version_id,source_action_code,intent_digest,result_aggregate_version,original_occurred_at)
 REFERENCES rms_catalog.option_set_draft_content_snapshot(operation_id,tenant_id,brand_id,option_set_id,option_set_version_id,action_code,intent_digest,result_aggregate_version,occurred_at),
 CHECK(((action_code='Create' AND source_action_code='Create' AND result_aggregate_version=1)
 OR(action_code='Edit' AND source_action_code='ReplaceDraft' AND requested_option_set_id=option_set_id AND result_aggregate_version::bigint=expected_aggregate_version::bigint+1)) IS TRUE),
 CHECK((jsonb_typeof(identity_json)='object' AND identity_json ?& ARRAY['profile','command','sourceOperationReference','optionSetReference','versionReference','aggregateVersion','originalOccurredAt','auditReference','originalIntentDigest','sourceDigest','contentDigest','configurationDigest','digest'] AND (identity_json)-ARRAY['profile','command','sourceOperationReference','optionSetReference','versionReference','aggregateVersion','originalOccurredAt','auditReference','originalIntentDigest','sourceDigest','contentDigest','configurationDigest','digest']='{}'::jsonb) IS TRUE),
 CHECK((jsonb_typeof(identity_json->'command')='object' AND identity_json->'command' ?& ARRAY['profile','tenantReference','brandReference','actorReference','action','reasonCode','operationReference','optionSetReference','expectedAggregateVersion'] AND (identity_json->'command')-ARRAY['profile','tenantReference','brandReference','actorReference','action','reasonCode','operationReference','optionSetReference','expectedAggregateVersion']='{}'::jsonb) IS TRUE),
 CHECK(((identity_json->'command')->>'profile') IS NOT DISTINCT FROM 'CatalogOptionSetAuthoringResolutionCommandV1'),
 CHECK(((identity_json->'command')->>'tenantReference') IS NOT DISTINCT FROM tenant_id::text),
 CHECK(((identity_json->'command')->>'brandReference') IS NOT DISTINCT FROM brand_id::text),
 CHECK(((identity_json->'command')->>'actorReference') IS NOT DISTINCT FROM actor_id::text),
 CHECK(((identity_json->'command')->>'action') IS NOT DISTINCT FROM action_code),
 CHECK(((identity_json->'command')->>'reasonCode') IS NOT DISTINCT FROM reason_code),
 CHECK(((identity_json->'command')->>'operationReference') IS NOT DISTINCT FROM operation_id::text),
 CHECK(((identity_json->'command')->>'optionSetReference') IS NOT DISTINCT FROM requested_option_set_id::text),
 CHECK(((identity_json->'command')->'expectedAggregateVersion') IS NOT DISTINCT FROM coalesce(to_jsonb(expected_aggregate_version),'null'::jsonb)),
 CHECK((identity_json->>'profile') IS NOT DISTINCT FROM 'CatalogOptionSetAuthoringIdentityV1'),
 CHECK((identity_json->>'sourceOperationReference') IS NOT DISTINCT FROM source_operation_id::text),
 CHECK((identity_json->>'optionSetReference') IS NOT DISTINCT FROM option_set_id::text),
 CHECK((identity_json->>'versionReference') IS NOT DISTINCT FROM option_set_version_id::text),
 CHECK((identity_json->>'auditReference') IS NOT DISTINCT FROM audit_id::text),
 CHECK((identity_json->>'originalIntentDigest') IS NOT DISTINCT FROM intent_digest),
 CHECK((identity_json->>'sourceDigest') IS NOT DISTINCT FROM source_digest),
 CHECK((identity_json->>'contentDigest') IS NOT DISTINCT FROM content_digest),
 CHECK((identity_json->>'configurationDigest') IS NOT DISTINCT FROM configuration_digest),
 CHECK((identity_json->>'digest') IS NOT DISTINCT FROM identity_digest),
 CHECK((identity_json->'aggregateVersion') IS NOT DISTINCT FROM to_jsonb(result_aggregate_version)),
 CHECK((identity_json->>'originalOccurredAt') IS NOT DISTINCT FROM to_char(original_occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
CREATE TABLE rms_catalog.option_set_authoring_abandonment (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 action_code text NOT NULL CHECK(action_code IN ('Create','Edit')),
 reason_code text NOT NULL CHECK(reason_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
 requested_option_set_id platform_helpers.uuid_v7,
 expected_aggregate_version integer,
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 data_classification text NOT NULL DEFAULT 'ConfigurationMetadata' CHECK(data_classification='ConfigurationMetadata'),
 CHECK(((action_code='Create' AND requested_option_set_id IS NULL AND expected_aggregate_version IS NULL)
 OR(action_code='Edit' AND requested_option_set_id IS NOT NULL AND expected_aggregate_version>0 AND expected_aggregate_version<2147483647)) IS TRUE),
 command_json jsonb NOT NULL CHECK(octet_length(command_json::text)<=2048),
 snapshot_json jsonb NOT NULL CHECK(octet_length(snapshot_json::text)<=4096),
 resolution_digest text NOT NULL CHECK(resolution_digest ~ '^sha256:[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at) AND date_trunc('milliseconds',recorded_at)=recorded_at),
 CHECK((jsonb_typeof(command_json)='object' AND command_json ?& ARRAY['profile','tenantReference','brandReference','actorReference','action','reasonCode','operationReference','optionSetReference','expectedAggregateVersion'] AND (command_json)-ARRAY['profile','tenantReference','brandReference','actorReference','action','reasonCode','operationReference','optionSetReference','expectedAggregateVersion']='{}'::jsonb) IS TRUE),
 CHECK(((command_json)->>'profile') IS NOT DISTINCT FROM 'CatalogOptionSetAuthoringResolutionCommandV1'),
 CHECK(((command_json)->>'tenantReference') IS NOT DISTINCT FROM tenant_id::text),
 CHECK(((command_json)->>'brandReference') IS NOT DISTINCT FROM brand_id::text),
 CHECK(((command_json)->>'actorReference') IS NOT DISTINCT FROM actor_id::text),
 CHECK(((command_json)->>'action') IS NOT DISTINCT FROM action_code),
 CHECK(((command_json)->>'reasonCode') IS NOT DISTINCT FROM reason_code),
 CHECK(((command_json)->>'operationReference') IS NOT DISTINCT FROM operation_id::text),
 CHECK(((command_json)->>'optionSetReference') IS NOT DISTINCT FROM requested_option_set_id::text),
 CHECK(((command_json)->'expectedAggregateVersion') IS NOT DISTINCT FROM coalesce(to_jsonb(expected_aggregate_version),'null'::jsonb)),
 CHECK((jsonb_typeof(snapshot_json)='object' AND snapshot_json ?& ARRAY['profile','outcome','command','identity','recordedAt','digest'] AND (snapshot_json)-ARRAY['profile','outcome','command','identity','recordedAt','digest']='{}'::jsonb) IS TRUE),
 CHECK((snapshot_json->>'profile') IS NOT DISTINCT FROM 'CatalogOptionSetAuthoringResolutionV1'),
 CHECK((snapshot_json->>'outcome') IS NOT DISTINCT FROM 'Abandoned'),
 CHECK((snapshot_json->'command') IS NOT DISTINCT FROM command_json),
 CHECK((snapshot_json->'identity') IS NOT DISTINCT FROM 'null'::jsonb),
 CHECK((snapshot_json->>'digest') IS NOT DISTINCT FROM resolution_digest),
 CHECK((snapshot_json->>'recordedAt') IS NOT DISTINCT FROM to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
ALTER TABLE rms_catalog.option_set_authoring_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.option_set_authoring_identity FORCE ROW LEVEL SECURITY;
CREATE POLICY option_set_authoring_identity_scope ON rms_catalog.option_set_authoring_identity
 USING((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE)
 WITH CHECK((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE);
REVOKE ALL ON TABLE rms_catalog.option_set_authoring_identity FROM PUBLIC;
CREATE TRIGGER option_set_authoring_identity_immutable BEFORE UPDATE OR DELETE ON rms_catalog.option_set_authoring_identity
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.option_set_review_release_immutable();
CREATE TRIGGER option_set_authoring_identity_no_truncate BEFORE TRUNCATE ON rms_catalog.option_set_authoring_identity
 FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.option_set_review_release_immutable();
ALTER TABLE rms_catalog.option_set_authoring_abandonment ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.option_set_authoring_abandonment FORCE ROW LEVEL SECURITY;
CREATE POLICY option_set_authoring_abandonment_scope ON rms_catalog.option_set_authoring_abandonment
 USING((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE)
 WITH CHECK((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE);
REVOKE ALL ON TABLE rms_catalog.option_set_authoring_abandonment FROM PUBLIC;
CREATE TRIGGER option_set_authoring_abandonment_immutable BEFORE UPDATE OR DELETE ON rms_catalog.option_set_authoring_abandonment
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.option_set_review_release_immutable();
CREATE TRIGGER option_set_authoring_abandonment_no_truncate BEFORE TRUNCATE ON rms_catalog.option_set_authoring_abandonment
 FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.option_set_review_release_immutable();
-- The boolean discloses no conflicting scope or identity. It never grants authority.
CREATE FUNCTION rms_catalog.option_set_authoring_operation_available(operation_reference uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
 IF operation_reference IS NULL OR (operation_reference::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') IS NOT TRUE
 OR current_setting('transaction_isolation')<>'read committed'
 OR current_setting('bop.tenant_id',true) IS NULL OR current_setting('bop.tenant_id',true)=''
 OR (current_setting('bop.tenant_id',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') IS NOT TRUE
 OR platform_helpers.current_brand_id() IS NULL OR platform_helpers.current_store_id() IS NOT NULL
 THEN RAISE EXCEPTION 'OPTION_SET_AUTHORING_RESOLUTION_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('CatalogFullOptionOperation:'||operation_reference::text,0));
 RETURN NOT EXISTS(SELECT 1 FROM rms_catalog.option_set_operation_record WHERE operation_id=operation_reference)
 AND NOT EXISTS(SELECT 1 FROM rms_catalog.option_set_authoring_identity WHERE operation_id=operation_reference)
 AND NOT EXISTS(SELECT 1 FROM rms_catalog.option_set_authoring_abandonment WHERE operation_id=operation_reference);
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.option_set_authoring_operation_available(uuid) FROM PUBLIC;
CREATE FUNCTION rms_catalog.option_set_authoring_fence_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE source rms_catalog.option_set_draft_content_snapshot%ROWTYPE;
BEGIN
 IF TG_TABLE_SCHEMA<>'rms_catalog' OR TG_TABLE_NAME NOT IN ('option_set_authoring_identity','option_set_authoring_abandonment','option_set_operation_record')
 OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
 OR current_setting('transaction_isolation')<>'read committed'
 OR(NEW.brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS NOT TRUE
 THEN RAISE EXCEPTION 'OPTION_SET_AUTHORING_RESOLUTION_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME<>'option_set_operation_record' THEN
 IF(NEW.tenant_id::text=current_setting('bop.tenant_id',true)) IS NOT TRUE
 THEN RAISE EXCEPTION 'OPTION_SET_AUTHORING_RESOLUTION_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('CatalogFullOptionOperation:'||NEW.operation_id::text,0));
 IF TG_TABLE_NAME='option_set_authoring_abandonment' THEN
 IF EXISTS(SELECT 1 FROM rms_catalog.option_set_operation_record WHERE operation_id=NEW.operation_id)
 OR EXISTS(SELECT 1 FROM rms_catalog.option_set_authoring_identity WHERE operation_id=NEW.operation_id)
 THEN RAISE EXCEPTION 'OPTION_SET_AUTHORING_OPERATION_CONFLICT' USING ERRCODE='23514'; END IF;
 ELSE
 IF EXISTS(SELECT 1 FROM rms_catalog.option_set_authoring_abandonment WHERE operation_id=NEW.operation_id)
 THEN RAISE EXCEPTION 'OPTION_SET_AUTHORING_OPERATION_ABANDONED' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='option_set_authoring_identity' THEN
 -- Current owning hosts have no SAVEPOINTs. Top-level xmin proof deliberately
 -- refuses a source inserted by a different subtransaction or an old transaction.
 IF NOT EXISTS(SELECT 1 FROM rms_catalog.option_set_draft_content_snapshot
 WHERE operation_id=NEW.source_operation_id AND xmin=mod(pg_current_xact_id()::text::numeric,4294967296)::text::xid)
 OR NOT EXISTS(SELECT 1 FROM rms_catalog.option_set_operation_record
 WHERE operation_id=NEW.source_operation_id AND xmin=mod(pg_current_xact_id()::text::numeric,4294967296)::text::xid)
 THEN RAISE EXCEPTION 'OPTION_SET_AUTHORING_LEGACY_SOURCE_REFUSED' USING ERRCODE='23514'; END IF;
 SELECT * INTO source FROM rms_catalog.option_set_draft_content_snapshot WHERE operation_id=NEW.source_operation_id;
 IF NOT FOUND OR(source.tenant_id,source.brand_id,source.option_set_id,source.option_set_version_id,source.action_code,source.intent_digest,source.result_aggregate_version,source.occurred_at,source.source_digest,source.content_digest,source.configuration_digest)
 IS DISTINCT FROM(NEW.tenant_id,NEW.brand_id,NEW.option_set_id,NEW.option_set_version_id,NEW.source_action_code,NEW.intent_digest,NEW.result_aggregate_version,NEW.original_occurred_at,NEW.source_digest,NEW.content_digest,NEW.configuration_digest)
 THEN RAISE EXCEPTION 'OPTION_SET_AUTHORING_SOURCE_INVALID' USING ERRCODE='23514'; END IF;
 END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.option_set_authoring_fence_guard() FROM PUBLIC;
CREATE TRIGGER option_set_authoring_identity_authoring_fence BEFORE INSERT ON rms_catalog.option_set_authoring_identity
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.option_set_authoring_fence_guard();
CREATE TRIGGER option_set_authoring_abandonment_authoring_fence BEFORE INSERT ON rms_catalog.option_set_authoring_abandonment
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.option_set_authoring_fence_guard();
CREATE TRIGGER option_set_operation_record_authoring_fence BEFORE INSERT ON rms_catalog.option_set_operation_record
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.option_set_authoring_fence_guard();
