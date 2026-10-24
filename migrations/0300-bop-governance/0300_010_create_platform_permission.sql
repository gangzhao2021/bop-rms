-- bop-rms-migration: 1
-- owner: @bop/permission
-- schema: bop_permission
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Global Template authority only. No Tenant/Brand/Store access or runtime bootstrap.
CREATE TABLE bop_permission.platform_permission_policy_head (
 actor_id platform_helpers.uuid_v7 NOT NULL,
 purpose_code text NOT NULL CHECK(purpose_code='PLATFORM_BRAND_TEMPLATE'),
 current_revision integer NOT NULL CHECK(current_revision>0),
 policy_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 source_digest text NOT NULL CHECK(source_digest ~ '^sha256:[a-f0-9]{64}$'),
 recorded_at timestamptz NOT NULL,
 PRIMARY KEY(actor_id,purpose_code)
);
CREATE TABLE bop_permission.platform_permission_policy_revision (
 actor_id platform_helpers.uuid_v7 NOT NULL,
 purpose_code text NOT NULL CHECK(purpose_code='PLATFORM_BRAND_TEMPLATE'),
 revision integer NOT NULL CHECK(revision>0),
 policy_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
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
 PRIMARY KEY(actor_id,purpose_code,revision),
 UNIQUE(recorded_by,purpose_code,operation_id),
 FOREIGN KEY(actor_id,purpose_code) REFERENCES bop_permission.platform_permission_policy_head(actor_id,purpose_code) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE bop_permission.platform_permission_policy_head ADD CONSTRAINT platform_permission_head_revision_fkey FOREIGN KEY(actor_id,purpose_code,current_revision) REFERENCES bop_permission.platform_permission_policy_revision(actor_id,purpose_code,revision) DEFERRABLE INITIALLY DEFERRED;
-- This capability belongs only to a reviewed direct-login provisioning role. PUBLIC gets nothing.
CREATE FUNCTION bop_permission.platform_permission_import_capable() RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$ SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=session_user
 AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
 AND has_table_privilege(session_user,'bop_permission.platform_permission_policy_revision','INSERT')
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='bop_permission' AND (pg_has_role(r.oid,c.relowner,'USAGE') OR pg_has_role(r.oid,c.relowner,'SET')))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='bop_permission' AND (pg_has_role(r.oid,n.nspowner,'USAGE') OR pg_has_role(r.oid,n.nspowner,'SET')))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles e WHERE (e.rolsuper OR e.rolbypassrls OR e.rolcreaterole OR e.rolcreatedb OR e.rolreplication) AND pg_has_role(r.oid,e.oid,'SET'))); $$;
ALTER TABLE bop_permission.platform_permission_policy_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.platform_permission_policy_head FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.platform_permission_policy_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.platform_permission_policy_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_permission_head_read ON bop_permission.platform_permission_policy_head FOR SELECT USING (
 purpose_code=current_setting('bop.platform_purpose',true) AND actor_id::text=current_setting('bop.platform_permission_subject_id',true)
 AND (actor_id::text=current_setting('bop.platform_actor_id',true) OR bop_permission.platform_permission_import_capable()));
CREATE POLICY platform_permission_revision_read ON bop_permission.platform_permission_policy_revision FOR SELECT USING (
 purpose_code=current_setting('bop.platform_purpose',true) AND (
 (actor_id::text=current_setting('bop.platform_permission_subject_id',true) AND actor_id::text=current_setting('bop.platform_actor_id',true))
 OR (bop_permission.platform_permission_import_capable() AND (actor_id::text=current_setting('bop.platform_permission_subject_id',true) OR recorded_by::text=current_setting('bop.platform_actor_id',true)))));
CREATE POLICY platform_permission_head_insert ON bop_permission.platform_permission_policy_head FOR INSERT WITH CHECK (bop_permission.platform_permission_import_capable() AND purpose_code=current_setting('bop.platform_purpose',true) AND actor_id::text=current_setting('bop.platform_permission_subject_id',true));
CREATE POLICY platform_permission_head_update ON bop_permission.platform_permission_policy_head FOR UPDATE USING (bop_permission.platform_permission_import_capable() AND purpose_code=current_setting('bop.platform_purpose',true) AND actor_id::text=current_setting('bop.platform_permission_subject_id',true)) WITH CHECK (bop_permission.platform_permission_import_capable() AND purpose_code=current_setting('bop.platform_purpose',true) AND actor_id::text=current_setting('bop.platform_permission_subject_id',true));
CREATE POLICY platform_permission_revision_insert ON bop_permission.platform_permission_policy_revision FOR INSERT WITH CHECK (bop_permission.platform_permission_import_capable() AND purpose_code=current_setting('bop.platform_purpose',true) AND actor_id::text=current_setting('bop.platform_permission_subject_id',true) AND recorded_by::text=current_setting('bop.platform_actor_id',true));
CREATE FUNCTION bop_permission.platform_permission_policy_hold(p_actor uuid,p_purpose text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF (p_actor IS NULL OR p_purpose IS NULL OR p_actor::text IS DISTINCT FROM current_setting('bop.platform_actor_id',true) OR p_actor::text IS DISTINCT FROM current_setting('bop.platform_permission_subject_id',true) OR p_purpose<>'PLATFORM_BRAND_TEMPLATE' OR p_purpose IS DISTINCT FROM current_setting('bop.platform_purpose',true)) IS NOT FALSE THEN RAISE EXCEPTION 'Platform permission scope unavailable' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM bop_permission.platform_permission_policy_head WHERE actor_id=p_actor AND purpose_code=p_purpose FOR SHARE;
END; $$;
CREATE FUNCTION bop_permission.platform_permission_import_admit(p_operator uuid,p_subject uuid,p_operation uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF (p_operator IS NULL OR p_subject IS NULL OR NOT bop_permission.platform_permission_import_capable() OR p_operator::text IS DISTINCT FROM current_setting('bop.platform_actor_id',true) OR p_subject::text IS DISTINCT FROM current_setting('bop.platform_permission_subject_id',true) OR current_setting('bop.platform_purpose',true) IS DISTINCT FROM 'PLATFORM_BRAND_TEMPLATE' OR p_operation IS NULL) IS NOT FALSE THEN RAISE EXCEPTION 'Platform permission import unavailable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('PlatformPermissionOperation:'||p_operator::text||':'||p_operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('PlatformPermissionSubject:'||p_subject::text,0));
 PERFORM 1 FROM bop_permission.platform_permission_policy_head WHERE actor_id=p_subject AND purpose_code='PLATFORM_BRAND_TEMPLATE' FOR UPDATE;
END; $$;
CREATE FUNCTION bop_permission.platform_permission_immutable() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$ BEGIN RAISE EXCEPTION 'Platform permission history immutable' USING ERRCODE='23514'; END; $$;
CREATE FUNCTION bop_permission.platform_permission_revision_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE s jsonb; c jsonb; e jsonb; o jsonb; h jsonb; previous bop_permission.platform_permission_policy_revision%ROWTYPE; f text; u text;
BEGIN
 IF (NOT bop_permission.platform_permission_import_capable() OR NEW.recorded_by::text IS DISTINCT FROM current_setting('bop.platform_actor_id',true) OR NEW.actor_id::text IS DISTINCT FROM current_setting('bop.platform_permission_subject_id',true) OR NEW.purpose_code IS DISTINCT FROM current_setting('bop.platform_purpose',true) OR NEW.writer_transaction_id<>txid_current() OR NEW.recorded_at>clock_timestamp()
 OR NOT pg_try_advisory_xact_lock(hashtextextended('PlatformPermissionOperation:'||NEW.recorded_by::text||':'||NEW.operation_id::text,0)) OR NOT pg_try_advisory_xact_lock(hashtextextended('PlatformPermissionSubject:'||NEW.actor_id::text,0))) IS NOT FALSE THEN RAISE EXCEPTION 'Platform permission write unavailable' USING ERRCODE='23514'; END IF;
 s:=NEW.snapshot_text::jsonb; c:=s->'content'; o:=s->'originalCommand'; h:=o->'expectedHead';
 IF (EXISTS(SELECT 1 FROM jsonb_each(s) WHERE key IN ('profile','actorReference','purposeCode','policyReference','operationReference','intentDigest','recordedByReference','approvedByReference','approvalEvidenceReference','reasonCode','auditReference','recordedAt','sourceDigest','classification') AND jsonb_typeof(value)<>'string')
 OR EXISTS(SELECT 1 FROM jsonb_each(o) WHERE key NOT IN ('expectedHead','content') AND jsonb_typeof(value)<>'string')
 OR EXISTS(SELECT 1 FROM jsonb_each(c) WHERE key<>'entries' AND jsonb_typeof(value)<>'string')
 OR (NEW.revision>1 AND (jsonb_typeof(s->'supersedesPolicyReference')<>'string' OR EXISTS(SELECT 1 FROM jsonb_each(h) WHERE key IN ('policyReference','sourceDigest') AND jsonb_typeof(value)<>'string')))) IS NOT FALSE THEN RAISE EXCEPTION 'Platform permission scalar type invalid' USING ERRCODE='23514'; END IF;
 IF (jsonb_typeof(s)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(s))<>18 OR NOT s ?& ARRAY['profile','actorReference','purposeCode','policyReference','revision','supersedesPolicyReference','content','operationReference','intentDigest','originalCommand','recordedByReference','approvedByReference','approvalEvidenceReference','reasonCode','auditReference','recordedAt','sourceDigest','classification']
 OR s->>'profile'<>'PlatformPermissionPolicyV1' OR s->>'classification'<>'RestrictedSecurity' OR s->>'actorReference'<>NEW.actor_id::text OR s->>'purposeCode'<>NEW.purpose_code OR s->>'policyReference'<>NEW.policy_id::text OR jsonb_typeof(s->'revision')<>'number' OR s->>'revision'<>NEW.revision::text
 OR s->>'recordedByReference'<>NEW.recorded_by::text OR s->>'approvedByReference'<>NEW.approved_by::text OR s->>'approvalEvidenceReference'<>NEW.approval_id::text OR s->>'operationReference'<>NEW.operation_id::text OR s->>'intentDigest'<>NEW.intent_digest OR s->>'auditReference'<>NEW.audit_id::text OR s->>'sourceDigest'<>NEW.source_digest
 OR s->>'recordedAt'<>to_char(NEW.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') OR s->>'reasonCode'!~'^[A-Z][A-Z0-9_]{0,127}$'
 OR jsonb_typeof(o)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(o))<>10 OR NOT o ?& ARRAY['profile','targetActorReference','purposeCode','operationReference','expectedHead','content','recordedByReference','approvedByReference','approvalEvidenceReference','reasonCode'] OR o->>'profile'<>'PlatformPermissionProvisionV1' OR o->>'targetActorReference'<>NEW.actor_id::text OR o->>'purposeCode'<>NEW.purpose_code OR o->>'operationReference'<>NEW.operation_id::text OR o->'content' IS DISTINCT FROM c OR o->>'recordedByReference'<>NEW.recorded_by::text OR o->>'approvedByReference'<>NEW.approved_by::text OR o->>'approvalEvidenceReference'<>NEW.approval_id::text OR o->>'reasonCode'<>s->>'reasonCode'
 OR jsonb_typeof(c)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(c))<>4 OR NOT c ?& ARRAY['roleCode','effectiveFrom','effectiveUntil','entries'] OR c->>'roleCode' NOT IN ('PlatformAdministrator','PlatformSupport') OR jsonb_typeof(c->'entries')<>'array' OR jsonb_array_length(c->'entries')>14) IS NOT FALSE THEN RAISE EXCEPTION 'Platform permission snapshot invalid' USING ERRCODE='23514'; END IF;
 f:=c->>'effectiveFrom'; u:=c->>'effectiveUntil';
 IF (f !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' OR u !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' OR f>=u OR f LIKE '0000-%' OR u LIKE '0000-%' OR to_char(f::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>f OR to_char(u::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>u) IS NOT FALSE THEN RAISE EXCEPTION 'Platform permission period invalid' USING ERRCODE='23514'; END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(c->'entries') LOOP
 IF (EXISTS(SELECT 1 FROM jsonb_each(e) WHERE jsonb_typeof(value)<>'string') OR jsonb_typeof(e)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(e))<>5 OR NOT e ?& ARRAY['evidenceReference','action','effect','effectiveFrom','effectiveUntil'] OR e->>'evidenceReference'!~'^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' OR e->>'action' NOT IN ('platform.operate','platform.brand-template.read','platform.brand-template.manage','platform.brand-template.submit','platform.brand-template.approve','platform.brand-template.publish','platform.brand-template.archive') OR e->>'effect' NOT IN ('Allow','Deny') OR (c->>'roleCode'='PlatformSupport' AND e->>'effect'='Allow' AND e->>'action' NOT IN ('platform.operate','platform.brand-template.read')) OR e->>'effectiveFrom'<f OR e->>'effectiveUntil'>u OR e->>'effectiveFrom'>=e->>'effectiveUntil' OR to_char((e->>'effectiveFrom')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>e->>'effectiveFrom' OR to_char((e->>'effectiveUntil')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>e->>'effectiveUntil') IS NOT FALSE THEN RAISE EXCEPTION 'Platform permission entry invalid' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF ((SELECT count(DISTINCT value->>'evidenceReference') FROM jsonb_array_elements(c->'entries'))<>jsonb_array_length(c->'entries') OR (SELECT count(DISTINCT (value->>'action',value->>'effect')) FROM jsonb_array_elements(c->'entries'))<>jsonb_array_length(c->'entries')) IS NOT FALSE THEN RAISE EXCEPTION 'Platform permission entry duplicate' USING ERRCODE='23514'; END IF;
 IF (NEW.revision=1) IS NOT FALSE THEN
 IF (h IS DISTINCT FROM 'null'::jsonb OR s->'supersedesPolicyReference' IS DISTINCT FROM 'null'::jsonb) IS NOT FALSE THEN RAISE EXCEPTION 'Platform permission genesis invalid' USING ERRCODE='23514'; END IF;
 ELSE
 SELECT * INTO previous FROM bop_permission.platform_permission_policy_revision WHERE actor_id=NEW.actor_id AND purpose_code=NEW.purpose_code AND revision=NEW.revision-1;
 IF (NOT FOUND OR jsonb_typeof(h)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(h))<>3 OR NOT h ?& ARRAY['policyReference','revision','sourceDigest'] OR jsonb_typeof(h->'revision')<>'number' OR h->>'revision'<>(NEW.revision-1)::text OR h->>'policyReference'<>previous.policy_id::text OR h->>'sourceDigest'<>previous.source_digest OR s->>'supersedesPolicyReference'<>previous.policy_id::text OR NEW.recorded_at<previous.recorded_at) IS NOT FALSE THEN RAISE EXCEPTION 'Platform permission revision invalid' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION bop_permission.platform_permission_head_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF (NOT bop_permission.platform_permission_import_capable() OR NEW.actor_id::text IS DISTINCT FROM current_setting('bop.platform_permission_subject_id',true) OR NEW.purpose_code IS DISTINCT FROM current_setting('bop.platform_purpose',true) OR (TG_OP='INSERT' AND NEW.current_revision<>1)) IS NOT FALSE THEN RAISE EXCEPTION 'Platform permission head unavailable' USING ERRCODE='23514'; END IF;
 IF (TG_OP='UPDATE') IS NOT FALSE THEN IF (NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.purpose_code IS DISTINCT FROM OLD.purpose_code OR NEW.current_revision<>OLD.current_revision+1) IS NOT FALSE THEN RAISE EXCEPTION 'Platform permission head advance invalid' USING ERRCODE='23514'; END IF; END IF;
 IF (NOT EXISTS(SELECT 1 FROM bop_permission.platform_permission_policy_revision r WHERE r.actor_id=NEW.actor_id AND r.purpose_code=NEW.purpose_code AND r.revision=NEW.current_revision AND r.policy_id=NEW.policy_id AND r.source_digest=NEW.source_digest AND r.recorded_at=NEW.recorded_at AND r.recorded_by::text=current_setting('bop.platform_actor_id',true) AND r.writer_transaction_id=txid_current())) IS NOT FALSE THEN RAISE EXCEPTION 'Platform permission head lacks same transaction revision' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION bop_permission.platform_permission_revision_complete() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE h bop_permission.platform_permission_policy_head%ROWTYPE;
BEGIN
 IF platform_audit.matches_platform_permission_audit(NEW.audit_id,NEW.recorded_by,NEW.purpose_code,NEW.policy_id,NEW.operation_id,NEW.intent_digest,NEW.recorded_at,NEW.snapshot_text::jsonb->>'reasonCode') IS NOT TRUE THEN RAISE EXCEPTION 'Platform permission Audit binding unavailable' USING ERRCODE='23514'; END IF;
 SELECT * INTO h FROM bop_permission.platform_permission_policy_head WHERE actor_id=NEW.actor_id AND purpose_code=NEW.purpose_code;
 IF (NOT FOUND OR h.current_revision<NEW.revision OR (h.current_revision=NEW.revision AND (h.policy_id<>NEW.policy_id OR h.source_digest<>NEW.source_digest OR h.recorded_at<>NEW.recorded_at))) IS NOT FALSE THEN RAISE EXCEPTION 'Platform permission revision incomplete' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE TRIGGER platform_permission_revision_guard BEFORE INSERT ON bop_permission.platform_permission_policy_revision FOR EACH ROW EXECUTE FUNCTION bop_permission.platform_permission_revision_guard();
CREATE TRIGGER platform_permission_head_guard BEFORE INSERT OR UPDATE ON bop_permission.platform_permission_policy_head FOR EACH ROW EXECUTE FUNCTION bop_permission.platform_permission_head_guard();
CREATE CONSTRAINT TRIGGER platform_permission_revision_complete AFTER INSERT ON bop_permission.platform_permission_policy_revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_permission.platform_permission_revision_complete();
CREATE TRIGGER platform_permission_revision_immutable BEFORE UPDATE OR DELETE ON bop_permission.platform_permission_policy_revision FOR EACH ROW EXECUTE FUNCTION bop_permission.platform_permission_immutable();
CREATE TRIGGER platform_permission_revision_no_truncate BEFORE TRUNCATE ON bop_permission.platform_permission_policy_revision FOR EACH STATEMENT EXECUTE FUNCTION bop_permission.platform_permission_immutable();
CREATE TRIGGER platform_permission_head_no_delete BEFORE DELETE ON bop_permission.platform_permission_policy_head FOR EACH ROW EXECUTE FUNCTION bop_permission.platform_permission_immutable();
CREATE TRIGGER platform_permission_head_no_truncate BEFORE TRUNCATE ON bop_permission.platform_permission_policy_head FOR EACH STATEMENT EXECUTE FUNCTION bop_permission.platform_permission_immutable();
REVOKE ALL ON TABLE bop_permission.platform_permission_policy_head,bop_permission.platform_permission_policy_revision FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_permission.platform_permission_import_capable() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_permission.platform_permission_policy_hold(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_permission.platform_permission_import_admit(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_permission.platform_permission_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_permission.platform_permission_revision_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_permission.platform_permission_head_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_permission.platform_permission_revision_complete() FROM PUBLIC;
