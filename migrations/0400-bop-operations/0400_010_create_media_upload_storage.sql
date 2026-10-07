-- bop-rms-migration: 1
-- owner: @bop/media
-- schema: bop_media
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Upload/finalization storage only. Processing/promotion must be additive;
-- no statement in this migration makes an uploaded object usable.
CREATE SCHEMA bop_media;
REVOKE ALL ON SCHEMA bop_media FROM PUBLIC;

CREATE TABLE bop_media.upload_session (
  upload_session_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  version bigint NOT NULL CHECK (version IN (1,2)),
  state text NOT NULL CHECK ((version=1 AND state='Pending') OR (version=2 AND state='Finalized')),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at) AND expires_at=date_trunc('milliseconds',expires_at)),
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=65536),
  UNIQUE (tenant_id,brand_id,upload_session_id)
);
CREATE TABLE bop_media.asset (
  asset_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  version bigint NOT NULL CHECK (version=1),
  current_version_id platform_helpers.uuid_v7 CHECK (current_version_id IS NULL),
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=65536),
  UNIQUE (tenant_id,brand_id,asset_id)
);
CREATE TABLE bop_media.asset_version (
  asset_version_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  asset_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  upload_session_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  version bigint NOT NULL CHECK (version=1),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=65536),
  UNIQUE (tenant_id,brand_id,asset_version_id),
  FOREIGN KEY (tenant_id,brand_id,asset_id) REFERENCES bop_media.asset(tenant_id,brand_id,asset_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id,brand_id,upload_session_id) REFERENCES bop_media.upload_session(tenant_id,brand_id,upload_session_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE bop_media.operation_record (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  action_code text NOT NULL CHECK (action_code IN ('CreateUpload','FinalizeAsset')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  upload_session_id platform_helpers.uuid_v7 NOT NULL,
  asset_id platform_helpers.uuid_v7,
  asset_version_id platform_helpers.uuid_v7,
  recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
  command_json jsonb NOT NULL CHECK (jsonb_typeof(command_json)='object' AND octet_length(command_json::text)<=262144),
  result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json)='object' AND octet_length(result_json::text)<=262144),
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  UNIQUE (upload_session_id,action_code),
  CHECK ((action_code='CreateUpload' AND asset_id IS NULL AND asset_version_id IS NULL)
    OR (action_code='FinalizeAsset' AND asset_id IS NOT NULL AND asset_version_id IS NOT NULL)),
  FOREIGN KEY (tenant_id,brand_id,upload_session_id) REFERENCES bop_media.upload_session(tenant_id,brand_id,upload_session_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id,brand_id,asset_id) REFERENCES bop_media.asset(tenant_id,brand_id,asset_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id,brand_id,asset_version_id) REFERENCES bop_media.asset_version(tenant_id,brand_id,asset_version_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION bop_media.guard_media_upload_storage()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  body jsonb;
  input_body jsonb;
  audit_body jsonb;
  scope_body jsonb;
  expected_keys text[];
  created_text text;
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  instant_pattern constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$';
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') OR (TG_OP='UPDATE' AND TG_TABLE_NAME<>'upload_session') THEN
    RAISE EXCEPTION 'MEDIA_UPLOAD_STORAGE_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF TG_TABLE_NAME='upload_session' THEN
    IF (TG_OP='INSERT' AND (NEW.version<>1 OR NEW.state<>'Pending')) OR
      (TG_OP='UPDATE' AND (OLD.state<>'Pending' OR OLD.version<>1 OR NEW.state<>'Finalized' OR NEW.version<>OLD.version+1
        OR (to_jsonb(NEW)-ARRAY['version','state','snapshot_json']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['version','state','snapshot_json'])
        OR (NEW.snapshot_json-ARRAY['version','state']) IS DISTINCT FROM (OLD.snapshot_json-ARRAY['version','state']))) THEN
      RAISE EXCEPTION 'MEDIA_UPLOAD_STORAGE_IMMUTABLE' USING ERRCODE='55000';
    END IF;
    body:=NEW.snapshot_json;
    expected_keys:=ARRAY['uploadSessionId','grantReference','actorReference','purpose','scope','mediaKind','declaredContentType','declaredByteSize','ownerType','ownerReference','classification','state','version','createdAt','expiresAt'];
    IF NOT ((body ?& expected_keys AND body-expected_keys='{}'::jsonb
      AND body->'uploadSessionId'=to_jsonb(NEW.upload_session_id::text)
      AND jsonb_typeof(body->'grantReference')='string' AND body->>'grantReference' ~ uuid_pattern
      AND body->'actorReference'=to_jsonb(NEW.actor_id::text)
      AND body->'version'=to_jsonb(NEW.version) AND body->'state'=to_jsonb(NEW.state)
      AND body->'expiresAt'=to_jsonb(to_char(NEW.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      AND jsonb_typeof(body->'createdAt')='string' AND body->>'createdAt' ~ instant_pattern
      AND jsonb_typeof(body->'declaredByteSize')='number' AND body->>'declaredByteSize' ~ '^[0-9]+$'
      AND (body->>'declaredByteSize')::numeric BETWEEN 1 AND 100000000
      AND jsonb_typeof(body->'declaredContentType')='string'
      AND body->>'declaredContentType' ~ '^(image|video)/[a-z0-9][a-z0-9.+-]{0,63}$'
      AND ((body->>'mediaKind'='Image' AND body->>'declaredContentType' LIKE 'image/%')
        OR (body->>'mediaKind'='Video' AND body->>'declaredContentType' LIKE 'video/%'))) IS TRUE) THEN
      RAISE EXCEPTION 'MEDIA_UPLOAD_STORAGE_INVALID' USING ERRCODE='23514';
    END IF;
    created_text:=body->>'createdAt';
    IF to_char(created_text::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>created_text
      OR NEW.expires_at<=created_text::timestamptz OR NEW.expires_at>created_text::timestamptz+interval '15 minutes' THEN
      RAISE EXCEPTION 'MEDIA_UPLOAD_STORAGE_INVALID' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='asset' THEN
    body:=NEW.snapshot_json;
    expected_keys:=ARRAY['assetId','purpose','scope','mediaKind','ownerType','ownerReference','classification','currentVersionReference','version'];
    IF NOT ((body ?& expected_keys AND body-expected_keys='{}'::jsonb
      AND body->'assetId'=to_jsonb(NEW.asset_id::text) AND body->'version'=to_jsonb(NEW.version)
      AND body->'currentVersionReference'='null'::jsonb AND NEW.current_version_id IS NULL
      AND body->>'mediaKind' IN ('Image','Video')) IS TRUE) THEN
      RAISE EXCEPTION 'MEDIA_UPLOAD_STORAGE_INVALID' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='asset_version' THEN
    body:=NEW.snapshot_json;
    expected_keys:=ARRAY['assetVersionId','assetId','version','objectEvidenceReference','providerObjectVersion','byteSize','checksum','contentType','checkState','readinessState','createdAt'];
    IF NOT ((body ?& expected_keys AND body-expected_keys='{}'::jsonb
      AND body->'assetVersionId'=to_jsonb(NEW.asset_version_id::text)
      AND body->'assetId'=to_jsonb(NEW.asset_id::text) AND body->'version'=to_jsonb(NEW.version)
      AND jsonb_typeof(body->'objectEvidenceReference')='string' AND body->>'objectEvidenceReference' ~ uuid_pattern
      AND jsonb_typeof(body->'providerObjectVersion')='string' AND body->>'providerObjectVersion' ~ uuid_pattern
      AND body->'checkState'='"Quarantined"'::jsonb AND body->'readinessState'='"Pending"'::jsonb
      AND jsonb_typeof(body->'byteSize')='number' AND body->>'byteSize' ~ '^[0-9]+$'
      AND (body->>'byteSize')::numeric BETWEEN 1 AND 100000000
      AND jsonb_typeof(body->'checksum')='string' AND body->>'checksum' ~ '^sha256:[0-9a-f]{64}$'
      AND jsonb_typeof(body->'contentType')='string' AND body->>'contentType' ~ '^(image|video)/[a-z0-9][a-z0-9.+-]{0,63}$'
      AND body->'createdAt'=to_jsonb(to_char(NEW.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) IS TRUE) THEN
      RAISE EXCEPTION 'MEDIA_UPLOAD_STORAGE_INVALID' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='operation_record' THEN
    body:=NEW.command_json;
    expected_keys:=ARRAY['tenantReference','scope','actorReference','action','input'];
    IF NOT ((body ?& expected_keys AND body-expected_keys='{}'::jsonb
      AND body->'tenantReference'=to_jsonb(NEW.tenant_id::text)
      AND body->'actorReference'=to_jsonb(NEW.actor_id::text)
      AND body->'action'=to_jsonb(NEW.action_code) AND jsonb_typeof(body->'input')='object') IS TRUE) THEN
      RAISE EXCEPTION 'MEDIA_UPLOAD_STORAGE_INVALID' USING ERRCODE='23514';
    END IF;
    input_body:=body->'input';
    expected_keys:=CASE WHEN NEW.action_code='CreateUpload' THEN ARRAY['idempotencyKey','session','audit']
      ELSE ARRAY['idempotencyKey','expectedSessionVersion','closedSession','asset','assetVersion','audit'] END;
    IF NOT ((input_body ?& expected_keys AND input_body-expected_keys='{}'::jsonb
      AND input_body->'idempotencyKey'=to_jsonb(NEW.operation_id::text)) IS TRUE) THEN
      RAISE EXCEPTION 'MEDIA_UPLOAD_STORAGE_INVALID' USING ERRCODE='23514';
    END IF;
    IF NEW.action_code='CreateUpload' THEN
      IF NEW.result_json IS DISTINCT FROM jsonb_build_object('session',input_body->'session')
        OR input_body#>'{session,state}' IS DISTINCT FROM '"Pending"'::jsonb
        OR input_body#>'{session,version}' IS DISTINCT FROM '1'::jsonb THEN
        RAISE EXCEPTION 'MEDIA_UPLOAD_STORAGE_INVALID' USING ERRCODE='23514';
      END IF;
    ELSE
      IF input_body->'expectedSessionVersion' IS DISTINCT FROM '1'::jsonb
        OR input_body#>'{closedSession,state}' IS DISTINCT FROM '"Finalized"'::jsonb
        OR input_body#>'{closedSession,version}' IS DISTINCT FROM '2'::jsonb
        OR NEW.result_json IS DISTINCT FROM jsonb_build_object('session',input_body->'closedSession','asset',input_body->'asset','assetVersion',input_body->'assetVersion') THEN
        RAISE EXCEPTION 'MEDIA_UPLOAD_STORAGE_INVALID' USING ERRCODE='23514';
      END IF;
    END IF;
    audit_body:=input_body->'audit';
    expected_keys:=ARRAY['auditId','brandId','actor','actionCode','targetType','targetId','reasonCode','correlationId','occurredAt','sourceChannel','dataClassification','retentionPolicyCode','retentionPolicyVersion'];
    IF NEW.store_id IS NOT NULL THEN expected_keys:=array_append(expected_keys,'storeId'); END IF;
    created_text:=CASE WHEN NEW.action_code='CreateUpload' THEN NEW.result_json#>>'{session,createdAt}' ELSE NEW.result_json#>>'{assetVersion,createdAt}' END;
    IF NOT ((jsonb_typeof(audit_body)='object' AND audit_body ?& expected_keys AND audit_body-expected_keys='{}'::jsonb
      AND audit_body->'auditId'=to_jsonb(NEW.audit_id::text)
      AND audit_body->'brandId'=to_jsonb(NEW.brand_id::text)
      AND (NEW.store_id IS NULL OR audit_body->'storeId'=to_jsonb(NEW.store_id::text))
      AND audit_body->'actor'=jsonb_build_object('type','User','reference',NEW.actor_id::text)
      AND audit_body->'actionCode'=to_jsonb(CASE WHEN NEW.action_code='CreateUpload' THEN 'MEDIA_UPLOAD_CREATED'::text ELSE 'MEDIA_ASSET_FINALIZED'::text END)
      AND audit_body->'reasonCode'=audit_body->'actionCode'
      AND audit_body->'targetType'=to_jsonb(CASE WHEN NEW.action_code='CreateUpload' THEN 'MediaUploadSession'::text ELSE 'MediaAsset'::text END)
      AND audit_body->'targetId'=to_jsonb(CASE WHEN NEW.action_code='CreateUpload' THEN NEW.upload_session_id::text ELSE NEW.asset_id::text END)
      AND jsonb_typeof(audit_body->'correlationId')='string' AND audit_body->>'correlationId' ~ uuid_pattern
      AND audit_body->'occurredAt'=to_jsonb(created_text) AND created_text ~ instant_pattern
      AND jsonb_typeof(audit_body->'sourceChannel')='string' AND audit_body->>'sourceChannel' ~ '^[A-Z][A-Z0-9_]{0,127}$'
      AND audit_body->'dataClassification'='"Confidential"'::jsonb
      AND audit_body->'retentionPolicyCode'='"MEDIA_OPERATION_AUDIT"'::jsonb
      AND audit_body->'retentionPolicyVersion'='1'::jsonb) IS TRUE) THEN
      RAISE EXCEPTION 'MEDIA_UPLOAD_STORAGE_INVALID' USING ERRCODE='23514';
    END IF;
    IF to_char(created_text::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>created_text
      OR NEW.recorded_at<created_text::timestamptz THEN
      RAISE EXCEPTION 'MEDIA_UPLOAD_STORAGE_INVALID' USING ERRCODE='23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'MEDIA_UPLOAD_STORAGE_INVALID' USING ERRCODE='23514';
  END IF;

  IF TG_TABLE_NAME IN ('upload_session','asset','operation_record') THEN
    scope_body:=body->'scope';
    IF scope_body IS DISTINCT FROM jsonb_build_object('kind',CASE WHEN NEW.store_id IS NULL THEN 'Brand' ELSE 'Store' END,
      'brandReference',NEW.brand_id::text,'storeReference',NEW.store_id::text) THEN
      RAISE EXCEPTION 'MEDIA_UPLOAD_STORAGE_INVALID' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME IN ('upload_session','asset') AND NOT ((
    jsonb_typeof(body->'purpose')='string' AND body->>'purpose' ~ '^[A-Z][A-Z0-9_]{2,63}$'
    AND jsonb_typeof(body->'ownerType')='string' AND body->>'ownerType' ~ '^[A-Z][A-Z0-9_]{2,31}$'
    AND jsonb_typeof(body->'ownerReference')='string' AND body->>'ownerReference' ~ uuid_pattern
    AND body->>'classification' IN ('Public','Internal','Confidential','Restricted')) IS TRUE) THEN
    RAISE EXCEPTION 'MEDIA_UPLOAD_STORAGE_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_media.guard_media_upload_storage() FROM PUBLIC;

-- Deferred origin checks require the caller's four-table read permission. They
-- run with ordinary invoker RLS: an invisible or foreign origin cannot pass.
-- Audit is committed by the owning UoW, without a foreign-private-table FK.
CREATE FUNCTION bop_media.assert_media_upload_origin()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  session_id platform_helpers.uuid_v7;
  session_row bop_media.upload_session%ROWTYPE;
  created bop_media.operation_record%ROWTYPE;
  finalized bop_media.operation_record%ROWTYPE;
  asset_row bop_media.asset%ROWTYPE;
  version_row bop_media.asset_version%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='asset' THEN
    SELECT v.upload_session_id INTO session_id FROM bop_media.asset_version v
      WHERE v.asset_id=NEW.asset_id AND v.tenant_id=NEW.tenant_id AND v.brand_id=NEW.brand_id AND v.store_id IS NOT DISTINCT FROM NEW.store_id;
  ELSE
    session_id:=NEW.upload_session_id;
  END IF;
  SELECT * INTO session_row FROM bop_media.upload_session s
    WHERE s.upload_session_id=session_id AND s.tenant_id=NEW.tenant_id AND s.brand_id=NEW.brand_id AND s.store_id IS NOT DISTINCT FROM NEW.store_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_UPLOAD_ORIGIN_INVALID' USING ERRCODE='23514'; END IF;
  SELECT * INTO created FROM bop_media.operation_record o WHERE o.upload_session_id=session_id AND o.action_code='CreateUpload'
    AND o.tenant_id=session_row.tenant_id AND o.brand_id=session_row.brand_id AND o.store_id IS NOT DISTINCT FROM session_row.store_id;
  IF NOT FOUND OR created.actor_id<>session_row.actor_id OR created.recorded_at>=session_row.expires_at
    OR ((created.result_json->'session')-ARRAY['version','state']) IS DISTINCT FROM (session_row.snapshot_json-ARRAY['version','state']) THEN
    RAISE EXCEPTION 'MEDIA_UPLOAD_ORIGIN_INVALID' USING ERRCODE='23514';
  END IF;
  SELECT * INTO finalized FROM bop_media.operation_record o WHERE o.upload_session_id=session_id AND o.action_code='FinalizeAsset'
    AND o.tenant_id=session_row.tenant_id AND o.brand_id=session_row.brand_id AND o.store_id IS NOT DISTINCT FROM session_row.store_id;
  IF session_row.state='Pending' THEN
    IF FOUND OR EXISTS (SELECT 1 FROM bop_media.asset_version v WHERE v.upload_session_id=session_id) THEN
      RAISE EXCEPTION 'MEDIA_UPLOAD_ORIGIN_INVALID' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT FOUND OR finalized.actor_id<>session_row.actor_id OR finalized.recorded_at<created.recorded_at OR finalized.recorded_at>=session_row.expires_at
    OR finalized.result_json->'session' IS DISTINCT FROM session_row.snapshot_json THEN
    RAISE EXCEPTION 'MEDIA_UPLOAD_ORIGIN_INVALID' USING ERRCODE='23514';
  END IF;
  SELECT * INTO asset_row FROM bop_media.asset a WHERE a.asset_id=finalized.asset_id
    AND a.tenant_id=session_row.tenant_id AND a.brand_id=session_row.brand_id AND a.store_id IS NOT DISTINCT FROM session_row.store_id;
  IF NOT FOUND OR finalized.result_json->'asset' IS DISTINCT FROM asset_row.snapshot_json THEN
    RAISE EXCEPTION 'MEDIA_UPLOAD_ORIGIN_INVALID' USING ERRCODE='23514';
  END IF;
  SELECT * INTO version_row FROM bop_media.asset_version v WHERE v.asset_version_id=finalized.asset_version_id AND v.asset_id=asset_row.asset_id
    AND v.upload_session_id=session_id AND v.tenant_id=session_row.tenant_id AND v.brand_id=session_row.brand_id AND v.store_id IS NOT DISTINCT FROM session_row.store_id;
  IF NOT FOUND OR finalized.result_json->'assetVersion' IS DISTINCT FROM version_row.snapshot_json
    OR version_row.created_at<(session_row.snapshot_json->>'createdAt')::timestamptz OR version_row.created_at>=session_row.expires_at
    OR version_row.snapshot_json->'contentType' IS DISTINCT FROM session_row.snapshot_json->'declaredContentType'
    OR version_row.snapshot_json->'byteSize' IS DISTINCT FROM session_row.snapshot_json->'declaredByteSize'
    OR (asset_row.snapshot_json-ARRAY['assetId','currentVersionReference','version']) IS DISTINCT FROM
      (session_row.snapshot_json-ARRAY['uploadSessionId','grantReference','actorReference','declaredContentType','declaredByteSize','state','version','createdAt','expiresAt']) THEN
    RAISE EXCEPTION 'MEDIA_UPLOAD_ORIGIN_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_media.assert_media_upload_origin() FROM PUBLIC;

CREATE TRIGGER media_upload_session_guard BEFORE INSERT OR UPDATE OR DELETE ON bop_media.upload_session FOR EACH ROW EXECUTE FUNCTION bop_media.guard_media_upload_storage();
CREATE TRIGGER media_upload_session_no_truncate BEFORE TRUNCATE ON bop_media.upload_session FOR EACH STATEMENT EXECUTE FUNCTION bop_media.guard_media_upload_storage();
CREATE CONSTRAINT TRIGGER media_upload_session_origin AFTER INSERT OR UPDATE ON bop_media.upload_session DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_media.assert_media_upload_origin();
CREATE TRIGGER media_asset_guard BEFORE INSERT OR UPDATE OR DELETE ON bop_media.asset FOR EACH ROW EXECUTE FUNCTION bop_media.guard_media_upload_storage();
CREATE TRIGGER media_asset_no_truncate BEFORE TRUNCATE ON bop_media.asset FOR EACH STATEMENT EXECUTE FUNCTION bop_media.guard_media_upload_storage();
CREATE CONSTRAINT TRIGGER media_asset_origin AFTER INSERT ON bop_media.asset DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_media.assert_media_upload_origin();
CREATE TRIGGER media_asset_version_guard BEFORE INSERT OR UPDATE OR DELETE ON bop_media.asset_version FOR EACH ROW EXECUTE FUNCTION bop_media.guard_media_upload_storage();
CREATE TRIGGER media_asset_version_no_truncate BEFORE TRUNCATE ON bop_media.asset_version FOR EACH STATEMENT EXECUTE FUNCTION bop_media.guard_media_upload_storage();
CREATE CONSTRAINT TRIGGER media_asset_version_origin AFTER INSERT ON bop_media.asset_version DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_media.assert_media_upload_origin();
CREATE TRIGGER media_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON bop_media.operation_record FOR EACH ROW EXECUTE FUNCTION bop_media.guard_media_upload_storage();
CREATE TRIGGER media_operation_no_truncate BEFORE TRUNCATE ON bop_media.operation_record FOR EACH STATEMENT EXECUTE FUNCTION bop_media.guard_media_upload_storage();
CREATE CONSTRAINT TRIGGER media_operation_origin AFTER INSERT ON bop_media.operation_record DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_media.assert_media_upload_origin();

ALTER TABLE bop_media.upload_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_media.upload_session FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_media.asset ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_media.asset FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_media.asset_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_media.asset_version FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_media.operation_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_media.operation_record FORCE ROW LEVEL SECURITY;
CREATE POLICY media_upload_session_scope ON bop_media.upload_session
  USING (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id())
  WITH CHECK (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id());
CREATE POLICY media_asset_scope ON bop_media.asset
  USING (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id())
  WITH CHECK (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id());
CREATE POLICY media_asset_version_scope ON bop_media.asset_version
  USING (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id())
  WITH CHECK (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id());
CREATE POLICY media_operation_scope ON bop_media.operation_record
  USING (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id())
  WITH CHECK (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id());
REVOKE ALL ON TABLE bop_media.upload_session FROM PUBLIC;
REVOKE ALL ON TABLE bop_media.asset FROM PUBLIC;
REVOKE ALL ON TABLE bop_media.asset_version FROM PUBLIC;
REVOKE ALL ON TABLE bop_media.operation_record FROM PUBLIC;
