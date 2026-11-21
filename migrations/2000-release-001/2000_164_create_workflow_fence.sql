-- bop-rms-migration: 1
-- owner: @bop/workflow
-- schema: bop_workflow
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-MERCHANT-LOCK-SCOPE: a fence's scope is the fact it protects. Table locks on these
-- tables made one merchant's write stop every other merchant's reads. Readers now take the key
-- shared; this trigger takes it exclusive for every write, whatever the path, so none can skip it
-- (as the table lock caught every writer). "a0_" fires it before every other row trigger.
LOCK TABLE bop_workflow.workflow_definition_version IN SHARE ROW EXCLUSIVE MODE;
CREATE FUNCTION bop_workflow.take_workflow_fence() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_NARGS<>1 THEN RAISE EXCEPTION 'MERCHANT_FENCE_MISUSED' USING ERRCODE='55000'; END IF;
 IF TG_OP='DELETE' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0]||':'||OLD.tenant_id::text||':'||OLD.brand_id::text,0));
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND (OLD.tenant_id,OLD.brand_id) IS DISTINCT FROM (NEW.tenant_id,NEW.brand_id) THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0]||':'||OLD.tenant_id::text||':'||OLD.brand_id::text,0));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0]||':'||NEW.tenant_id::text||':'||NEW.brand_id::text,0));
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_workflow.take_workflow_fence() FROM PUBLIC;
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON bop_workflow.workflow_definition_version FOR EACH ROW EXECUTE FUNCTION bop_workflow.take_workflow_fence('WorkflowDefinitionFence');
