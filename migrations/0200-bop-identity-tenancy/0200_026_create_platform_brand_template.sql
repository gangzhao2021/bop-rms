-- bop-rms-migration: 1
-- owner: @bop/tenant
-- schema: bop_tenant
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Global Platform-owned locale/inheritance material, never a Brand or release.
CREATE TABLE bop_tenant.platform_brand_template_revision (
 template_id platform_helpers.uuid_v7 NOT NULL,
 version_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
 code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
 source_digest text NOT NULL CHECK (source_digest ~ '^sha256:[0-9a-f]{64}$'),
 snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=32768),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at) AND created_at>='0001-01-01T00:00:00Z'::timestamptz AND created_at<'10000-01-01T00:00:00Z'::timestamptz),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at) AND recorded_at>='0001-01-01T00:00:00Z'::timestamptz AND recorded_at<'10000-01-01T00:00:00Z'::timestamptz),
 PRIMARY KEY(template_id,revision),
 UNIQUE(actor_id,operation_id),
 UNIQUE(template_id,version_id,revision),
 CHECK(created_at<=recorded_at AND created_at=date_trunc('milliseconds',created_at) AND recorded_at=date_trunc('milliseconds',recorded_at))
);
CREATE TABLE bop_tenant.platform_brand_template_operation (
 actor_id platform_helpers.uuid_v7 NOT NULL,
 purpose_code text NOT NULL CHECK(purpose_code='PLATFORM_BRAND_TEMPLATE'),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 intent_digest text NOT NULL CHECK(intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 outcome text NOT NULL CHECK(outcome IN ('Committed','Abandoned')),
 template_id platform_helpers.uuid_v7,
 version_id platform_helpers.uuid_v7,
 revision integer,
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 command_json jsonb,
 receipt_json jsonb NOT NULL CHECK(jsonb_typeof(receipt_json)='object' AND octet_length(receipt_json::text)<=32768),
 receipt_digest text NOT NULL CHECK(receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
 occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at) AND occurred_at>='0001-01-01T00:00:00Z'::timestamptz AND occurred_at<'10000-01-01T00:00:00Z'::timestamptz AND occurred_at=date_trunc('milliseconds',occurred_at)),
 PRIMARY KEY(actor_id,purpose_code,operation_id),
 CHECK ((outcome='Committed' AND template_id IS NOT NULL AND version_id IS NOT NULL AND revision IS NOT NULL AND command_json IS NOT NULL)
  OR (outcome='Abandoned' AND template_id IS NULL AND version_id IS NULL AND revision IS NULL AND command_json IS NULL)),
 CONSTRAINT platform_brand_template_operation_revision_fkey FOREIGN KEY(template_id,version_id,revision)
  REFERENCES bop_tenant.platform_brand_template_revision(template_id,version_id,revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX platform_brand_template_code_idx ON bop_tenant.platform_brand_template_revision(code,template_id,revision);
-- NULL operation is read-only admission; actual public owner requests a global
-- SHARE fence without requiring mutation ACLs on the application role.
CREATE FUNCTION bop_tenant.platform_brand_template_operation_admit(
 actual_actor platform_helpers.uuid_v7, original_operation platform_helpers.uuid_v7
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF actual_actor IS NULL OR actual_actor::text IS DISTINCT FROM NULLIF(current_setting('bop.platform_actor_id',true),'')
  OR NULLIF(current_setting('bop.platform_purpose',true),'') IS DISTINCT FROM 'PLATFORM_BRAND_TEMPLATE'
 THEN RAISE EXCEPTION 'platform template admission refused' USING ERRCODE='23514'; END IF;
 IF original_operation IS NULL THEN
  LOCK TABLE bop_tenant.platform_brand_template_revision IN SHARE MODE;
 ELSE
  PERFORM pg_advisory_xact_lock(hashtextextended('PlatformBrandTemplateOperation:'||actual_actor::text||':PLATFORM_BRAND_TEMPLATE:'||original_operation::text,0));
  LOCK TABLE bop_tenant.platform_brand_template_revision IN SHARE ROW EXCLUSIVE MODE;
 END IF;
END $$;
REVOKE ALL ON FUNCTION bop_tenant.platform_brand_template_operation_admit(platform_helpers.uuid_v7,platform_helpers.uuid_v7) FROM PUBLIC;
CREATE FUNCTION bop_tenant.platform_brand_template_insert_admit() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE snapshot jsonb; content jsonb; prior bop_tenant.platform_brand_template_revision%ROWTYPE; codes jsonb; member jsonb; field text;
BEGIN
 IF NULLIF(current_setting('bop.platform_purpose',true),'') IS DISTINCT FROM 'PLATFORM_BRAND_TEMPLATE'
  OR NEW.actor_id::text IS DISTINCT FROM NULLIF(current_setting('bop.platform_actor_id',true),'')
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid() AND locktype='relation'
    AND relation='bop_tenant.platform_brand_template_revision'::regclass AND mode='ShareRowExclusiveLock' AND granted)
  OR NOT pg_try_advisory_xact_lock(hashtextextended('PlatformBrandTemplateOperation:'||NEW.actor_id::text||':PLATFORM_BRAND_TEMPLATE:'||NEW.operation_id::text,0))
 THEN RAISE EXCEPTION 'platform template admission refused' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='platform_brand_template_operation' THEN RETURN NEW; END IF;
 snapshot:=NEW.snapshot_json;content:=snapshot->'content';
 IF (SELECT count(*) FROM jsonb_object_keys(snapshot))<>15
  OR NOT snapshot ?& ARRAY['profile','templateReference','templateVersionReference','revision','recordKind','content','supersedesVersionReference','authoredByReference','operationReference','auditReference','createdAt','recordedAt','contentDigest','sourceDigest','dataClassification']
  OR snapshot->>'profile' IS DISTINCT FROM 'PlatformBrandTemplateRevisionV1'
  OR snapshot->>'recordKind' IS DISTINCT FROM 'AuthoredContent'
  OR snapshot->>'dataClassification' IS DISTINCT FROM 'ConfigurationMetadata'
  OR snapshot->>'templateReference' IS DISTINCT FROM NEW.template_id::text
  OR snapshot->>'templateVersionReference' IS DISTINCT FROM NEW.version_id::text
  OR jsonb_typeof(snapshot->'revision') IS DISTINCT FROM 'number' OR snapshot->>'revision' IS DISTINCT FROM NEW.revision::text
  OR snapshot->>'authoredByReference' IS DISTINCT FROM NEW.actor_id::text
  OR snapshot->>'operationReference' IS DISTINCT FROM NEW.operation_id::text
  OR snapshot->>'auditReference' IS DISTINCT FROM NEW.audit_id::text
  OR snapshot->>'contentDigest' IS DISTINCT FROM NEW.content_digest
  OR snapshot->>'sourceDigest' IS DISTINCT FROM NEW.source_digest
  OR snapshot->>'createdAt' IS DISTINCT FROM to_char(NEW.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  OR snapshot->>'recordedAt' IS DISTINCT FROM to_char(NEW.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  OR jsonb_typeof(content) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'platform template revision invalid' USING ERRCODE='23514'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(content))<>9
  OR NOT content ?& ARRAY['code','name','defaultLocale','supportedLocales','overrideAllowedFieldCodes','hardRequirementFieldCodes','effectiveFrom','effectiveUntil','reasonCode']
  OR content->>'code' IS DISTINCT FROM NEW.code
  OR jsonb_typeof(content->'name') IS DISTINCT FROM 'string' OR char_length(content->>'name') NOT BETWEEN 1 AND 160
  OR btrim(content->>'name') IS DISTINCT FROM content->>'name' OR content->>'name' ~ '[[:cntrl:]<>]'
  OR jsonb_typeof(content->'reasonCode') IS DISTINCT FROM 'string' OR NOT content->>'reasonCode' ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'
  OR jsonb_typeof(content->'defaultLocale') IS DISTINCT FROM 'string' OR NOT content->>'defaultLocale' ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|[0-9]{3})$'
  OR jsonb_typeof(content->'effectiveFrom') IS DISTINCT FROM 'string' OR NOT content->>'effectiveFrom' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  OR ((content->>'effectiveUntil') IS NOT NULL AND (jsonb_typeof(content->'effectiveUntil') IS DISTINCT FROM 'string' OR NOT content->>'effectiveUntil' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' OR (content->>'effectiveUntil')::timestamptz<=(content->>'effectiveFrom')::timestamptz))
 THEN RAISE EXCEPTION 'platform template content invalid' USING ERRCODE='23514'; END IF;
 IF content->>'effectiveFrom' IS DISTINCT FROM to_char((content->>'effectiveFrom')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  OR ((content->>'effectiveUntil') IS NOT NULL AND content->>'effectiveUntil' IS DISTINCT FROM to_char((content->>'effectiveUntil')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
 THEN RAISE EXCEPTION 'platform template canonical time invalid' USING ERRCODE='23514'; END IF;
 FOREACH field IN ARRAY ARRAY['supportedLocales','overrideAllowedFieldCodes','hardRequirementFieldCodes'] LOOP
  codes:=content->field;
  IF jsonb_typeof(codes) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'platform template set invalid' USING ERRCODE='23514'; END IF;
  IF jsonb_array_length(codes)>(CASE WHEN field='supportedLocales' THEN 20 ELSE 100 END)
   OR (field='supportedLocales' AND (jsonb_array_length(codes)=0 OR NOT codes ? (content->>'defaultLocale')))
   OR (SELECT count(*) FROM jsonb_array_elements(codes))<>(SELECT count(DISTINCT value) FROM jsonb_array_elements(codes))
  THEN RAISE EXCEPTION 'platform template set invalid' USING ERRCODE='23514'; END IF;
  FOR member IN SELECT value FROM jsonb_array_elements(codes) LOOP
   IF jsonb_typeof(member)<>'string' OR NOT (member#>>'{}') ~ (CASE WHEN field='supportedLocales' THEN '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|[0-9]{3})$' ELSE '^[A-Z][A-Z0-9_.:-]{0,63}$' END)
   THEN RAISE EXCEPTION 'platform template member invalid' USING ERRCODE='23514'; END IF;
  END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(content->'hardRequirementFieldCodes') hard WHERE (content->'overrideAllowedFieldCodes') @> jsonb_build_array(hard.value))
 THEN RAISE EXCEPTION 'platform hard requirement conflict' USING ERRCODE='23514'; END IF;
 SELECT * INTO prior FROM bop_tenant.platform_brand_template_revision WHERE template_id=NEW.template_id ORDER BY revision DESC LIMIT 1;
 IF (NOT FOUND AND (NEW.revision<>1 OR snapshot->'supersedesVersionReference' IS DISTINCT FROM 'null'::jsonb OR NEW.created_at<>NEW.recorded_at))
  OR (FOUND AND (NEW.revision<>prior.revision+1 OR snapshot->>'supersedesVersionReference' IS DISTINCT FROM prior.version_id::text OR NEW.code<>prior.code OR NEW.created_at<>prior.created_at OR NEW.recorded_at<prior.recorded_at))
  OR EXISTS(SELECT 1 FROM bop_tenant.platform_brand_template_revision WHERE code=NEW.code AND template_id<>NEW.template_id)
 THEN RAISE EXCEPTION 'platform template sequence conflict' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER platform_brand_template_revision_admission BEFORE INSERT ON bop_tenant.platform_brand_template_revision FOR EACH ROW EXECUTE FUNCTION bop_tenant.platform_brand_template_insert_admit();
CREATE TRIGGER platform_brand_template_operation_admission BEFORE INSERT ON bop_tenant.platform_brand_template_operation FOR EACH ROW EXECUTE FUNCTION bop_tenant.platform_brand_template_insert_admit();
CREATE FUNCTION bop_tenant.platform_brand_template_coherence() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE original bop_tenant.platform_brand_template_operation%ROWTYPE; material bop_tenant.platform_brand_template_revision%ROWTYPE; receipt jsonb; command jsonb; expected jsonb;
BEGIN
 SELECT * INTO original FROM bop_tenant.platform_brand_template_operation WHERE actor_id=NEW.actor_id AND operation_id=NEW.operation_id AND purpose_code='PLATFORM_BRAND_TEMPLATE';
 IF NOT FOUND THEN RAISE EXCEPTION 'platform template original missing' USING ERRCODE='23514'; END IF;
 receipt:=original.receipt_json;command:=original.command_json;
 IF (SELECT count(*) FROM jsonb_object_keys(receipt))<>12 OR NOT receipt ?& ARRAY['profile','kind','actorReference','purposeCode','operationReference','intentDigest','originalCommand','outcome','snapshot','auditReference','occurredAt','dataClassification']
  OR receipt->>'profile' IS DISTINCT FROM 'PlatformBrandTemplateOperationV1' OR receipt->>'kind' IS DISTINCT FROM 'Platform'
  OR receipt->>'actorReference' IS DISTINCT FROM original.actor_id::text OR receipt->>'purposeCode' IS DISTINCT FROM original.purpose_code
  OR receipt->>'operationReference' IS DISTINCT FROM original.operation_id::text OR receipt->>'intentDigest' IS DISTINCT FROM original.intent_digest
  OR receipt->>'outcome' IS DISTINCT FROM original.outcome OR receipt->>'auditReference' IS DISTINCT FROM original.audit_id::text
  OR receipt->>'occurredAt' IS DISTINCT FROM to_char(original.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  OR receipt->>'dataClassification' IS DISTINCT FROM 'ConfigurationMetadata'
 THEN RAISE EXCEPTION 'platform template terminal invalid' USING ERRCODE='23514'; END IF;
 IF original.outcome='Abandoned' THEN
  IF receipt->'originalCommand' IS DISTINCT FROM 'null'::jsonb OR receipt->'snapshot' IS DISTINCT FROM 'null'::jsonb OR EXISTS(SELECT 1 FROM bop_tenant.platform_brand_template_revision WHERE actor_id=original.actor_id AND operation_id=original.operation_id)
  THEN RAISE EXCEPTION 'platform template abandoned conflict' USING ERRCODE='23514'; END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO material FROM bop_tenant.platform_brand_template_revision WHERE template_id=original.template_id AND version_id=original.version_id AND revision=original.revision;
 IF NOT FOUND OR material.actor_id<>original.actor_id OR material.operation_id<>original.operation_id OR material.audit_id<>original.audit_id OR material.recorded_at<>original.occurred_at
  OR receipt->'snapshot' IS DISTINCT FROM material.snapshot_json OR receipt->'originalCommand' IS DISTINCT FROM command
  OR jsonb_typeof(command) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'platform template committed conflict' USING ERRCODE='23514'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(command))<>8 OR NOT command ?& ARRAY['profile','kind','actorReference','purposeCode','operationReference','templateReference','expectedHead','content']
  OR command->>'profile' IS DISTINCT FROM 'PlatformBrandTemplateSaveV1' OR command->>'kind' IS DISTINCT FROM 'Platform'
  OR command->>'actorReference' IS DISTINCT FROM original.actor_id::text OR command->>'purposeCode' IS DISTINCT FROM original.purpose_code OR command->>'operationReference' IS DISTINCT FROM original.operation_id::text
  OR command->'content' IS DISTINCT FROM material.snapshot_json->'content'
 THEN RAISE EXCEPTION 'platform template original invalid' USING ERRCODE='23514'; END IF;
 expected:=command->'expectedHead';
 IF material.revision=1 THEN
  IF command->'templateReference' IS DISTINCT FROM 'null'::jsonb OR expected IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'platform template first original invalid' USING ERRCODE='23514'; END IF;
 ELSE
  IF command->>'templateReference' IS DISTINCT FROM material.template_id::text OR jsonb_typeof(expected) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'platform template base invalid' USING ERRCODE='23514'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(expected))<>3 OR NOT expected ?& ARRAY['revision','templateVersionReference','sourceDigest']
   OR jsonb_typeof(expected->'revision') IS DISTINCT FROM 'number'
   OR NOT EXISTS(SELECT 1 FROM bop_tenant.platform_brand_template_revision prior WHERE prior.template_id=material.template_id AND prior.revision=material.revision-1 AND expected->>'revision'=prior.revision::text AND expected->>'templateVersionReference'=prior.version_id::text AND expected->>'sourceDigest'=prior.source_digest)
  THEN RAISE EXCEPTION 'platform template base conflict' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER platform_brand_template_revision_coherence AFTER INSERT ON bop_tenant.platform_brand_template_revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_tenant.platform_brand_template_coherence();
CREATE CONSTRAINT TRIGGER platform_brand_template_operation_coherence AFTER INSERT ON bop_tenant.platform_brand_template_operation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_tenant.platform_brand_template_coherence();
CREATE FUNCTION bop_tenant.platform_brand_template_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'platform template history immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER platform_brand_template_revision_immutable BEFORE UPDATE OR DELETE ON bop_tenant.platform_brand_template_revision FOR EACH ROW EXECUTE FUNCTION bop_tenant.platform_brand_template_immutable();
CREATE TRIGGER platform_brand_template_operation_immutable BEFORE UPDATE OR DELETE ON bop_tenant.platform_brand_template_operation FOR EACH ROW EXECUTE FUNCTION bop_tenant.platform_brand_template_immutable();
ALTER TABLE bop_tenant.platform_brand_template_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.platform_brand_template_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.platform_brand_template_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.platform_brand_template_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_brand_template_revision_read ON bop_tenant.platform_brand_template_revision FOR SELECT USING (current_setting('bop.platform_purpose',true)='PLATFORM_BRAND_TEMPLATE' AND current_setting('bop.platform_actor_id',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
CREATE POLICY platform_brand_template_revision_insert ON bop_tenant.platform_brand_template_revision FOR INSERT WITH CHECK(current_setting('bop.platform_purpose',true)='PLATFORM_BRAND_TEMPLATE' AND actor_id::text=current_setting('bop.platform_actor_id',true));
CREATE POLICY platform_brand_template_operation_read ON bop_tenant.platform_brand_template_operation FOR SELECT USING(current_setting('bop.platform_purpose',true)='PLATFORM_BRAND_TEMPLATE' AND current_setting('bop.platform_actor_id',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND (actor_id::text=current_setting('bop.platform_actor_id',true) OR outcome='Committed'));
CREATE POLICY platform_brand_template_operation_insert ON bop_tenant.platform_brand_template_operation FOR INSERT WITH CHECK(current_setting('bop.platform_purpose',true)='PLATFORM_BRAND_TEMPLATE' AND actor_id::text=current_setting('bop.platform_actor_id',true));
REVOKE ALL ON TABLE bop_tenant.platform_brand_template_revision,bop_tenant.platform_brand_template_operation FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_tenant.platform_brand_template_insert_admit() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_tenant.platform_brand_template_coherence() FROM PUBLIC;
REVOKE ALL ON FUNCTION bop_tenant.platform_brand_template_immutable() FROM PUBLIC;
