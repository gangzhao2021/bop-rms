-- bop-rms-migration: 1
-- owner: @bop/identity
-- schema: bop_identity
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Two closed immutable origins. Callback identity/approval is held by the owning
-- acceptance source, never inferred from a caller GUC or an INSERT privilege.
CREATE FUNCTION bop_identity.workforce_account_binding_acceptance_admit(p_operator uuid,p_actor uuid,p_operation uuid,p_subject text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF (current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' OR p_operator IS NULL OR p_actor IS NULL OR p_operation IS NULL OR p_subject IS NULL OR p_subject!~'^[a-f0-9]{64}$'
 OR NOT bop_identity.workforce_account_binding_import_capable()
 OR NOT has_function_privilege(session_user,'bop_identity.workforce_account_binding_acceptance_admit(uuid,uuid,uuid,text)','EXECUTE')
 OR p_operator IS DISTINCT FROM p_actor
 OR p_operator::text IS DISTINCT FROM current_setting('bop.platform_actor_id',true)
 OR p_actor::text IS DISTINCT FROM current_setting('bop.workforce_account_actor_id',true)
 OR p_subject IS DISTINCT FROM current_setting('bop.workforce_account_subject_hash',true)
 OR current_setting('bop.platform_purpose',true) IS DISTINCT FROM 'WORKFORCE_ACCOUNT_BINDING'
 OR current_setting('bop.workforce_account_purpose',true) IS DISTINCT FROM 'WORKFORCE_ACCOUNT_BINDING') IS NOT FALSE THEN
 RAISE EXCEPTION 'Workforce binding acceptance unavailable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('WorkforceBindingOperation:'||p_operator::text||':'||p_operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('WorkforceBindingActor:'||p_actor::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('WorkforceBindingSubject:'||current_setting('bop.workforce_account_environment',true)||':'||current_setting('bop.workforce_account_issuer',true)||':'||p_subject,0));
END;
$$;





ALTER POLICY workforce_account_binding_insert ON bop_identity.workforce_account_binding WITH CHECK(
 bop_identity.workforce_account_binding_import_capable()
 AND (((snapshot_text::jsonb)->'originalCommand'->>'profile'='WorkforceAccountBindingImportV1' AND has_function_privilege(session_user,'bop_identity.workforce_account_binding_import_admit(uuid,uuid,uuid,text)','EXECUTE'))
 OR ((snapshot_text::jsonb)->'originalCommand'->>'profile'='WorkforceAccountBindingAcceptanceV1' AND has_function_privilege(session_user,'bop_identity.workforce_account_binding_acceptance_admit(uuid,uuid,uuid,text)','EXECUTE') AND recorded_by=actor_id))
 AND recorded_by::text=current_setting('bop.platform_actor_id',true)
 AND current_setting('bop.platform_purpose',true)='WORKFORCE_ACCOUNT_BINDING' AND current_setting('bop.workforce_account_purpose',true)='WORKFORCE_ACCOUNT_BINDING'
 AND actor_id::text=current_setting('bop.workforce_account_actor_id',true) AND subject_hash=current_setting('bop.workforce_account_subject_hash',true)
 AND environment=current_setting('bop.workforce_account_environment',true) AND issuer=current_setting('bop.workforce_account_issuer',true));

CREATE OR REPLACE FUNCTION bop_identity.workforce_account_invitation_read(p_actor uuid,p_invitation uuid) RETURNS TABLE(invitation_id text,actor_id text,membership_id text,status text,provider_evidence_id text,version integer,created_at text,expires_at text,consumed_at text,precise boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF (current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' OR p_actor IS NULL OR p_invitation IS NULL OR p_actor::text IS DISTINCT FROM current_setting('bop.workforce_account_actor_id',true)
 OR current_setting('bop.workforce_account_purpose',true) NOT IN ('BRAND_INITIAL_PROVISIONING','WORKFORCE_ACCOUNT_BINDING','WORKFORCE_AUTHENTICATION')
 OR NOT (EXISTS(SELECT 1 FROM bop_identity.workforce_account_binding b WHERE b.actor_id=p_actor AND b.invitation_id=p_invitation
 AND b.environment=current_setting('bop.workforce_account_environment',true) AND b.issuer=current_setting('bop.workforce_account_issuer',true))
 OR ((bop_identity.workforce_account_binding_import_capable() AND (has_function_privilege(session_user,'bop_identity.workforce_account_binding_import_admit(uuid,uuid,uuid,text)','EXECUTE') OR (has_function_privilege(session_user,'bop_identity.workforce_account_binding_acceptance_admit(uuid,uuid,uuid,text)','EXECUTE') AND p_actor::text=current_setting('bop.platform_actor_id',true)))) AND current_setting('bop.workforce_account_purpose',true)='WORKFORCE_ACCOUNT_BINDING'
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
 OR ((bop_identity.workforce_account_binding_import_capable() AND (has_function_privilege(session_user,'bop_identity.workforce_account_binding_import_admit(uuid,uuid,uuid,text)','EXECUTE') OR (has_function_privilege(session_user,'bop_identity.workforce_account_binding_acceptance_admit(uuid,uuid,uuid,text)','EXECUTE') AND p_actor::text=current_setting('bop.platform_actor_id',true)))) AND current_setting('bop.workforce_account_purpose',true)='WORKFORCE_ACCOUNT_BINDING'
 AND current_setting('bop.platform_purpose',true)='WORKFORCE_ACCOUNT_BINDING' AND current_setting('bop.platform_actor_id',true)~'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')) FOR SHARE OF i;
END;
$$;

CREATE OR REPLACE FUNCTION bop_identity.workforce_account_binding_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE s jsonb; c jsonb; o jsonb; e jsonb; i record;
BEGIN
 IF (current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' OR NOT bop_identity.workforce_account_binding_import_capable() OR NEW.recorded_by::text IS DISTINCT FROM current_setting('bop.platform_actor_id',true)
 OR NEW.actor_id::text IS DISTINCT FROM current_setting('bop.workforce_account_actor_id',true) OR NEW.subject_hash IS DISTINCT FROM current_setting('bop.workforce_account_subject_hash',true)
 OR NEW.environment IS DISTINCT FROM current_setting('bop.workforce_account_environment',true) OR NEW.issuer IS DISTINCT FROM current_setting('bop.workforce_account_issuer',true)
 OR current_setting('bop.platform_purpose',true) IS DISTINCT FROM 'WORKFORCE_ACCOUNT_BINDING' OR current_setting('bop.workforce_account_purpose',true) IS DISTINCT FROM 'WORKFORCE_ACCOUNT_BINDING'
 OR NEW.writer_transaction_id<>txid_current() OR NEW.recorded_at>clock_timestamp()) IS NOT FALSE THEN
 RAISE EXCEPTION 'Workforce binding write unavailable' USING ERRCODE='23514'; END IF;
 -- Raw reverse-order writers must refuse immediately rather than wait while holding another lock.
 IF NOT pg_try_advisory_xact_lock(hashtextextended('WorkforceBindingOperation:'||NEW.recorded_by::text||':'||NEW.operation_id::text,0))
 OR NOT pg_try_advisory_xact_lock(hashtextextended('WorkforceBindingActor:'||NEW.actor_id::text,0))
 OR NOT pg_try_advisory_xact_lock(hashtextextended('WorkforceBindingSubject:'||NEW.environment||':'||NEW.issuer||':'||NEW.subject_hash,0)) THEN
 RAISE EXCEPTION 'Workforce binding admission busy' USING ERRCODE='55P03'; END IF;
 s:=NEW.snapshot_text::jsonb;c:=s->'configuration';o:=s->'originalCommand';e:=s->'encryptedSubject';
 IF (jsonb_typeof(s)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(s))<>19
 OR NOT s ?& ARRAY['profile','actorReference','configuration','subjectHash','encryptedSubject','invitationReference','originalMembershipReference','providerEvidenceReference','operationReference','intentDigest','originalCommand','recordedByReference','approvedByReference','approvalEvidenceReference','reasonCode','auditReference','recordedAt','sourceDigest','classification']
 OR EXISTS(SELECT 1 FROM jsonb_each(s) WHERE key NOT IN ('configuration','encryptedSubject','originalCommand') AND jsonb_typeof(value)<>'string')
 OR s->>'profile'<>'WorkforceAccountBindingV1' OR s->>'classification'<>'RestrictedSecurity'
 OR s->>'actorReference'<>NEW.actor_id::text OR s->>'subjectHash'<>NEW.subject_hash OR s->>'invitationReference'<>NEW.invitation_id::text
 OR s->>'originalMembershipReference'<>NEW.original_membership_id::text OR s->>'providerEvidenceReference'<>NEW.provider_evidence_id::text
 OR s->>'operationReference'<>NEW.operation_id::text OR s->>'intentDigest'<>NEW.intent_digest OR s->>'recordedByReference'<>NEW.recorded_by::text
 OR s->>'approvedByReference'<>NEW.approved_by::text OR s->>'approvalEvidenceReference'<>NEW.approval_id::text OR s->>'reasonCode'<>NEW.reason_code
 OR s->>'auditReference'<>NEW.audit_id::text OR s->>'recordedAt'<>to_char(NEW.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') OR s->>'sourceDigest'<>NEW.source_digest
 OR jsonb_typeof(c)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(c))<>3 OR NOT c ?& ARRAY['environment','issuer','clientIds']
 OR jsonb_typeof(c->'environment')<>'string' OR jsonb_typeof(c->'issuer')<>'string' OR c->>'environment'<>NEW.environment OR c->>'issuer'<>NEW.issuer
 OR jsonb_typeof(c->'clientIds')<>'array' OR jsonb_array_length(c->'clientIds') NOT BETWEEN 1 AND 8
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(c->'clientIds') WHERE jsonb_typeof(value)<>'string' OR value#>>'{}'!~'^[A-Za-z0-9]{1,128}$')
 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(c->'clientIds'))<>jsonb_array_length(c->'clientIds')
 OR jsonb_typeof(e)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(e))<>4 OR NOT e ?& ARRAY['algorithm','keyReference','ciphertext','encryptionContext']
 OR EXISTS(SELECT 1 FROM jsonb_each(e) WHERE jsonb_typeof(value)<>'string')
 OR e->>'algorithm' NOT IN ('SYNTHETIC_AES_256_GCM','KMS_AES_256_GCM') OR length(e->>'keyReference') NOT BETWEEN 1 AND 255
 OR length(e->>'keyReference')+(SELECT count(*) FROM regexp_split_to_table(e->>'keyReference','') AS chars(ch) WHERE ascii(ch)>65535)>255
 OR length(e->>'ciphertext') NOT BETWEEN 39 AND 2048 OR e->>'ciphertext'!~'^[A-Za-z0-9_-]+$'
 OR e->>'encryptionContext'<>NEW.environment||':workforce-account-subject:'||NEW.actor_id::text||':'||NEW.issuer
 OR jsonb_typeof(o)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(o))<>11
 OR NOT o ?& ARRAY['profile','operationReference','actorReference','subjectHash','invitationReference','originalMembershipReference','providerEvidenceReference','recordedByReference','approvedByReference','approvalEvidenceReference','reasonCode']
 OR EXISTS(SELECT 1 FROM jsonb_each(o) WHERE jsonb_typeof(value)<>'string') OR o->>'profile' NOT IN ('WorkforceAccountBindingImportV1','WorkforceAccountBindingAcceptanceV1')
 OR (o->>'profile'='WorkforceAccountBindingImportV1' AND NOT has_function_privilege(session_user,'bop_identity.workforce_account_binding_import_admit(uuid,uuid,uuid,text)','EXECUTE'))
 OR (o->>'profile'='WorkforceAccountBindingAcceptanceV1' AND (NOT has_function_privilege(session_user,'bop_identity.workforce_account_binding_acceptance_admit(uuid,uuid,uuid,text)','EXECUTE') OR NEW.recorded_by<>NEW.actor_id))
 OR o->>'operationReference'<>NEW.operation_id::text OR o->>'actorReference'<>NEW.actor_id::text OR o->>'subjectHash'<>NEW.subject_hash
 OR o->>'invitationReference'<>NEW.invitation_id::text OR o->>'originalMembershipReference'<>NEW.original_membership_id::text
 OR o->>'providerEvidenceReference'<>NEW.provider_evidence_id::text OR o->>'recordedByReference'<>NEW.recorded_by::text
 OR o->>'approvedByReference'<>NEW.approved_by::text OR o->>'approvalEvidenceReference'<>NEW.approval_id::text OR o->>'reasonCode'<>NEW.reason_code) IS NOT FALSE THEN
 RAISE EXCEPTION 'Workforce binding snapshot unavailable' USING ERRCODE='23514'; END IF;
 SELECT invitation_id,actor_id,membership_id,status,provider_evidence_id,version,created_at,expires_at,consumed_at INTO i FROM bop_identity.workforce_invitation WHERE invitation_id=NEW.invitation_id FOR SHARE;
 IF (NOT FOUND OR i.actor_id<>NEW.actor_id OR i.membership_id<>NEW.original_membership_id OR i.provider_evidence_id IS DISTINCT FROM NEW.provider_evidence_id
 OR i.status<>'Accepted' OR i.consumed_at IS NULL OR i.version<1
 OR NOT isfinite(i.created_at) OR NOT isfinite(i.expires_at) OR NOT isfinite(i.consumed_at)
 OR i.created_at<'0001-01-01Z'::timestamptz OR i.expires_at>='10000-01-01Z'::timestamptz OR i.consumed_at<'0001-01-01Z'::timestamptz
 OR i.created_at<>date_trunc('milliseconds',i.created_at) OR i.expires_at<>date_trunc('milliseconds',i.expires_at) OR i.consumed_at<>date_trunc('milliseconds',i.consumed_at)
 OR (o->>'profile'='WorkforceAccountBindingAcceptanceV1' AND (i.consumed_at IS DISTINCT FROM NEW.recorded_at OR i.expires_at<=NEW.recorded_at))
 OR i.created_at>NEW.recorded_at OR i.consumed_at>NEW.recorded_at OR i.expires_at<>i.created_at+interval '24 hours' OR i.consumed_at<i.created_at OR i.consumed_at>=i.expires_at) IS NOT FALSE THEN
 RAISE EXCEPTION 'Workforce binding invitation tuple unavailable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_identity.workforce_account_binding_acceptance_admit(uuid,uuid,uuid,text) FROM PUBLIC;
