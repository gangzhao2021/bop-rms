-- bop-rms-migration: 1
-- owner: @bop/identity
-- schema: bop_identity
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Immutable approved external identity linkage. No runtime account lifecycle or login fact.
CREATE TABLE bop_identity.workforce_account_binding (
 actor_id platform_helpers.uuid_v7 PRIMARY KEY,
 environment text NOT NULL CHECK(environment ~ '^[a-z][a-z0-9-]{0,63}$'),
 issuer text NOT NULL CHECK(issuer ~ '^https://cognito-idp\.ca-central-1\.amazonaws\.com/ca-central-1_[A-Za-z0-9]{1,42}$'),
 subject_hash text NOT NULL CHECK(subject_hash ~ '^[a-f0-9]{64}$'),
 invitation_id platform_helpers.uuid_v7 NOT NULL REFERENCES bop_identity.workforce_invitation(invitation_id),
 original_membership_id platform_helpers.uuid_v7 NOT NULL,
 provider_evidence_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 recorded_by platform_helpers.uuid_v7 NOT NULL,
 approved_by platform_helpers.uuid_v7 NOT NULL CHECK(approved_by<>recorded_by),
 approval_id platform_helpers.uuid_v7 NOT NULL,
 reason_code text NOT NULL CHECK(reason_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
 intent_digest text NOT NULL CHECK(intent_digest ~ '^sha256:[a-f0-9]{64}$'),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at) AND recorded_at>='0001-01-01Z'::timestamptz AND recorded_at<'10000-01-01Z'::timestamptz AND recorded_at=date_trunc('milliseconds',recorded_at)),
 source_digest text NOT NULL CHECK(source_digest ~ '^sha256:[a-f0-9]{64}$'),
 snapshot_text text NOT NULL CHECK(octet_length(snapshot_text)<=32768),
 writer_transaction_id bigint NOT NULL DEFAULT txid_current(),
 UNIQUE(environment,issuer,subject_hash),
 UNIQUE(recorded_by,operation_id)
);
CREATE FUNCTION bop_identity.workforce_account_binding_import_capable() RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$
 SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=session_user AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
 AND has_table_privilege(session_user,'bop_identity.workforce_account_binding','INSERT')
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='bop_identity' AND (pg_has_role(r.oid,c.relowner,'USAGE') OR pg_has_role(r.oid,c.relowner,'SET')))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='bop_identity' AND (pg_has_role(r.oid,n.nspowner,'USAGE') OR pg_has_role(r.oid,n.nspowner,'SET')))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles e WHERE (e.rolsuper OR e.rolbypassrls OR e.rolcreaterole OR e.rolcreatedb OR e.rolreplication) AND pg_has_role(r.oid,e.oid,'SET')));
$$;
ALTER TABLE bop_identity.workforce_account_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.workforce_account_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY workforce_account_binding_read ON bop_identity.workforce_account_binding FOR SELECT USING(
 (environment=current_setting('bop.workforce_account_environment',true) AND issuer=current_setting('bop.workforce_account_issuer',true)
 AND current_setting('bop.workforce_account_purpose',true) IN ('BRAND_INITIAL_PROVISIONING','WORKFORCE_ACCOUNT_BINDING')
 AND (actor_id::text=current_setting('bop.workforce_account_actor_id',true) OR subject_hash=current_setting('bop.workforce_account_subject_hash',true)))
 OR (bop_identity.workforce_account_binding_import_capable() AND recorded_by::text=current_setting('bop.platform_actor_id',true)
 AND current_setting('bop.platform_purpose',true)='WORKFORCE_ACCOUNT_BINDING' AND current_setting('bop.workforce_account_purpose',true)='WORKFORCE_ACCOUNT_BINDING'));
-- Locking reads may consult UPDATE USING. Mutation remains prohibited by WITH CHECK and triggers.
CREATE POLICY workforce_account_binding_lock ON bop_identity.workforce_account_binding FOR UPDATE USING(
 environment=current_setting('bop.workforce_account_environment',true) AND issuer=current_setting('bop.workforce_account_issuer',true)
 AND current_setting('bop.workforce_account_purpose',true) IN ('BRAND_INITIAL_PROVISIONING','WORKFORCE_ACCOUNT_BINDING')
 AND (actor_id::text=current_setting('bop.workforce_account_actor_id',true) OR subject_hash=current_setting('bop.workforce_account_subject_hash',true))) WITH CHECK(false);
CREATE POLICY workforce_account_binding_insert ON bop_identity.workforce_account_binding FOR INSERT WITH CHECK(
 bop_identity.workforce_account_binding_import_capable() AND recorded_by::text=current_setting('bop.platform_actor_id',true)
 AND current_setting('bop.platform_purpose',true)='WORKFORCE_ACCOUNT_BINDING' AND current_setting('bop.workforce_account_purpose',true)='WORKFORCE_ACCOUNT_BINDING'
 AND actor_id::text=current_setting('bop.workforce_account_actor_id',true) AND subject_hash=current_setting('bop.workforce_account_subject_hash',true)
 AND environment=current_setting('bop.workforce_account_environment',true) AND issuer=current_setting('bop.workforce_account_issuer',true));
CREATE FUNCTION bop_identity.workforce_account_binding_read(p_actor uuid,p_subject text,p_issuer text,p_environment text) RETURNS TABLE(snapshot_text text,source_digest text,coherent boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF (p_issuer IS NULL OR p_environment IS NULL OR current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' OR (p_actor IS NULL)=(p_subject IS NULL) OR p_issuer IS DISTINCT FROM current_setting('bop.workforce_account_issuer',true)
 OR p_environment IS DISTINCT FROM current_setting('bop.workforce_account_environment',true)
 OR current_setting('bop.workforce_account_purpose',true) NOT IN ('BRAND_INITIAL_PROVISIONING','WORKFORCE_ACCOUNT_BINDING')
 OR (p_actor IS NOT NULL AND p_actor::text IS DISTINCT FROM current_setting('bop.workforce_account_actor_id',true))
 OR (p_subject IS NOT NULL AND (p_subject!~'^[a-f0-9]{64}$' OR p_subject IS DISTINCT FROM current_setting('bop.workforce_account_subject_hash',true)))) IS NOT FALSE THEN
 RAISE EXCEPTION 'Workforce binding lookup unavailable' USING ERRCODE='23514'; END IF;
 RETURN QUERY SELECT b.snapshot_text,b.source_digest,true FROM bop_identity.workforce_account_binding b
 WHERE b.environment=p_environment AND b.issuer=p_issuer AND (b.actor_id=p_actor OR b.subject_hash=p_subject) FOR SHARE OF b;
END;
$$;
CREATE FUNCTION bop_identity.workforce_account_invitation_read(p_actor uuid,p_invitation uuid) RETURNS TABLE(invitation_id text,actor_id text,membership_id text,status text,provider_evidence_id text,version integer,created_at text,expires_at text,consumed_at text,precise boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF (current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' OR p_actor IS NULL OR p_invitation IS NULL OR p_actor::text IS DISTINCT FROM current_setting('bop.workforce_account_actor_id',true)
 OR current_setting('bop.workforce_account_purpose',true) NOT IN ('BRAND_INITIAL_PROVISIONING','WORKFORCE_ACCOUNT_BINDING')
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
 FROM bop_identity.workforce_invitation i WHERE i.invitation_id=p_invitation AND i.actor_id=p_actor FOR SHARE OF i;
END;
$$;
CREATE FUNCTION bop_identity.workforce_account_binding_import_admit(p_operator uuid,p_actor uuid,p_operation uuid,p_subject text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF (current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' OR p_operator IS NULL OR p_actor IS NULL OR p_operation IS NULL OR p_subject IS NULL OR p_subject!~'^[a-f0-9]{64}$'
 OR NOT bop_identity.workforce_account_binding_import_capable()
 OR p_operator::text IS DISTINCT FROM current_setting('bop.platform_actor_id',true)
 OR p_actor::text IS DISTINCT FROM current_setting('bop.workforce_account_actor_id',true)
 OR p_subject IS DISTINCT FROM current_setting('bop.workforce_account_subject_hash',true)
 OR current_setting('bop.platform_purpose',true) IS DISTINCT FROM 'WORKFORCE_ACCOUNT_BINDING'
 OR current_setting('bop.workforce_account_purpose',true) IS DISTINCT FROM 'WORKFORCE_ACCOUNT_BINDING') IS NOT FALSE THEN
 RAISE EXCEPTION 'Workforce binding import unavailable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('WorkforceBindingOperation:'||p_operator::text||':'||p_operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('WorkforceBindingActor:'||p_actor::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('WorkforceBindingSubject:'||current_setting('bop.workforce_account_environment',true)||':'||current_setting('bop.workforce_account_issuer',true)||':'||p_subject,0));
END;
$$;
CREATE FUNCTION bop_identity.workforce_account_binding_immutable() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN RAISE EXCEPTION 'Workforce binding immutable' USING ERRCODE='23514'; END;
$$;
CREATE FUNCTION bop_identity.workforce_account_binding_guard() RETURNS trigger LANGUAGE plpgsql
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
 OR EXISTS(SELECT 1 FROM jsonb_each(o) WHERE jsonb_typeof(value)<>'string') OR o->>'profile'<>'WorkforceAccountBindingImportV1'
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
 OR i.created_at>NEW.recorded_at OR i.consumed_at>NEW.recorded_at OR i.expires_at<>i.created_at+interval '24 hours' OR i.consumed_at<i.created_at OR i.consumed_at>=i.expires_at) IS NOT FALSE THEN
 RAISE EXCEPTION 'Workforce binding invitation tuple unavailable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE FUNCTION bop_identity.workforce_account_binding_complete() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF platform_audit.matches_workforce_account_binding_audit(NEW.audit_id,NEW.recorded_by,'WORKFORCE_ACCOUNT_BINDING',NEW.actor_id,NEW.operation_id,NEW.intent_digest,NEW.recorded_at,NEW.reason_code) IS NOT TRUE THEN
 RAISE EXCEPTION 'Workforce binding Audit unavailable' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END;
$$;
CREATE TRIGGER workforce_account_binding_guard BEFORE INSERT ON bop_identity.workforce_account_binding FOR EACH ROW EXECUTE FUNCTION bop_identity.workforce_account_binding_guard();
CREATE CONSTRAINT TRIGGER workforce_account_binding_complete AFTER INSERT ON bop_identity.workforce_account_binding DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_identity.workforce_account_binding_complete();
CREATE TRIGGER workforce_account_binding_immutable BEFORE UPDATE OR DELETE ON bop_identity.workforce_account_binding FOR EACH ROW EXECUTE FUNCTION bop_identity.workforce_account_binding_immutable();
CREATE TRIGGER workforce_account_binding_no_truncate BEFORE TRUNCATE ON bop_identity.workforce_account_binding FOR EACH STATEMENT EXECUTE FUNCTION bop_identity.workforce_account_binding_immutable();
REVOKE ALL ON TABLE bop_identity.workforce_account_binding FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.workforce_account_binding_import_capable() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.workforce_account_binding_read(uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.workforce_account_invitation_read(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.workforce_account_binding_import_admit(uuid,uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.workforce_account_binding_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.workforce_account_binding_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.workforce_account_binding_complete() FROM PUBLIC;
