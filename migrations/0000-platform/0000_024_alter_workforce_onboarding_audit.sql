-- bop-rms-migration: 1
-- owner: shared-infrastructure/audit
-- schema: platform_audit
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE FUNCTION platform_audit.matches_workforce_onboarding_operation_audit(
 p_audit uuid,p_operator uuid,p_purpose text,p_original_operation uuid,
 p_phase_operation uuid,p_phase_digest text,p_occurred_at timestamptz,p_reason text
) RETURNS boolean LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
 SELECT EXISTS(SELECT 1 FROM platform_audit.platform_actor_audit_record r
 WHERE p_audit IS NOT NULL AND p_operator IS NOT NULL AND p_purpose IS NOT NULL
 AND p_original_operation IS NOT NULL AND p_phase_operation IS NOT NULL
 AND p_phase_digest IS NOT NULL AND p_occurred_at IS NOT NULL AND p_reason IS NOT NULL
 AND p_purpose='WORKFORCE_ONBOARDING'
 AND p_operator::text=current_setting('bop.platform_actor_id',true)
 AND p_purpose=current_setting('bop.platform_purpose',true)
 AND r.audit_id=p_audit AND r.actor_id=p_operator AND r.purpose_code=p_purpose
 AND r.action_code='WORKFORCE_ONBOARDING_RECORDED'
 AND r.target_type='WorkforceOnboardingOperation' AND r.target_id=p_original_operation
 AND r.operation_id=p_phase_operation AND p_phase_digest='sha256:'||encode(r.intent_digest,'hex')
 AND r.occurred_at=p_occurred_at AND r.reason_code=p_reason
 AND r.retention_policy_code='CONFIGURATION_AUDIT' AND r.retention_policy_version=1
 AND r.writer_transaction_id=txid_current());
$$;
REVOKE ALL ON FUNCTION platform_audit.matches_workforce_onboarding_operation_audit(uuid,uuid,text,uuid,uuid,text,timestamptz,text) FROM PUBLIC;
