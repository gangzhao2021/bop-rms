-- bop-rms-migration: 1
-- owner: @bop/workflow
-- schema: bop_workflow
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (three TEST merchants, 2026-11-04): a second Workflow install for one Brand, purpose and
-- order type left two current families, and the resolver then refused every guest payment at that
-- merchant for good, because this history is append-only. Only the reader knew the rule. The first
-- row of a new family is now refused while the same scope, purpose and order type holds another
-- family. Existing rows are not touched, so a Brand that already holds two families (a retired TEST
-- merchant on v15) keeps its history and later versions of existing families still work. A partial
-- unique index cannot be built over those rows. The rest of this guard is unchanged.
CREATE OR REPLACE FUNCTION bop_workflow.guard_definition_version() RETURNS trigger
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
 IF prior.version_number IS NULL THEN
   PERFORM pg_advisory_xact_lock(hashtextextended(
     'WorkflowPurpose:'||NEW.tenant_id::text||':'||NEW.brand_id::text||':'||COALESCE(NEW.store_id::text,'Brand')
       ||':'||NEW.purpose_code||':'||NEW.applicability_code,0));
   IF EXISTS (SELECT 1 FROM bop_workflow.workflow_definition_version
     WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id IS NOT DISTINCT FROM NEW.store_id
       AND purpose_code=NEW.purpose_code AND applicability_code=NEW.applicability_code
       AND workflow_id<>NEW.workflow_id) THEN
     RAISE EXCEPTION 'Workflow family already exists for this purpose' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END;
$$;
