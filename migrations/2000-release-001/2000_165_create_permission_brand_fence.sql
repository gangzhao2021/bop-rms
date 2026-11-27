-- bop-rms-migration: 1
-- owner: @bop/permission
-- schema: bop_permission
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
-- permission_definition is the installation's catalog, written only by the catalog install in a
-- planned window, and has no brand: it has no fence.
LOCK TABLE bop_permission.policy_state,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_grant,bop_permission.permission_override IN SHARE ROW EXCLUSIVE MODE;
CREATE FUNCTION bop_permission.take_brand_fence() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_NARGS<>1 THEN RAISE EXCEPTION 'MERCHANT_FENCE_MISUSED' USING ERRCODE='55000'; END IF;
 IF TG_OP='DELETE' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0]||':'||OLD.brand_id::text,0));
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND OLD.brand_id IS DISTINCT FROM NEW.brand_id THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0]||':'||OLD.brand_id::text,0));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0]||':'||NEW.brand_id::text,0));
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_permission.take_brand_fence() FROM PUBLIC;
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON bop_permission.policy_state FOR EACH ROW EXECUTE FUNCTION bop_permission.take_brand_fence('PermissionPolicyFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON bop_permission.role FOR EACH ROW EXECUTE FUNCTION bop_permission.take_brand_fence('PermissionPolicyFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON bop_permission.role_assignment FOR EACH ROW EXECUTE FUNCTION bop_permission.take_brand_fence('PermissionPolicyFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON bop_permission.permission_grant FOR EACH ROW EXECUTE FUNCTION bop_permission.take_brand_fence('PermissionPolicyFence');
CREATE TRIGGER a0_merchant_fence BEFORE INSERT OR UPDATE OR DELETE ON bop_permission.permission_override FOR EACH ROW EXECUTE FUNCTION bop_permission.take_brand_fence('PermissionPolicyFence');
