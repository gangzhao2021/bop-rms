-- bop-rms-migration: 1
-- owner: shared-infrastructure/audit
-- schema: platform_audit
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- The named Platform operator binds an immutable Workforce target; no account type is inferred.
CREATE FUNCTION platform_audit.matches_workforce_account_binding_audit(
  p_audit uuid,
  p_operator uuid,
  p_purpose text,
  p_actor uuid,
  p_operation uuid,
  p_intent text,
  p_occurred_at timestamptz,
  p_reason text
) RETURNS boolean LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform_audit.platform_actor_audit_record r
    WHERE p_audit IS NOT NULL AND p_operator IS NOT NULL
      AND p_purpose IS NOT NULL AND p_actor IS NOT NULL
      AND p_operation IS NOT NULL AND p_intent IS NOT NULL
      AND p_occurred_at IS NOT NULL AND p_reason IS NOT NULL
      AND p_purpose='WORKFORCE_ACCOUNT_BINDING'
      AND p_operator::text=pg_catalog.current_setting('bop.platform_actor_id',true)
      AND p_purpose=pg_catalog.current_setting('bop.platform_purpose',true)
      AND r.audit_id=p_audit AND r.actor_id=p_operator AND r.purpose_code=p_purpose
      AND r.action_code='WORKFORCE_ACCOUNT_BOUND'
      AND r.target_type='WorkforceAccountBinding' AND r.target_id=p_actor
      AND r.operation_id=p_operation
      AND p_intent='sha256:'||pg_catalog.encode(r.intent_digest,'hex')
      AND r.occurred_at=p_occurred_at AND r.reason_code=p_reason
      AND r.retention_policy_code='CONFIGURATION_AUDIT' AND r.retention_policy_version=1
      AND r.writer_transaction_id=pg_catalog.txid_current()
  );
$$;
REVOKE ALL ON FUNCTION platform_audit.matches_workforce_account_binding_audit(uuid,uuid,text,uuid,uuid,text,timestamptz,text) FROM PUBLIC;
