-- bop-rms-migration: 1
-- owner: @bop/identity
-- schema: bop_identity
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Hash-only invitation secret storage. Immutable per-phase Audit operation IDs.
CREATE TABLE bop_identity.workforce_onboarding_operation (
 operator_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 version bigint NOT NULL CHECK(version BETWEEN 1 AND 9007199254740990),
 environment text NOT NULL CHECK(environment ~ '^[a-z][a-z0-9-]{0,63}$'),
 issuer text NOT NULL CHECK(issuer ~ '^https://cognito-idp\.ca-central-1\.amazonaws\.com/ca-central-1_[A-Za-z0-9]{1,42}$'),
 client_id text NOT NULL CHECK(client_id ~ '^[A-Za-z0-9]{1,128}$'),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 membership_id platform_helpers.uuid_v7 NOT NULL,
 intent_digest text NOT NULL CHECK(intent_digest ~ '^sha256:[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN('Prepared','DispatchClaimed','ProviderUnknown','ProviderObserved','Expired','Rejected')),
 invitation_id platform_helpers.uuid_v7 NOT NULL REFERENCES bop_identity.workforce_invitation(invitation_id),
 selector_hash text NOT NULL CHECK(selector_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL CHECK(expires_at=created_at+interval '24 hours'),
 dispatch_started_at timestamptz,
 phase_operation_id platform_helpers.uuid_v7 NOT NULL UNIQUE CHECK(phase_operation_id<>operation_id),
 phase_request_digest text NOT NULL CHECK(phase_request_digest ~ '^sha256:[a-f0-9]{64}$'),
 previous_source_digest text CHECK(previous_source_digest ~ '^sha256:[a-f0-9]{64}$'),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 occurred_at timestamptz NOT NULL,
 source_digest text NOT NULL CHECK(source_digest ~ '^sha256:[a-f0-9]{64}$'),
 snapshot_text text NOT NULL CHECK(octet_length(snapshot_text)<=32768),
 writer_transaction_id bigint NOT NULL DEFAULT txid_current(),
 PRIMARY KEY(operator_id,operation_id,version),
 CHECK((version=1 AND previous_source_digest IS NULL) OR (version>1 AND previous_source_digest IS NOT NULL))
);
CREATE FUNCTION bop_identity.workforce_onboarding_scope(p_operator uuid,p_actor uuid,p_brand uuid,p_member uuid,p_environment text,p_issuer text,p_client text) RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$
 SELECT COALESCE(p_operator::text=current_setting('bop.platform_actor_id',true)
 AND current_setting('bop.platform_purpose',true)='WORKFORCE_ONBOARDING'
 AND p_actor::text=current_setting('bop.onboarding_actor_id',true)
 AND p_brand::text=current_setting('bop.onboarding_brand_id',true)
 AND p_member::text=current_setting('bop.onboarding_member_id',true)
 AND p_environment=current_setting('bop.onboarding_environment',true)
 AND p_issuer=current_setting('bop.onboarding_issuer',true)
 AND p_client=current_setting('bop.onboarding_client_id',true),false);
$$;
ALTER TABLE bop_identity.workforce_onboarding_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.workforce_onboarding_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY workforce_onboarding_operation_read ON bop_identity.workforce_onboarding_operation FOR SELECT USING(bop_identity.workforce_onboarding_scope(operator_id,actor_id,brand_id,membership_id,environment,issuer,client_id));
CREATE POLICY workforce_onboarding_operation_insert ON bop_identity.workforce_onboarding_operation FOR INSERT WITH CHECK(bop_identity.workforce_onboarding_scope(operator_id,actor_id,brand_id,membership_id,environment,issuer,client_id));
CREATE FUNCTION bop_identity.workforce_onboarding_operation_admit(p_operator uuid,p_operation uuid,p_actor uuid,p_member uuid) RETURNS void LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF p_operator IS NULL OR p_operation IS NULL OR p_actor IS NULL OR p_member IS NULL
 OR p_operator::text IS DISTINCT FROM current_setting('bop.platform_actor_id',true)
 OR current_setting('bop.platform_purpose',true) IS DISTINCT FROM 'WORKFORCE_ONBOARDING'
 OR p_actor::text IS DISTINCT FROM current_setting('bop.onboarding_actor_id',true)
 OR p_member::text IS DISTINCT FROM current_setting('bop.onboarding_member_id',true) THEN RAISE EXCEPTION 'Onboarding admission unavailable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('WORKFORCE_ONBOARDING:'||p_operator::text||':'||p_operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('WORKFORCE_INVITATION:'||p_actor::text||':'||p_member::text,0));
END;
$$;
CREATE FUNCTION bop_identity.workforce_onboarding_operation_immutable() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$ BEGIN RAISE EXCEPTION 'Onboarding history is immutable' USING ERRCODE='23514'; END; $$;
CREATE TRIGGER workforce_onboarding_operation_immutable BEFORE UPDATE OR DELETE ON bop_identity.workforce_onboarding_operation FOR EACH ROW EXECUTE FUNCTION bop_identity.workforce_onboarding_operation_immutable();
CREATE TRIGGER workforce_onboarding_operation_no_truncate BEFORE TRUNCATE ON bop_identity.workforce_onboarding_operation FOR EACH STATEMENT EXECUTE FUNCTION bop_identity.workforce_onboarding_operation_immutable();
CREATE FUNCTION bop_identity.workforce_onboarding_instant(p text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE t timestamptz;
BEGIN
 IF p IS NULL OR p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN RETURN false; END IF;
 t:=p::timestamptz;
 RETURN isfinite(t) AND t>='0001-01-01Z'::timestamptz AND t<'10000-01-01Z'::timestamptz AND to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=p;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;
CREATE FUNCTION bop_identity.workforce_onboarding_operation_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE s jsonb;o jsonb;c jsonb;p jsonb;e jsonb;prior bop_identity.workforce_onboarding_operation%ROWTYPE;k text;
BEGIN
 IF NOT bop_identity.workforce_onboarding_scope(NEW.operator_id,NEW.actor_id,NEW.brand_id,NEW.membership_id,NEW.environment,NEW.issuer,NEW.client_id)
 OR NEW.writer_transaction_id<>txid_current() THEN RAISE EXCEPTION 'Onboarding scope unavailable' USING ERRCODE='23514'; END IF;
 -- Raw writers may not reverse the declared locks and block an admitted source.
 IF NOT pg_try_advisory_xact_lock(hashtextextended('WORKFORCE_ONBOARDING:'||NEW.operator_id::text||':'||NEW.operation_id::text,0))
 OR NOT pg_try_advisory_xact_lock(hashtextextended('WORKFORCE_INVITATION:'||NEW.actor_id::text||':'||NEW.membership_id::text,0)) THEN RAISE EXCEPTION 'Onboarding admission unavailable' USING ERRCODE='23514'; END IF;
 s:=NEW.snapshot_text::jsonb;o:=s->'original';c:=o->'configuration';p:=s->'provider';
 IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR jsonb_typeof(o) IS DISTINCT FROM 'object' OR jsonb_typeof(c) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Onboarding snapshot invalid' USING ERRCODE='23514'; END IF;
 IF NOT (s ?& ARRAY['profile','original','intentDigest','version','state','invitationReference','selectorHash','createdAt','expiresAt','dispatchStartedAt','provider','phaseOperationReference','phaseRequestDigest','previousSourceDigest','auditReference','occurredAt','sourceDigest']) OR NOT (o ?& ARRAY['profile','configuration','operationReference','operatorReference','actorReference','brandReference','membershipReference','storeAssignmentReferences','emailDigest','approvedByReference','approvalEvidenceReference','relationshipEvidenceReference','approvedPlanDigest','reasonCode']) OR NOT (c ?& ARRAY['environment','issuer','clientId']) THEN RAISE EXCEPTION 'Onboarding snapshot invalid' USING ERRCODE='23514'; END IF;
 FOREACH k IN ARRAY ARRAY['profile','intentDigest','state','invitationReference','selectorHash','createdAt','expiresAt','phaseOperationReference','phaseRequestDigest','auditReference','occurredAt','sourceDigest'] LOOP
  IF jsonb_typeof(s->k) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Onboarding scalar invalid' USING ERRCODE='23514'; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['profile','operationReference','operatorReference','actorReference','brandReference','membershipReference','emailDigest','approvedByReference','approvalEvidenceReference','relationshipEvidenceReference','approvedPlanDigest','reasonCode'] LOOP
  IF jsonb_typeof(o->k) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Onboarding scalar invalid' USING ERRCODE='23514'; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['environment','issuer','clientId'] LOOP
  IF jsonb_typeof(c->k) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Onboarding scalar invalid' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF jsonb_typeof(s->'previousSourceDigest') NOT IN('string','null') OR jsonb_typeof(s->'dispatchStartedAt') NOT IN('string','null') OR jsonb_typeof(o->'storeAssignmentReferences') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Onboarding scalar invalid' USING ERRCODE='23514'; END IF;
 IF (jsonb_typeof(s)='object' AND (SELECT count(*) FROM jsonb_object_keys(s))=17
 AND s->>'profile'='WorkforceOnboardingOperationV1'
 AND jsonb_typeof(o)='object' AND (SELECT count(*) FROM jsonb_object_keys(o))=14 AND o->>'profile'='WorkforceOnboardingOriginalV1'
 AND jsonb_typeof(c)='object' AND (SELECT count(*) FROM jsonb_object_keys(c))=3
 AND c->>'environment'=NEW.environment AND c->>'issuer'=NEW.issuer AND c->>'clientId'=NEW.client_id
 AND o->>'operatorReference'=NEW.operator_id::text AND o->>'operationReference'=NEW.operation_id::text
 AND o->>'actorReference'=NEW.actor_id::text AND o->>'brandReference'=NEW.brand_id::text AND o->>'membershipReference'=NEW.membership_id::text
 AND o->>'emailDigest' ~ '^[a-f0-9]{64}$' AND o->>'approvedPlanDigest' ~ '^sha256:[a-f0-9]{64}$'
 AND o->>'reasonCode' ~ '^[A-Z][A-Z0-9_]{0,127}$'
 AND jsonb_typeof(o->'storeAssignmentReferences')='array' AND jsonb_array_length(o->'storeAssignmentReferences')<=100
 AND jsonb_typeof(s->'version')='number' AND s->>'version'=NEW.version::text
 AND s->>'intentDigest'=NEW.intent_digest AND s->>'state'=NEW.state
 AND s->>'invitationReference'=NEW.invitation_id::text AND s->>'selectorHash'=NEW.selector_hash
 AND s->>'phaseOperationReference'=NEW.phase_operation_id::text AND s->>'phaseRequestDigest'=NEW.phase_request_digest
 AND s->>'auditReference'=NEW.audit_id::text AND s->>'sourceDigest'=NEW.source_digest
 AND (s->>'previousSourceDigest') IS NOT DISTINCT FROM NEW.previous_source_digest
 AND bop_identity.workforce_onboarding_instant(s->>'createdAt') AND (s->>'createdAt')::timestamptz=NEW.created_at
 AND bop_identity.workforce_onboarding_instant(s->>'expiresAt') AND (s->>'expiresAt')::timestamptz=NEW.expires_at
 AND bop_identity.workforce_onboarding_instant(s->>'occurredAt') AND (s->>'occurredAt')::timestamptz=NEW.occurred_at
 AND ((s->'dispatchStartedAt'='null'::jsonb AND NEW.dispatch_started_at IS NULL) OR (bop_identity.workforce_onboarding_instant(s->>'dispatchStartedAt') AND (s->>'dispatchStartedAt')::timestamptz=NEW.dispatch_started_at))) IS NOT TRUE THEN RAISE EXCEPTION 'Onboarding snapshot invalid' USING ERRCODE='23514'; END IF;
 FOREACH k IN ARRAY ARRAY['approvedByReference','approvalEvidenceReference','relationshipEvidenceReference'] LOOP
  IF jsonb_typeof(o->k) IS DISTINCT FROM 'string' OR o->>k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Onboarding reference invalid' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF o->>'approvedByReference' IN(NEW.operator_id::text,NEW.actor_id::text)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(o->'storeAssignmentReferences') AS a(value) WHERE jsonb_typeof(a.value) IS DISTINCT FROM 'string' OR a.value#>>'{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
 OR (SELECT count(*) FROM jsonb_array_elements(o->'storeAssignmentReferences'))<>(SELECT count(DISTINCT a.value) FROM jsonb_array_elements(o->'storeAssignmentReferences') AS a(value))
 OR NEW.occurred_at<NEW.created_at OR (NEW.state='Expired' AND NEW.occurred_at<NEW.expires_at) OR (NEW.state NOT IN('Expired','Rejected') AND NEW.occurred_at>=NEW.expires_at)
 OR (NEW.dispatch_started_at IS NOT NULL AND (NEW.dispatch_started_at<NEW.created_at OR NEW.dispatch_started_at>=NEW.expires_at OR NEW.dispatch_started_at>NEW.occurred_at))
 OR (NEW.state IN('DispatchClaimed','ProviderUnknown','ProviderObserved') AND NEW.dispatch_started_at IS NULL)
 OR (NEW.state IN('Prepared','DispatchClaimed','ProviderUnknown') AND p IS DISTINCT FROM 'null'::jsonb)
 OR (NEW.state='ProviderObserved' AND jsonb_typeof(p) IS DISTINCT FROM 'object') THEN RAISE EXCEPTION 'Onboarding state invalid' USING ERRCODE='23514'; END IF;
 IF p IS DISTINCT FROM 'null'::jsonb THEN
  e:=p->'encryptedSubject';
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(e) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Onboarding Provider snapshot invalid' USING ERRCODE='23514'; END IF;
  IF NOT (p ?& ARRAY['subjectHash','encryptedSubject','username','createdAt','status','enabled']) OR NOT (e ?& ARRAY['algorithm','keyReference','ciphertext','encryptionContext']) THEN RAISE EXCEPTION 'Onboarding Provider snapshot invalid' USING ERRCODE='23514'; END IF;
  FOREACH k IN ARRAY ARRAY['subjectHash','username','createdAt','status'] LOOP
   IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Onboarding Provider scalar invalid' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['algorithm','keyReference','ciphertext','encryptionContext'] LOOP
   IF jsonb_typeof(e->k) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Onboarding Provider scalar invalid' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF (jsonb_typeof(p)='object' AND (SELECT count(*) FROM jsonb_object_keys(p))=6
  AND p->>'subjectHash' ~ '^[a-f0-9]{64}$' AND p->>'username'='bop_'||NEW.actor_id::text
  AND p->>'status' IN('FORCE_CHANGE_PASSWORD','CONFIRMED') AND jsonb_typeof(p->'enabled')='boolean'
  AND bop_identity.workforce_onboarding_instant(p->>'createdAt') AND (p->>'createdAt')::timestamptz>=NEW.dispatch_started_at AND (p->>'createdAt')::timestamptz<=NEW.occurred_at
  AND jsonb_typeof(e)='object' AND (SELECT count(*) FROM jsonb_object_keys(e))=4 AND e->>'algorithm' IN('SYNTHETIC_AES_256_GCM','KMS_AES_256_GCM')
  AND jsonb_typeof(e->'keyReference')='string' AND length(e->>'keyReference') BETWEEN 1 AND 255
  AND length(e->>'keyReference')+(SELECT count(*) FROM regexp_split_to_table(e->>'keyReference','') AS chars(ch) WHERE ascii(ch)>65535)<=255
  AND e->>'ciphertext' ~ '^[A-Za-z0-9_-]+$' AND length(e->>'ciphertext') BETWEEN 39 AND 2048
  AND e->>'encryptionContext'=NEW.environment||':workforce-onboarding-subject:'||NEW.operator_id::text||':'||NEW.operation_id::text||':'||NEW.actor_id::text||':'||NEW.issuer) IS NOT TRUE THEN RAISE EXCEPTION 'Onboarding Provider snapshot invalid' USING ERRCODE='23514'; END IF;
 END IF;
 SELECT * INTO prior FROM bop_identity.workforce_onboarding_operation WHERE operator_id=NEW.operator_id AND operation_id=NEW.operation_id ORDER BY version DESC LIMIT 1;
 IF NOT FOUND THEN
  IF NEW.version<>1 OR NEW.state<>'Prepared' OR NEW.previous_source_digest IS NOT NULL OR NEW.dispatch_started_at IS NOT NULL OR NEW.occurred_at<>NEW.created_at THEN RAISE EXCEPTION 'Onboarding genesis invalid' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.version<>prior.version+1 OR NEW.previous_source_digest IS DISTINCT FROM prior.source_digest
  OR o IS DISTINCT FROM (prior.snapshot_text::jsonb)->'original' OR NEW.invitation_id<>prior.invitation_id OR NEW.selector_hash<>prior.selector_hash OR NEW.intent_digest<>prior.intent_digest
  OR NEW.created_at<>prior.created_at OR NEW.expires_at<>prior.expires_at OR NEW.occurred_at<prior.occurred_at
  OR (prior.state<>'Prepared' AND NEW.dispatch_started_at IS DISTINCT FROM prior.dispatch_started_at)
  OR (NEW.state='DispatchClaimed' AND (prior.state<>'Prepared' OR NEW.dispatch_started_at<>NEW.occurred_at))
  OR NOT ((prior.state='Prepared' AND NEW.state IN('DispatchClaimed','Expired','Rejected')) OR (prior.state IN('DispatchClaimed','ProviderUnknown') AND NEW.state IN('ProviderUnknown','ProviderObserved','Expired','Rejected')) OR (prior.state='ProviderObserved' AND NEW.state IN('Expired','Rejected')))
  OR (NEW.state IN('Expired','Rejected') AND p IS DISTINCT FROM (prior.snapshot_text::jsonb)->'provider') THEN RAISE EXCEPTION 'Onboarding transition invalid' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER workforce_onboarding_operation_guard BEFORE INSERT ON bop_identity.workforce_onboarding_operation FOR EACH ROW EXECUTE FUNCTION bop_identity.workforce_onboarding_operation_guard();
CREATE FUNCTION bop_identity.workforce_onboarding_operation_complete() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE o jsonb;
BEGIN
 o:=(NEW.snapshot_text::jsonb)->'original';
 IF NOT EXISTS(SELECT 1 FROM bop_identity.workforce_invitation i WHERE i.invitation_id=NEW.invitation_id AND i.actor_id=NEW.actor_id AND i.inviter_actor_id=NEW.operator_id AND i.membership_id=NEW.membership_id AND encode(i.selector_hash,'hex')=NEW.selector_hash AND encode(i.email_digest,'hex')=o->>'emailDigest' AND i.created_at=NEW.created_at AND i.expires_at=NEW.expires_at AND to_jsonb(i.store_assignment_ids)=o->'storeAssignmentReferences' AND (NEW.state NOT IN('Prepared','DispatchClaimed','ProviderUnknown') OR (i.status='Pending' AND i.version=1 AND i.provider_evidence_id IS NULL)))
 OR platform_audit.matches_workforce_onboarding_operation_audit(NEW.audit_id,NEW.operator_id,'WORKFORCE_ONBOARDING',NEW.operation_id,NEW.phase_operation_id,NEW.phase_request_digest,NEW.occurred_at,o->>'reasonCode') IS NOT TRUE THEN RAISE EXCEPTION 'Onboarding completion unavailable' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER workforce_onboarding_operation_complete AFTER INSERT ON bop_identity.workforce_onboarding_operation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_identity.workforce_onboarding_operation_complete();
REVOKE ALL ON TABLE bop_identity.workforce_onboarding_operation FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.workforce_onboarding_scope(uuid,uuid,uuid,uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.workforce_onboarding_operation_admit(uuid,uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.workforce_onboarding_operation_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.workforce_onboarding_instant(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.workforce_onboarding_operation_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.workforce_onboarding_operation_complete() FROM PUBLIC;
