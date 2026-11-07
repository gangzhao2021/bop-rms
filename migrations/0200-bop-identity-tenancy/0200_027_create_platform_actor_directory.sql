-- bop-rms-migration: 1
-- owner: @bop/identity
-- schema: bop_identity
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- HMAC subject lookup and bound encrypted envelopes only. No public self-signup.
CREATE TABLE bop_identity.platform_actor_directory_head (
 actor_id platform_helpers.uuid_v7 PRIMARY KEY,
 environment text NOT NULL CHECK(environment ~ '^[a-z][a-z0-9-]{0,63}$'),
 issuer text NOT NULL CHECK(issuer ~ '^https://cognito-idp\.ca-central-1\.amazonaws\.com/ca-central-1_[A-Za-z0-9]{1,42}$'),
 subject_hash text NOT NULL CHECK(subject_hash ~ '^[a-f0-9]{64}$'),
 current_version integer NOT NULL CHECK(current_version>0),
 revision_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 current_status text NOT NULL CHECK(current_status IN ('Active','Suspended','Disabled')),
 source_digest text NOT NULL CHECK(source_digest ~ '^sha256:[a-f0-9]{64}$'),
 recorded_at timestamptz NOT NULL,
 UNIQUE(environment,issuer,subject_hash)
);
CREATE TABLE bop_identity.platform_actor_directory_revision (
 actor_id platform_helpers.uuid_v7 NOT NULL,
 version integer NOT NULL CHECK(version>0),
 revision_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 environment text NOT NULL,
 issuer text NOT NULL,
 subject_hash text NOT NULL CHECK(subject_hash ~ '^[a-f0-9]{64}$'),
 status text NOT NULL CHECK(status IN ('Active','Suspended','Disabled')),
 recorded_by platform_helpers.uuid_v7 NOT NULL,
 approved_by platform_helpers.uuid_v7 NOT NULL CHECK(approved_by<>recorded_by),
 approval_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 intent_digest text NOT NULL CHECK(intent_digest ~ '^sha256:[a-f0-9]{64}$'),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at) AND recorded_at>='0001-01-01Z'::timestamptz AND recorded_at<'10000-01-01Z'::timestamptz AND recorded_at=date_trunc('milliseconds',recorded_at)),
 source_digest text NOT NULL CHECK(source_digest ~ '^sha256:[a-f0-9]{64}$'),
 snapshot_text text NOT NULL CHECK(octet_length(snapshot_text)<=32768),
 writer_transaction_id bigint NOT NULL DEFAULT txid_current(),
 PRIMARY KEY(actor_id,version),
 UNIQUE(recorded_by,operation_id),
 FOREIGN KEY(actor_id) REFERENCES bop_identity.platform_actor_directory_head(actor_id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE bop_identity.platform_actor_directory_head ADD CONSTRAINT platform_actor_directory_current_fkey FOREIGN KEY(actor_id,current_version) REFERENCES bop_identity.platform_actor_directory_revision(actor_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION bop_identity.platform_actor_directory_import_capable() RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$ SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=session_user AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
 AND has_table_privilege(session_user,'bop_identity.platform_actor_directory_revision','INSERT')
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='bop_identity' AND (pg_has_role(r.oid,c.relowner,'USAGE') OR pg_has_role(r.oid,c.relowner,'SET')))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='bop_identity' AND (pg_has_role(r.oid,n.nspowner,'USAGE') OR pg_has_role(r.oid,n.nspowner,'SET')))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles e WHERE (e.rolsuper OR e.rolbypassrls OR e.rolcreaterole OR e.rolcreatedb OR e.rolreplication) AND pg_has_role(r.oid,e.oid,'SET'))); $$;
ALTER TABLE bop_identity.platform_actor_directory_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.platform_actor_directory_head FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.platform_actor_directory_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.platform_actor_directory_revision FORCE ROW LEVEL SECURITY;
-- Runtime has no table SELECT. These forced policies constrain the owner read helper.
CREATE POLICY platform_actor_directory_head_read ON bop_identity.platform_actor_directory_head FOR SELECT USING(environment=current_setting('bop.platform_directory_environment',true) AND issuer=current_setting('bop.platform_directory_issuer',true) AND (actor_id::text=current_setting('bop.platform_directory_actor_id',true) OR subject_hash=current_setting('bop.platform_directory_subject_hash',true)));
CREATE POLICY platform_actor_directory_revision_read ON bop_identity.platform_actor_directory_revision FOR SELECT USING((environment=current_setting('bop.platform_directory_environment',true) AND issuer=current_setting('bop.platform_directory_issuer',true) AND (actor_id::text=current_setting('bop.platform_directory_actor_id',true) OR subject_hash=current_setting('bop.platform_directory_subject_hash',true))) OR (bop_identity.platform_actor_directory_import_capable() AND recorded_by::text=current_setting('bop.platform_actor_id',true) AND current_setting('bop.platform_purpose',true)='PLATFORM_ACTOR_DIRECTORY'));
CREATE POLICY platform_actor_directory_head_insert ON bop_identity.platform_actor_directory_head FOR INSERT WITH CHECK(bop_identity.platform_actor_directory_import_capable() AND actor_id::text=current_setting('bop.platform_directory_actor_id',true) AND environment=current_setting('bop.platform_directory_environment',true) AND issuer=current_setting('bop.platform_directory_issuer',true) AND current_setting('bop.platform_purpose',true)='PLATFORM_ACTOR_DIRECTORY');
CREATE POLICY platform_actor_directory_head_update ON bop_identity.platform_actor_directory_head FOR UPDATE USING(environment=current_setting('bop.platform_directory_environment',true) AND issuer=current_setting('bop.platform_directory_issuer',true) AND (actor_id::text=current_setting('bop.platform_directory_actor_id',true) OR subject_hash=current_setting('bop.platform_directory_subject_hash',true))) WITH CHECK(bop_identity.platform_actor_directory_import_capable() AND actor_id::text=current_setting('bop.platform_directory_actor_id',true) AND current_setting('bop.platform_purpose',true)='PLATFORM_ACTOR_DIRECTORY');
CREATE POLICY platform_actor_directory_revision_insert ON bop_identity.platform_actor_directory_revision FOR INSERT WITH CHECK(bop_identity.platform_actor_directory_import_capable() AND recorded_by::text=current_setting('bop.platform_actor_id',true) AND actor_id::text=current_setting('bop.platform_directory_actor_id',true) AND environment=current_setting('bop.platform_directory_environment',true) AND issuer=current_setting('bop.platform_directory_issuer',true) AND current_setting('bop.platform_purpose',true)='PLATFORM_ACTOR_DIRECTORY');
CREATE FUNCTION bop_identity.platform_actor_directory_read(p_actor uuid,p_subject text,p_issuer text,p_environment text) RETURNS TABLE(snapshot_text text,source_digest text,coherent boolean) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF ((p_actor IS NULL)=(p_subject IS NULL) OR p_issuer IS DISTINCT FROM current_setting('bop.platform_directory_issuer',true) OR p_environment IS DISTINCT FROM current_setting('bop.platform_directory_environment',true) OR (p_actor IS NOT NULL AND p_actor::text IS DISTINCT FROM current_setting('bop.platform_directory_actor_id',true)) OR (p_subject IS NOT NULL AND (p_subject!~'^[a-f0-9]{64}$' OR p_subject IS DISTINCT FROM current_setting('bop.platform_directory_subject_hash',true)))) IS NOT FALSE THEN RAISE EXCEPTION 'Platform directory lookup unavailable' USING ERRCODE='23514'; END IF;
 RETURN QUERY SELECT r.snapshot_text,r.source_digest,(h.actor_id=r.actor_id AND h.environment=r.environment AND h.issuer=r.issuer AND h.subject_hash=r.subject_hash AND h.current_version=r.version AND h.revision_id=r.revision_id AND h.current_status=r.status AND h.source_digest=r.source_digest AND h.recorded_at=r.recorded_at) IS TRUE FROM bop_identity.platform_actor_directory_head h JOIN bop_identity.platform_actor_directory_revision r ON r.actor_id=h.actor_id AND r.version=h.current_version WHERE h.environment=p_environment AND h.issuer=p_issuer AND (h.actor_id=p_actor OR h.subject_hash=p_subject) FOR SHARE OF h;
END; $$;
CREATE FUNCTION bop_identity.platform_actor_directory_import_admit(p_operator uuid,p_actor uuid,p_operation uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF (p_operator IS NULL OR p_actor IS NULL OR p_operation IS NULL OR NOT bop_identity.platform_actor_directory_import_capable() OR p_operator::text IS DISTINCT FROM current_setting('bop.platform_actor_id',true) OR p_actor::text IS DISTINCT FROM current_setting('bop.platform_directory_actor_id',true) OR current_setting('bop.platform_purpose',true) IS DISTINCT FROM 'PLATFORM_ACTOR_DIRECTORY') IS NOT FALSE THEN RAISE EXCEPTION 'Platform directory import unavailable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('PlatformDirectoryOperation:'||p_operator::text||':'||p_operation::text,0));
 LOCK TABLE bop_identity.authentication_session IN SHARE ROW EXCLUSIVE MODE;
 PERFORM 1 FROM bop_identity.authentication_session WHERE actor_id=p_actor AND status='Active' AND encryption_context=current_setting('bop.platform_directory_environment',true)||':platform-session:'||session_id::text||':'||actor_id::text FOR UPDATE;
 PERFORM pg_advisory_xact_lock(hashtextextended('PlatformDirectoryActor:'||p_actor::text,0));
 PERFORM 1 FROM bop_identity.platform_actor_directory_head WHERE actor_id=p_actor FOR UPDATE;
END; $$;
CREATE FUNCTION bop_identity.platform_actor_directory_immutable() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$ BEGIN RAISE EXCEPTION 'Platform directory history immutable' USING ERRCODE='23514'; END; $$;
CREATE FUNCTION bop_identity.platform_actor_directory_revision_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE s jsonb; c jsonb; o jsonb; h jsonb; e jsonb; prior bop_identity.platform_actor_directory_revision%ROWTYPE; op text;
BEGIN
 IF (NOT bop_identity.platform_actor_directory_import_capable() OR NEW.recorded_by::text IS DISTINCT FROM current_setting('bop.platform_actor_id',true) OR NEW.actor_id::text IS DISTINCT FROM current_setting('bop.platform_directory_actor_id',true) OR NEW.issuer IS DISTINCT FROM current_setting('bop.platform_directory_issuer',true) OR NEW.environment IS DISTINCT FROM current_setting('bop.platform_directory_environment',true) OR current_setting('bop.platform_purpose',true) IS DISTINCT FROM 'PLATFORM_ACTOR_DIRECTORY' OR NEW.writer_transaction_id<>txid_current() OR NEW.recorded_at>clock_timestamp()
 OR NOT pg_try_advisory_xact_lock(hashtextextended('PlatformDirectoryOperation:'||NEW.recorded_by::text||':'||NEW.operation_id::text,0)) OR NOT pg_try_advisory_xact_lock(hashtextextended('PlatformDirectoryActor:'||NEW.actor_id::text,0)) OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid() AND relation='bop_identity.authentication_session'::regclass AND mode='ShareRowExclusiveLock' AND granted)) IS NOT FALSE THEN RAISE EXCEPTION 'Platform directory write unavailable' USING ERRCODE='23514'; END IF;
 s:=NEW.snapshot_text::jsonb;c:=s->'configuration';o:=s->'originalCommand';h:=o->'expectedHead';e:=s->'encryptedSubject';op:=o->>'operation';
 IF (jsonb_typeof(s)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(s))<>20 OR NOT s ?& ARRAY['profile','actorReference','configuration','subjectHash','encryptedSubject','revisionReference','version','supersedesRevisionReference','status','operationReference','intentDigest','originalCommand','recordedByReference','approvedByReference','approvalReference','reasonCode','auditReference','recordedAt','sourceDigest','classification'] OR EXISTS(SELECT 1 FROM jsonb_each(s) WHERE key NOT IN ('configuration','encryptedSubject','version','supersedesRevisionReference','originalCommand') AND jsonb_typeof(value)<>'string')
 OR s->>'profile'<>'PlatformActorDirectoryRevisionV1' OR s->>'classification'<>'RestrictedSecurity' OR s->>'actorReference'<>NEW.actor_id::text OR s->>'subjectHash'<>NEW.subject_hash OR s->>'revisionReference'<>NEW.revision_id::text OR jsonb_typeof(s->'version')<>'number' OR s->>'version'<>NEW.version::text OR s->>'status'<>NEW.status OR s->>'operationReference'<>NEW.operation_id::text OR s->>'intentDigest'<>NEW.intent_digest OR s->>'recordedByReference'<>NEW.recorded_by::text OR s->>'approvedByReference'<>NEW.approved_by::text OR s->>'approvalReference'<>NEW.approval_id::text OR s->>'auditReference'<>NEW.audit_id::text OR s->>'sourceDigest'<>NEW.source_digest OR s->>'recordedAt'<>to_char(NEW.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') OR s->>'reasonCode'!~'^[A-Z][A-Z0-9_]{0,127}$'
 OR jsonb_typeof(c)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(c))<>3 OR NOT c ?& ARRAY['environment','issuer','clientIds'] OR jsonb_typeof(c->'environment')<>'string' OR jsonb_typeof(c->'issuer')<>'string' OR c->>'environment'<>NEW.environment OR c->>'issuer'<>NEW.issuer OR NEW.environment!~'^[a-z][a-z0-9-]{0,63}$' OR NEW.issuer!~'^https://cognito-idp\.ca-central-1\.amazonaws\.com/ca-central-1_[A-Za-z0-9]{1,42}$' OR jsonb_typeof(c->'clientIds')<>'array' OR jsonb_array_length(c->'clientIds') NOT BETWEEN 1 AND 8 OR EXISTS(SELECT 1 FROM jsonb_array_elements(c->'clientIds') WHERE jsonb_typeof(value)<>'string' OR value#>>'{}'!~'^[A-Za-z0-9]{1,128}$') OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(c->'clientIds'))<>jsonb_array_length(c->'clientIds')
 OR jsonb_typeof(e)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(e))<>4 OR NOT e ?& ARRAY['algorithm','keyReference','ciphertext','encryptionContext'] OR EXISTS(SELECT 1 FROM jsonb_each(e) WHERE jsonb_typeof(value)<>'string') OR e->>'algorithm' NOT IN ('SYNTHETIC_AES_256_GCM','KMS_AES_256_GCM') OR length(e->>'keyReference') NOT BETWEEN 1 AND 255 OR length(e->>'ciphertext') NOT BETWEEN 39 AND 2048 OR e->>'ciphertext'!~'^[A-Za-z0-9_-]+$' OR e->>'encryptionContext'<>NEW.environment||':platform-actor-subject:'||NEW.actor_id::text||':'||NEW.issuer
 OR jsonb_typeof(o)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(o))<>10 OR NOT o ?& ARRAY['profile','operation','operationReference','actorReference','expectedHead','subjectHash','recordedByReference','approvedByReference','approvalReference','reasonCode'] OR EXISTS(SELECT 1 FROM jsonb_each(o) WHERE key<>'expectedHead' AND jsonb_typeof(value)<>'string') OR o->>'profile'<>'PlatformActorDirectoryCommandV1' OR op NOT IN ('ImportActive','Suspend','Disable','Restore') OR o->>'actorReference'<>NEW.actor_id::text OR o->>'subjectHash'<>NEW.subject_hash OR o->>'operationReference'<>NEW.operation_id::text OR o->>'recordedByReference'<>NEW.recorded_by::text OR o->>'approvedByReference'<>NEW.approved_by::text OR o->>'approvalReference'<>NEW.approval_id::text OR o->>'reasonCode'<>s->>'reasonCode' OR NEW.status<>CASE op WHEN 'Suspend' THEN 'Suspended' WHEN 'Disable' THEN 'Disabled' ELSE 'Active' END) IS NOT FALSE THEN RAISE EXCEPTION 'Platform directory snapshot invalid' USING ERRCODE='23514'; END IF;
 IF NEW.version=1 THEN
 IF (op<>'ImportActive' OR h IS DISTINCT FROM 'null'::jsonb OR s->'supersedesRevisionReference' IS DISTINCT FROM 'null'::jsonb) IS NOT FALSE THEN RAISE EXCEPTION 'Platform directory genesis invalid' USING ERRCODE='23514'; END IF;
 ELSE
 SELECT * INTO prior FROM bop_identity.platform_actor_directory_revision WHERE actor_id=NEW.actor_id AND version=NEW.version-1;
 IF (NOT FOUND OR op='ImportActive' OR prior.environment<>NEW.environment OR prior.issuer<>NEW.issuer OR prior.subject_hash<>NEW.subject_hash OR prior.snapshot_text::jsonb->'encryptedSubject' IS DISTINCT FROM e OR prior.snapshot_text::jsonb->'configuration' IS DISTINCT FROM c OR NEW.recorded_at<prior.recorded_at OR jsonb_typeof(h)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(h))<>3 OR NOT h ?& ARRAY['revisionReference','version','sourceDigest'] OR jsonb_typeof(h->'version')<>'number' OR jsonb_typeof(h->'revisionReference')<>'string' OR jsonb_typeof(h->'sourceDigest')<>'string' OR h->>'version'<>(NEW.version-1)::text OR h->>'revisionReference'<>prior.revision_id::text OR h->>'sourceDigest'<>prior.source_digest OR jsonb_typeof(s->'supersedesRevisionReference')<>'string' OR s->>'supersedesRevisionReference'<>prior.revision_id::text OR (op='Suspend' AND prior.status<>'Active') OR (op='Disable' AND prior.status='Disabled') OR (op='Restore' AND prior.status='Active')) IS NOT FALSE THEN RAISE EXCEPTION 'Platform directory revision invalid' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION bop_identity.platform_actor_directory_head_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF (NOT bop_identity.platform_actor_directory_import_capable() OR NEW.actor_id::text IS DISTINCT FROM current_setting('bop.platform_directory_actor_id',true) OR current_setting('bop.platform_purpose',true) IS DISTINCT FROM 'PLATFORM_ACTOR_DIRECTORY' OR (TG_OP='INSERT' AND NEW.current_version<>1)) IS NOT FALSE THEN RAISE EXCEPTION 'Platform directory head unavailable' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN IF (NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.environment IS DISTINCT FROM OLD.environment OR NEW.issuer IS DISTINCT FROM OLD.issuer OR NEW.subject_hash IS DISTINCT FROM OLD.subject_hash OR NEW.current_version<>OLD.current_version+1) IS NOT FALSE THEN RAISE EXCEPTION 'Platform directory binding immutable' USING ERRCODE='23514'; END IF; END IF;
 IF NOT EXISTS(SELECT 1 FROM bop_identity.platform_actor_directory_revision r WHERE r.actor_id=NEW.actor_id AND r.version=NEW.current_version AND r.revision_id=NEW.revision_id AND r.environment=NEW.environment AND r.issuer=NEW.issuer AND r.subject_hash=NEW.subject_hash AND r.status=NEW.current_status AND r.source_digest=NEW.source_digest AND r.recorded_at=NEW.recorded_at AND r.recorded_by::text=current_setting('bop.platform_actor_id',true) AND r.writer_transaction_id=txid_current()) THEN RAISE EXCEPTION 'Platform directory lacks same transaction revision' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION bop_identity.platform_actor_directory_complete() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE h bop_identity.platform_actor_directory_head%ROWTYPE;
BEGIN
 IF platform_audit.matches_platform_actor_directory_audit(NEW.audit_id,NEW.recorded_by,'PLATFORM_ACTOR_DIRECTORY',NEW.revision_id,NEW.operation_id,NEW.intent_digest,NEW.recorded_at,NEW.snapshot_text::jsonb->>'reasonCode') IS NOT TRUE THEN RAISE EXCEPTION 'Platform directory Audit binding unavailable' USING ERRCODE='23514'; END IF;
 SELECT * INTO h FROM bop_identity.platform_actor_directory_head WHERE actor_id=NEW.actor_id;
 IF (NOT FOUND OR h.current_version<NEW.version OR (h.current_version=NEW.version AND (h.revision_id<>NEW.revision_id OR h.source_digest<>NEW.source_digest OR h.current_status<>NEW.status OR h.recorded_at<>NEW.recorded_at)) OR (NEW.status<>'Active' AND EXISTS(SELECT 1 FROM bop_identity.authentication_session WHERE actor_id=NEW.actor_id AND status='Active' AND encryption_context=NEW.environment||':platform-session:'||session_id::text||':'||actor_id::text))) IS NOT FALSE THEN RAISE EXCEPTION 'Platform directory revision incomplete' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE TRIGGER platform_actor_directory_revision_guard BEFORE INSERT ON bop_identity.platform_actor_directory_revision FOR EACH ROW EXECUTE FUNCTION bop_identity.platform_actor_directory_revision_guard();
CREATE TRIGGER platform_actor_directory_head_guard BEFORE INSERT OR UPDATE ON bop_identity.platform_actor_directory_head FOR EACH ROW EXECUTE FUNCTION bop_identity.platform_actor_directory_head_guard();
CREATE CONSTRAINT TRIGGER platform_actor_directory_complete AFTER INSERT ON bop_identity.platform_actor_directory_revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_identity.platform_actor_directory_complete();
CREATE TRIGGER platform_actor_directory_revision_immutable BEFORE UPDATE OR DELETE ON bop_identity.platform_actor_directory_revision FOR EACH ROW EXECUTE FUNCTION bop_identity.platform_actor_directory_immutable();
CREATE TRIGGER platform_actor_directory_revision_no_truncate BEFORE TRUNCATE ON bop_identity.platform_actor_directory_revision FOR EACH STATEMENT EXECUTE FUNCTION bop_identity.platform_actor_directory_immutable();
CREATE TRIGGER platform_actor_directory_head_no_delete BEFORE DELETE ON bop_identity.platform_actor_directory_head FOR EACH ROW EXECUTE FUNCTION bop_identity.platform_actor_directory_immutable();
CREATE TRIGGER platform_actor_directory_head_no_truncate BEFORE TRUNCATE ON bop_identity.platform_actor_directory_head FOR EACH STATEMENT EXECUTE FUNCTION bop_identity.platform_actor_directory_immutable();
REVOKE ALL ON TABLE bop_identity.platform_actor_directory_head,bop_identity.platform_actor_directory_revision FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.platform_actor_directory_import_capable() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.platform_actor_directory_read(uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.platform_actor_directory_import_admit(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.platform_actor_directory_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.platform_actor_directory_revision_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.platform_actor_directory_head_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_identity.platform_actor_directory_complete() FROM PUBLIC;
