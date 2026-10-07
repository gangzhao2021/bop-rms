-- bop-rms-migration: 1
-- owner: @bop/identity
-- schema: bop_identity
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Fixed Workforce authentication lookup; immutable binding and import admission remain unchanged.
ALTER POLICY workforce_account_binding_read ON bop_identity.workforce_account_binding USING(
 (environment=current_setting('bop.workforce_account_environment',true) AND issuer=current_setting('bop.workforce_account_issuer',true)
 AND ((current_setting('bop.workforce_account_purpose',true) IN ('BRAND_INITIAL_PROVISIONING','WORKFORCE_ACCOUNT_BINDING','WORKFORCE_AUTHENTICATION') AND actor_id::text=current_setting('bop.workforce_account_actor_id',true))
 OR (current_setting('bop.workforce_account_purpose',true) IN ('WORKFORCE_ACCOUNT_BINDING','WORKFORCE_AUTHENTICATION') AND subject_hash=current_setting('bop.workforce_account_subject_hash',true))))
 OR (bop_identity.workforce_account_binding_import_capable() AND recorded_by::text=current_setting('bop.platform_actor_id',true)
 AND current_setting('bop.platform_purpose',true)='WORKFORCE_ACCOUNT_BINDING' AND current_setting('bop.workforce_account_purpose',true)='WORKFORCE_ACCOUNT_BINDING'));
-- Locking reads may consult UPDATE USING. Mutation remains prohibited by WITH CHECK and triggers.
ALTER POLICY workforce_account_binding_lock ON bop_identity.workforce_account_binding USING(
 environment=current_setting('bop.workforce_account_environment',true) AND issuer=current_setting('bop.workforce_account_issuer',true)
 AND ((current_setting('bop.workforce_account_purpose',true) IN ('BRAND_INITIAL_PROVISIONING','WORKFORCE_ACCOUNT_BINDING','WORKFORCE_AUTHENTICATION') AND actor_id::text=current_setting('bop.workforce_account_actor_id',true))
 OR (current_setting('bop.workforce_account_purpose',true) IN ('WORKFORCE_ACCOUNT_BINDING','WORKFORCE_AUTHENTICATION') AND subject_hash=current_setting('bop.workforce_account_subject_hash',true)))) WITH CHECK(false);
CREATE OR REPLACE FUNCTION bop_identity.workforce_account_binding_read(p_actor uuid,p_subject text,p_issuer text,p_environment text) RETURNS TABLE(snapshot_text text,source_digest text,coherent boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF (p_issuer IS NULL OR p_environment IS NULL OR current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' OR (p_actor IS NULL)=(p_subject IS NULL) OR p_issuer IS DISTINCT FROM current_setting('bop.workforce_account_issuer',true)
 OR p_environment IS DISTINCT FROM current_setting('bop.workforce_account_environment',true)
 OR current_setting('bop.workforce_account_purpose',true) NOT IN ('BRAND_INITIAL_PROVISIONING','WORKFORCE_ACCOUNT_BINDING','WORKFORCE_AUTHENTICATION')
 OR (p_actor IS NOT NULL AND p_actor::text IS DISTINCT FROM current_setting('bop.workforce_account_actor_id',true))
 OR (p_subject IS NOT NULL AND (current_setting('bop.workforce_account_purpose',true) NOT IN ('WORKFORCE_ACCOUNT_BINDING','WORKFORCE_AUTHENTICATION') OR p_subject!~'^[a-f0-9]{64}$' OR p_subject IS DISTINCT FROM current_setting('bop.workforce_account_subject_hash',true)))) IS NOT FALSE THEN
 RAISE EXCEPTION 'Workforce binding lookup unavailable' USING ERRCODE='23514'; END IF;
 RETURN QUERY SELECT b.snapshot_text,b.source_digest,true FROM bop_identity.workforce_account_binding b
 WHERE b.environment=p_environment AND b.issuer=p_issuer AND (b.actor_id=p_actor OR b.subject_hash=p_subject) FOR SHARE OF b;
END;
$$;
CREATE OR REPLACE FUNCTION bop_identity.workforce_account_invitation_read(p_actor uuid,p_invitation uuid) RETURNS TABLE(invitation_id text,actor_id text,membership_id text,status text,provider_evidence_id text,version integer,created_at text,expires_at text,consumed_at text,precise boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF (current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' OR p_actor IS NULL OR p_invitation IS NULL OR p_actor::text IS DISTINCT FROM current_setting('bop.workforce_account_actor_id',true)
 OR current_setting('bop.workforce_account_purpose',true) NOT IN ('BRAND_INITIAL_PROVISIONING','WORKFORCE_ACCOUNT_BINDING','WORKFORCE_AUTHENTICATION')
 OR NOT (EXISTS(SELECT 1 FROM bop_identity.workforce_account_binding b WHERE b.actor_id=p_actor AND b.invitation_id=p_invitation
 AND b.environment=current_setting('bop.workforce_account_environment',true) AND b.issuer=current_setting('bop.workforce_account_issuer',true))
 OR (bop_identity.workforce_account_binding_import_capable() AND current_setting('bop.workforce_account_purpose',true)='WORKFORCE_ACCOUNT_BINDING'
 AND current_setting('bop.platform_purpose',true)='WORKFORCE_ACCOUNT_BINDING' AND current_setting('bop.platform_actor_id',true)~'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))) IS NOT FALSE THEN
 RAISE EXCEPTION 'Workforce binding invitation unavailable' USING ERRCODE='23514'; END IF;
 RETURN QUERY SELECT i.invitation_id::text,i.actor_id::text,i.membership_id::text,i.status,i.provider_evidence_id::text,i.version,
 to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),to_char(i.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),to_char(i.consumed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 (isfinite(i.created_at) AND isfinite(i.expires_at) AND isfinite(i.consumed_at)
 AND i.created_at>='0001-01-01Z'::timestamptz AND i.created_at<'10000-01-01Z'::timestamptz
 AND i.expires_at>='0001-01-01Z'::timestamptz AND i.expires_at<'10000-01-01Z'::timestamptz
 AND i.consumed_at>='0001-01-01Z'::timestamptz AND i.consumed_at<'10000-01-01Z'::timestamptz
 AND i.created_at=date_trunc('milliseconds',i.created_at) AND i.expires_at=date_trunc('milliseconds',i.expires_at) AND i.consumed_at=date_trunc('milliseconds',i.consumed_at)) IS TRUE
 FROM bop_identity.workforce_invitation i WHERE i.invitation_id=p_invitation AND i.actor_id=p_actor
 AND (EXISTS(SELECT 1 FROM bop_identity.workforce_account_binding b WHERE b.actor_id=i.actor_id AND b.invitation_id=i.invitation_id
 AND b.original_membership_id=i.membership_id AND b.provider_evidence_id=i.provider_evidence_id
 AND b.environment=current_setting('bop.workforce_account_environment',true) AND b.issuer=current_setting('bop.workforce_account_issuer',true))
 OR (bop_identity.workforce_account_binding_import_capable() AND current_setting('bop.workforce_account_purpose',true)='WORKFORCE_ACCOUNT_BINDING'
 AND current_setting('bop.platform_purpose',true)='WORKFORCE_ACCOUNT_BINDING' AND current_setting('bop.platform_actor_id',true)~'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')) FOR SHARE OF i;
END;
$$;
REVOKE ALL ON FUNCTION bop_identity.workforce_account_binding_read(uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.workforce_account_invitation_read(uuid,uuid) FROM PUBLIC;
