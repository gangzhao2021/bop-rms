-- bop-rms-migration: 1
-- owner: @bop/identity
-- schema: bop_identity
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Server-only invitation capability. No raw invitation or journal grants.
CREATE POLICY workforce_onboarding_invitation_read ON bop_identity.workforce_onboarding_operation FOR SELECT USING (
 current_setting('bop.onboarding_invitation_purpose',true)='WORKFORCE_ONBOARDING_INVITATION'
 AND selector_hash=current_setting('bop.onboarding_invitation_selector_hash',true)
 AND environment=current_setting('bop.onboarding_environment',true)
 AND issuer=current_setting('bop.onboarding_issuer',true)
 AND client_id=current_setting('bop.onboarding_client_id',true)
);
CREATE FUNCTION bop_identity.workforce_onboarding_invitation_read(
 p_selector_hash text,p_environment text,p_issuer text,p_client_id text
) RETURNS TABLE(snapshot_text text,source_digest text,invitation_json jsonb,precise boolean,invitation_written_here boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE candidate bop_identity.workforce_onboarding_operation%ROWTYPE;
 invitation_row record;
 original_count bigint;
BEGIN
 IF p_selector_hash IS NULL OR p_selector_hash !~ '^[a-f0-9]{64}$'
 OR p_environment IS NULL OR p_environment !~ '^[a-z][a-z0-9-]{0,63}$'
 OR p_issuer IS NULL OR p_issuer !~ '^https://cognito-idp\.ca-central-1\.amazonaws\.com/ca-central-1_[A-Za-z0-9]{1,42}$'
 OR p_client_id IS NULL OR p_client_id !~ '^[A-Za-z0-9]{1,128}$' THEN RETURN; END IF;
 PERFORM set_config('bop.onboarding_invitation_purpose','WORKFORCE_ONBOARDING_INVITATION',true);
 PERFORM set_config('bop.onboarding_invitation_selector_hash',p_selector_hash,true);
 PERFORM set_config('bop.onboarding_environment',p_environment,true);
 PERFORM set_config('bop.onboarding_issuer',p_issuer,true);
 PERFORM set_config('bop.onboarding_client_id',p_client_id,true);
 SELECT count(DISTINCT (j.operator_id,j.operation_id)) INTO original_count
 FROM bop_identity.workforce_onboarding_operation j
 WHERE j.selector_hash=p_selector_hash AND j.environment=p_environment AND j.issuer=p_issuer AND j.client_id=p_client_id;
 IF original_count<>1 THEN RETURN; END IF;
 SELECT j.* INTO candidate FROM bop_identity.workforce_onboarding_operation j
 WHERE j.selector_hash=p_selector_hash AND j.environment=p_environment AND j.issuer=p_issuer AND j.client_id=p_client_id
 ORDER BY j.version DESC LIMIT 1;
 IF NOT FOUND THEN RETURN; END IF;
 -- Same order as the journal writer. Its immutable latest record is held by
 -- the operation advisory fence; locking SELECT would require UPDATE RLS.
 PERFORM pg_advisory_xact_lock(hashtextextended('WORKFORCE_ONBOARDING:'||candidate.operator_id::text||':'||candidate.operation_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('WORKFORCE_INVITATION:'||candidate.actor_id::text||':'||candidate.membership_id::text,0));
 SELECT count(DISTINCT (j.operator_id,j.operation_id)) INTO original_count
 FROM bop_identity.workforce_onboarding_operation j
 WHERE j.selector_hash=p_selector_hash AND j.environment=p_environment AND j.issuer=p_issuer AND j.client_id=p_client_id;
 IF original_count<>1 THEN RETURN; END IF;
 SELECT j.* INTO candidate FROM bop_identity.workforce_onboarding_operation j
 WHERE j.operator_id=candidate.operator_id AND j.operation_id=candidate.operation_id
 AND j.selector_hash=p_selector_hash AND j.environment=p_environment AND j.issuer=p_issuer AND j.client_id=p_client_id
 ORDER BY j.version DESC LIMIT 1;
 IF NOT FOUND OR candidate.state<>'ProviderObserved' THEN RETURN; END IF;
 SELECT i.*,(i.xmin::text::numeric=mod(pg_current_xact_id()::text::numeric,4294967296)) AS written_here
 INTO invitation_row FROM bop_identity.workforce_invitation i
 WHERE i.invitation_id=candidate.invitation_id AND encode(i.selector_hash,'hex')=p_selector_hash
 FOR SHARE;
 IF NOT FOUND THEN RETURN; END IF;
 IF invitation_row.actor_id<>candidate.actor_id OR invitation_row.inviter_actor_id<>candidate.operator_id
 OR invitation_row.membership_id<>candidate.membership_id OR invitation_row.created_at<>candidate.created_at
 OR invitation_row.expires_at<>candidate.expires_at
 OR encode(invitation_row.email_digest,'hex') IS DISTINCT FROM (candidate.snapshot_text::jsonb)->'original'->>'emailDigest'
 OR to_jsonb(invitation_row.store_assignment_ids) IS DISTINCT FROM (candidate.snapshot_text::jsonb)->'original'->'storeAssignmentReferences'
 OR (invitation_row.status NOT IN('Pending','Accepted'))
 OR (invitation_row.status='Accepted' AND invitation_row.written_here IS NOT TRUE) THEN RETURN; END IF;
 snapshot_text:=candidate.snapshot_text;
 source_digest:=candidate.source_digest;
 invitation_json:=jsonb_build_object(
  'invitationReference',invitation_row.invitation_id::text,'actorReference',invitation_row.actor_id::text,
  'inviterActorReference',invitation_row.inviter_actor_id::text,'membershipReference',invitation_row.membership_id::text,
  'storeAssignmentReferences',to_jsonb(invitation_row.store_assignment_ids),
  'emailDigest',encode(invitation_row.email_digest,'hex'),'selectorHash',encode(invitation_row.selector_hash,'hex'),
  'status',invitation_row.status,'providerEvidenceReference',invitation_row.provider_evidence_id::text,
  'version',invitation_row.version,
  'createdAt',to_char(invitation_row.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'expiresAt',to_char(invitation_row.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'consumedAt',to_char(invitation_row.consumed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 );
 precise:=(isfinite(invitation_row.created_at) AND isfinite(invitation_row.expires_at)
  AND invitation_row.created_at>=TIMESTAMPTZ '0001-01-01' AND invitation_row.expires_at<TIMESTAMPTZ '10000-01-01'
  AND invitation_row.created_at=date_trunc('milliseconds',invitation_row.created_at)
  AND invitation_row.expires_at=date_trunc('milliseconds',invitation_row.expires_at)
  AND (invitation_row.consumed_at IS NULL OR (isfinite(invitation_row.consumed_at)
   AND invitation_row.consumed_at>=TIMESTAMPTZ '0001-01-01' AND invitation_row.consumed_at<TIMESTAMPTZ '10000-01-01'
   AND invitation_row.consumed_at=date_trunc('milliseconds',invitation_row.consumed_at))));
 invitation_written_here:=invitation_row.written_here;
 RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION bop_identity.workforce_onboarding_invitation_read(text,text,text,text) FROM PUBLIC;
