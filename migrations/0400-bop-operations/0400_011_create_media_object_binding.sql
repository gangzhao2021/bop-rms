-- bop-rms-migration: 1
-- owner: @bop/media
-- schema: bop_media
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Private immutable upload destinations and exact finalized object versions.
-- Legacy operations remain unbound; no existing history is rewritten.
ALTER TABLE bop_media.operation_record ADD COLUMN object_binding_required boolean NOT NULL DEFAULT false;

CREATE TABLE bop_media.upload_object_binding (
  upload_session_id platform_helpers.uuid_v7 PRIMARY KEY,
  operation_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  grant_reference platform_helpers.uuid_v7 NOT NULL UNIQUE,
  bucket text NOT NULL,
  key text NOT NULL,
  binding_digest text NOT NULL CHECK (binding_digest ~ '^sha256:[0-9a-f]{64}$'),
  binding_json jsonb NOT NULL CHECK (jsonb_typeof(binding_json)='object' AND octet_length(binding_json::text)<=65536),
  recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
  UNIQUE (bucket,key),
  FOREIGN KEY (operation_id) REFERENCES bop_media.operation_record(operation_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id,brand_id,upload_session_id) REFERENCES bop_media.upload_session(tenant_id,brand_id,upload_session_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE bop_media.finalized_object_binding (
  asset_version_id platform_helpers.uuid_v7 PRIMARY KEY,
  operation_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  upload_session_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  asset_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  object_evidence_reference platform_helpers.uuid_v7 NOT NULL UNIQUE,
  provider_object_version platform_helpers.uuid_v7 NOT NULL UNIQUE,
  bucket text NOT NULL,
  key text NOT NULL,
  version_id text NOT NULL CHECK (version_id ~ '^[!-~]+$' AND length(version_id)<=1024 AND version_id<>'null'),
  etag text NOT NULL CHECK (etag ~ '^[!-~]{1,128}$' AND position('"' in etag)=0 AND position(chr(92) in etag)=0),
  binding_digest text NOT NULL CHECK (binding_digest ~ '^sha256:[0-9a-f]{64}$'),
  binding_json jsonb NOT NULL CHECK (jsonb_typeof(binding_json)='object' AND octet_length(binding_json::text)<=65536),
  recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
  FOREIGN KEY (operation_id) REFERENCES bop_media.operation_record(operation_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (upload_session_id) REFERENCES bop_media.upload_object_binding(upload_session_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id,brand_id,asset_id) REFERENCES bop_media.asset(tenant_id,brand_id,asset_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id,brand_id,asset_version_id) REFERENCES bop_media.asset_version(tenant_id,brand_id,asset_version_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION bop_media.guard_media_object_binding()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  body jsonb;
  config_body jsonb;
  object_body jsonb;
  expected_keys text[];
  observed_text text;
  digest_pattern constant text := '^sha256:[0-9a-f]{64}$';
  instant_pattern constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$';
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'MEDIA_OBJECT_BINDING_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  body:=NEW.binding_json;
  IF NOT ((jsonb_typeof(body->'requestDigest')='string' AND body->>'requestDigest' ~ digest_pattern
    AND jsonb_typeof(body->'commandDigest')='string' AND body->>'commandDigest' ~ digest_pattern
    AND NEW.bucket ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'
    AND NEW.bucket !~ '^xn--' AND NEW.bucket !~ '(-s3alias|--ol-s3|--x-s3)$'
    AND NEW.key ~ '^[a-z0-9/_-]+$' AND length(NEW.key)<=256) IS TRUE) THEN
    RAISE EXCEPTION 'MEDIA_OBJECT_BINDING_INVALID' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='upload_object_binding' THEN
    expected_keys:=ARRAY['profile','requestDigest','commandDigest','config','key','checksum'];
    IF NOT ((body ?& expected_keys AND body-expected_keys='{}'::jsonb
      AND body->'profile'='"S3_IMAGE_UPLOAD_V1"'::jsonb
      AND body->'key'=to_jsonb(NEW.key)
      AND jsonb_typeof(body->'checksum')='string' AND body->>'checksum' ~ digest_pattern
      AND jsonb_typeof(body->'config')='object') IS TRUE) THEN
      RAISE EXCEPTION 'MEDIA_OBJECT_BINDING_INVALID' USING ERRCODE='23514';
    END IF;
    config_body:=body->'config';
    expected_keys:=ARRAY['tenantReference','scope','region','accountId','bucket','quarantinePrefix','kmsKeyArn','protectionPlanArn'];
    IF NOT ((config_body ?& expected_keys AND config_body-expected_keys='{}'::jsonb
      AND config_body->'tenantReference'=to_jsonb(NEW.tenant_id::text)
      AND config_body->'scope'=jsonb_build_object('kind',CASE WHEN NEW.store_id IS NULL THEN 'Brand' ELSE 'Store' END,
        'brandReference',NEW.brand_id::text,'storeReference',NEW.store_id::text)
      AND config_body->'region'='"ca-central-1"'::jsonb
      AND jsonb_typeof(config_body->'accountId')='string' AND config_body->>'accountId' ~ '^[0-9]{12}$'
      AND config_body->'bucket'=to_jsonb(NEW.bucket)
      AND jsonb_typeof(config_body->'quarantinePrefix')='string'
      AND config_body->>'quarantinePrefix' ~ '^([a-z0-9][a-z0-9_-]{0,31}/){1,4}$'
      AND left(NEW.key,length(config_body->>'quarantinePrefix'))=config_body->>'quarantinePrefix'
      AND substring(NEW.key from length(config_body->>'quarantinePrefix')+1) ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(config_body->'kmsKeyArn')='string'
      AND config_body->>'kmsKeyArn' ~ ('^arn:aws:kms:ca-central-1:' || (config_body->>'accountId') || ':key/([a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}|mrk-[a-f0-9]{32})$')
      AND jsonb_typeof(config_body->'protectionPlanArn')='string'
      AND config_body->>'protectionPlanArn' ~ ('^arn:aws:guardduty:ca-central-1:' || (config_body->>'accountId') || ':malware-protection-plan/[a-zA-Z0-9]{1,64}$')) IS TRUE) THEN
      RAISE EXCEPTION 'MEDIA_OBJECT_BINDING_INVALID' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='finalized_object_binding' THEN
    expected_keys:=ARRAY['profile','requestDigest','commandDigest','uploadBindingDigest','object','observedAt'];
    IF NOT ((body ?& expected_keys AND body-expected_keys='{}'::jsonb
      AND body->'profile'='"S3_IMAGE_FINALIZED_V1"'::jsonb
      AND jsonb_typeof(body->'uploadBindingDigest')='string' AND body->>'uploadBindingDigest' ~ digest_pattern
      AND jsonb_typeof(body->'object')='object'
      AND jsonb_typeof(body->'observedAt')='string' AND body->>'observedAt' ~ instant_pattern) IS TRUE) THEN
      RAISE EXCEPTION 'MEDIA_OBJECT_BINDING_INVALID' USING ERRCODE='23514';
    END IF;
    object_body:=body->'object';
    IF object_body IS DISTINCT FROM jsonb_build_object('bucket',NEW.bucket,'key',NEW.key,'versionId',NEW.version_id,'etag',NEW.etag,
      'objectEvidenceReference',NEW.object_evidence_reference::text,'providerObjectVersion',NEW.provider_object_version::text) THEN
      RAISE EXCEPTION 'MEDIA_OBJECT_BINDING_INVALID' USING ERRCODE='23514';
    END IF;
    observed_text:=body->>'observedAt';
    IF to_char(observed_text::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>observed_text
      OR observed_text::timestamptz>NEW.recorded_at THEN
      RAISE EXCEPTION 'MEDIA_OBJECT_BINDING_INVALID' USING ERRCODE='23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'MEDIA_OBJECT_BINDING_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_media.guard_media_object_binding() FROM PUBLIC;

-- Invoker authority and the same exact Tenant/Brand/Store RLS apply to every
-- origin. RFC8785 digest computation remains in the owning parser/recovery;
-- SQL validates shape and equality, not a different jsonb serialization hash.
CREATE FUNCTION bop_media.assert_media_object_binding_origin()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  operation_row bop_media.operation_record%ROWTYPE;
  session_row bop_media.upload_session%ROWTYPE;
  upload_row bop_media.upload_object_binding%ROWTYPE;
  finalized_row bop_media.finalized_object_binding%ROWTYPE;
  version_row bop_media.asset_version%ROWTYPE;
  observed_at timestamptz;
BEGIN
  -- Preserve the legacy writer's table grants and original unbound receipts.
  -- A binding inserted for a legacy operation still fails its own trigger below.
  IF TG_TABLE_NAME='operation_record' THEN
    IF NOT NEW.object_binding_required THEN RETURN NEW; END IF;
  END IF;
  SELECT * INTO operation_row FROM bop_media.operation_record o WHERE o.operation_id=NEW.operation_id
    AND o.tenant_id=NEW.tenant_id AND o.brand_id=NEW.brand_id AND o.store_id IS NOT DISTINCT FROM NEW.store_id AND o.actor_id=NEW.actor_id;
  IF NOT FOUND OR NOT operation_row.object_binding_required THEN
    RAISE EXCEPTION 'MEDIA_OBJECT_BINDING_ORIGIN_INVALID' USING ERRCODE='23514';
  END IF;
  IF (TG_TABLE_NAME='upload_object_binding' AND operation_row.action_code<>'CreateUpload')
    OR (TG_TABLE_NAME='finalized_object_binding' AND operation_row.action_code<>'FinalizeAsset') THEN
    RAISE EXCEPTION 'MEDIA_OBJECT_BINDING_ORIGIN_INVALID' USING ERRCODE='23514';
  END IF;
  SELECT * INTO session_row FROM bop_media.upload_session s WHERE s.upload_session_id=operation_row.upload_session_id
    AND s.tenant_id=operation_row.tenant_id AND s.brand_id=operation_row.brand_id AND s.store_id IS NOT DISTINCT FROM operation_row.store_id AND s.actor_id=operation_row.actor_id;
  IF NOT FOUND OR NOT ((session_row.snapshot_json->>'mediaKind'='Image'
    AND session_row.snapshot_json->>'declaredContentType' IN ('image/jpeg','image/png','image/webp')
    AND (session_row.snapshot_json->>'declaredByteSize')::bigint BETWEEN 1 AND 10485760) IS TRUE) THEN
    RAISE EXCEPTION 'MEDIA_OBJECT_BINDING_ORIGIN_INVALID' USING ERRCODE='23514';
  END IF;
  SELECT * INTO upload_row FROM bop_media.upload_object_binding b WHERE b.upload_session_id=operation_row.upload_session_id
    AND b.tenant_id=operation_row.tenant_id AND b.brand_id=operation_row.brand_id AND b.store_id IS NOT DISTINCT FROM operation_row.store_id AND b.actor_id=operation_row.actor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_OBJECT_BINDING_REQUIRED' USING ERRCODE='23514'; END IF;
  IF operation_row.action_code='CreateUpload' THEN
    IF upload_row.operation_id<>operation_row.operation_id OR upload_row.recorded_at<>operation_row.recorded_at
      OR upload_row.binding_json->>'commandDigest' IS DISTINCT FROM operation_row.intent_digest
      OR upload_row.grant_reference::text IS DISTINCT FROM operation_row.result_json#>>'{session,grantReference}'
      OR upload_row.upload_session_id<>session_row.upload_session_id THEN
      RAISE EXCEPTION 'MEDIA_OBJECT_BINDING_ORIGIN_INVALID' USING ERRCODE='23514';
    END IF;
  ELSIF operation_row.action_code='FinalizeAsset' THEN
    SELECT * INTO finalized_row FROM bop_media.finalized_object_binding b WHERE b.operation_id=operation_row.operation_id
      AND b.tenant_id=operation_row.tenant_id AND b.brand_id=operation_row.brand_id AND b.store_id IS NOT DISTINCT FROM operation_row.store_id AND b.actor_id=operation_row.actor_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_OBJECT_BINDING_REQUIRED' USING ERRCODE='23514'; END IF;
    SELECT * INTO version_row FROM bop_media.asset_version v WHERE v.asset_version_id=operation_row.asset_version_id
      AND v.tenant_id=operation_row.tenant_id AND v.brand_id=operation_row.brand_id AND v.store_id IS NOT DISTINCT FROM operation_row.store_id;
    IF NOT FOUND OR finalized_row.asset_version_id<>operation_row.asset_version_id OR finalized_row.asset_id<>operation_row.asset_id
      OR finalized_row.upload_session_id<>operation_row.upload_session_id OR version_row.upload_session_id<>operation_row.upload_session_id
      OR version_row.asset_id<>operation_row.asset_id OR finalized_row.recorded_at<>operation_row.recorded_at
      OR finalized_row.binding_json->>'commandDigest' IS DISTINCT FROM operation_row.intent_digest
      OR finalized_row.binding_json->>'uploadBindingDigest' IS DISTINCT FROM upload_row.binding_digest
      OR finalized_row.bucket<>upload_row.bucket OR finalized_row.key<>upload_row.key
      OR finalized_row.object_evidence_reference::text IS DISTINCT FROM version_row.snapshot_json->>'objectEvidenceReference'
      OR finalized_row.provider_object_version::text IS DISTINCT FROM version_row.snapshot_json->>'providerObjectVersion'
      OR version_row.snapshot_json->>'checksum' IS DISTINCT FROM upload_row.binding_json->>'checksum' THEN
      RAISE EXCEPTION 'MEDIA_OBJECT_BINDING_ORIGIN_INVALID' USING ERRCODE='23514';
    END IF;
    observed_at:=(finalized_row.binding_json->>'observedAt')::timestamptz;
    IF observed_at<(session_row.snapshot_json->>'createdAt')::timestamptz OR observed_at>=session_row.expires_at
      OR observed_at<upload_row.recorded_at OR observed_at>finalized_row.recorded_at THEN
      RAISE EXCEPTION 'MEDIA_OBJECT_BINDING_ORIGIN_INVALID' USING ERRCODE='23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'MEDIA_OBJECT_BINDING_ORIGIN_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_media.assert_media_object_binding_origin() FROM PUBLIC;

CREATE TRIGGER media_upload_object_binding_guard BEFORE INSERT OR UPDATE OR DELETE ON bop_media.upload_object_binding FOR EACH ROW EXECUTE FUNCTION bop_media.guard_media_object_binding();
CREATE TRIGGER media_upload_object_binding_no_truncate BEFORE TRUNCATE ON bop_media.upload_object_binding FOR EACH STATEMENT EXECUTE FUNCTION bop_media.guard_media_object_binding();
CREATE CONSTRAINT TRIGGER media_upload_object_binding_origin AFTER INSERT ON bop_media.upload_object_binding DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_media.assert_media_object_binding_origin();
CREATE TRIGGER media_finalized_object_binding_guard BEFORE INSERT OR UPDATE OR DELETE ON bop_media.finalized_object_binding FOR EACH ROW EXECUTE FUNCTION bop_media.guard_media_object_binding();
CREATE TRIGGER media_finalized_object_binding_no_truncate BEFORE TRUNCATE ON bop_media.finalized_object_binding FOR EACH STATEMENT EXECUTE FUNCTION bop_media.guard_media_object_binding();
CREATE CONSTRAINT TRIGGER media_finalized_object_binding_origin AFTER INSERT ON bop_media.finalized_object_binding DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_media.assert_media_object_binding_origin();
CREATE CONSTRAINT TRIGGER media_operation_object_binding_required AFTER INSERT ON bop_media.operation_record DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_media.assert_media_object_binding_origin();

ALTER TABLE bop_media.upload_object_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_media.upload_object_binding FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_media.finalized_object_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_media.finalized_object_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY media_upload_object_binding_scope ON bop_media.upload_object_binding
  USING (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id())
  WITH CHECK (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id());
CREATE POLICY media_finalized_object_binding_scope ON bop_media.finalized_object_binding
  USING (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id())
  WITH CHECK (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id());
REVOKE ALL ON TABLE bop_media.upload_object_binding FROM PUBLIC;
REVOKE ALL ON TABLE bop_media.finalized_object_binding FROM PUBLIC;
