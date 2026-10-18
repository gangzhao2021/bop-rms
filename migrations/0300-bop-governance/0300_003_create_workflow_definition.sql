-- bop-rms-migration: 1
-- owner: @bop/workflow
-- schema: bop_workflow
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA bop_workflow;
REVOKE ALL ON SCHEMA bop_workflow FROM PUBLIC;
CREATE TABLE bop_workflow.workflow_definition_version (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7,
 workflow_id platform_helpers.uuid_v7 NOT NULL,
 version_id platform_helpers.uuid_v7 NOT NULL,
 version_number bigint NOT NULL CHECK (version_number BETWEEN 1 AND 9007199254740991),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 intent_hash text NOT NULL CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$'),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 audit_id platform_helpers.uuid_v7 NOT NULL,
 purpose_code text NOT NULL,
 applicability_code text NOT NULL,
 lifecycle text NOT NULL CHECK (lifecycle IN ('Draft','Published','Withdrawn')),
 effective_from timestamptz NOT NULL,
 effective_until timestamptz,
 created_at timestamptz NOT NULL,
 definition_json jsonb NOT NULL,
 PRIMARY KEY (tenant_id,brand_id,workflow_id,version_number),
 UNIQUE (tenant_id,brand_id,version_id),
 UNIQUE (tenant_id,brand_id,operation_id),
 UNIQUE (tenant_id,brand_id,audit_id),
 CHECK (isfinite(effective_from) AND isfinite(created_at)
   AND date_trunc('milliseconds',effective_from)=effective_from
   AND date_trunc('milliseconds',created_at)=created_at
   AND (effective_until IS NULL OR (isfinite(effective_until) AND effective_until>effective_from
     AND date_trunc('milliseconds',effective_until)=effective_until))),
 CHECK ((
   jsonb_typeof(definition_json)='object' AND definition_json->>'schemaVersion'='1'
   AND definition_json->>'tenantReference'=tenant_id::text
   AND definition_json->>'brandReference'=brand_id::text
   AND (definition_json->>'storeReference') IS NOT DISTINCT FROM store_id::text
   AND definition_json ? 'storeReference'
   AND definition_json->>'workflowReference'=workflow_id::text
   AND definition_json->>'versionReference'=version_id::text
   AND definition_json->>'versionNumber'=version_number::text
   AND definition_json->>'purposeCode'=purpose_code
   AND definition_json->>'applicabilityCode'=applicability_code
   AND definition_json->>'lifecycle'=lifecycle
   AND definition_json->>'effectiveFrom'=to_char(effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   AND (definition_json->>'effectiveUntil') IS NOT DISTINCT FROM
     to_char(effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   AND definition_json ? 'effectiveUntil'
   AND definition_json->>'createdAt'=to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   AND jsonb_typeof(definition_json->'transitions')='array'
   AND jsonb_array_length(definition_json->'transitions') BETWEEN 1 AND 256
 ) IS TRUE)
);
CREATE FUNCTION bop_workflow.guard_definition_version() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE prior bop_workflow.workflow_definition_version%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN
   RAISE EXCEPTION 'Workflow history is append-only' USING ERRCODE='55000';
 END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
   RAISE EXCEPTION 'Workflow writes require read committed' USING ERRCODE='25000';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'WorkflowDefinition:'||NEW.tenant_id::text||':'||NEW.brand_id::text||':'||NEW.workflow_id::text,0));
 SELECT * INTO prior FROM bop_workflow.workflow_definition_version
   WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND workflow_id=NEW.workflow_id
   ORDER BY version_number DESC LIMIT 1;
 IF (prior.version_number IS NULL AND (NEW.version_number<>1 OR NEW.lifecycle<>'Draft'))
   OR (prior.version_number IS NOT NULL AND (
     NEW.version_number<>prior.version_number+1
     OR NEW.store_id IS DISTINCT FROM prior.store_id
     OR NEW.purpose_code<>prior.purpose_code OR NEW.applicability_code<>prior.applicability_code
     OR NEW.created_at<prior.created_at
     OR NOT ((prior.lifecycle='Draft' AND NEW.lifecycle IN ('Draft','Published'))
       OR (prior.lifecycle='Published' AND NEW.lifecycle IN ('Draft','Withdrawn'))
       OR (prior.lifecycle='Withdrawn' AND NEW.lifecycle='Draft'))
   )) THEN
   RAISE EXCEPTION 'Workflow version conflict' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_workflow.guard_definition_version() FROM PUBLIC;
CREATE TRIGGER workflow_definition_append BEFORE INSERT OR UPDATE OR DELETE
 ON bop_workflow.workflow_definition_version FOR EACH ROW EXECUTE FUNCTION bop_workflow.guard_definition_version();
CREATE TRIGGER workflow_definition_no_truncate BEFORE TRUNCATE
 ON bop_workflow.workflow_definition_version FOR EACH STATEMENT EXECUTE FUNCTION bop_workflow.guard_definition_version();
ALTER TABLE bop_workflow.workflow_definition_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_workflow.workflow_definition_version FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_definition_scope ON bop_workflow.workflow_definition_version
 USING (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid
   AND brand_id=platform_helpers.current_brand_id()
   AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()))
 WITH CHECK (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid
   AND brand_id=platform_helpers.current_brand_id()
   AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
REVOKE ALL ON bop_workflow.workflow_definition_version FROM PUBLIC;
