-- bop-rms-migration: 1
-- owner: @bop/media
-- schema: bop_media
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Immutable processing intent and completion. JSON validates stored provenance;
-- authenticated scan ingress, current System authority and actual object I/O
-- remain requirements of the owning application, never inferred by SQL.
ALTER TABLE bop_media.asset DROP CONSTRAINT asset_version_check;
ALTER TABLE bop_media.asset ADD CONSTRAINT asset_version_check CHECK (version BETWEEN 1 AND 9007199254740991);
ALTER TABLE bop_media.asset DROP CONSTRAINT asset_current_version_id_check;
ALTER TABLE bop_media.asset ADD CONSTRAINT asset_current_version_id_check CHECK ((version=1 AND current_version_id IS NULL) OR (version>1 AND current_version_id IS NOT NULL));
ALTER TABLE bop_media.asset_version DROP CONSTRAINT asset_version_version_check;
ALTER TABLE bop_media.asset_version ADD CONSTRAINT asset_version_version_check CHECK (version BETWEEN 1 AND 9007199254740991);
ALTER TABLE bop_media.asset_version DROP CONSTRAINT asset_version_asset_id_key;
ALTER TABLE bop_media.asset_version DROP CONSTRAINT asset_version_upload_session_id_key;
CREATE UNIQUE INDEX media_asset_original_version ON bop_media.asset_version(asset_id) WHERE version=1;
CREATE UNIQUE INDEX media_upload_original_version ON bop_media.asset_version(upload_session_id) WHERE version=1;
ALTER TABLE bop_media.asset_version ADD CONSTRAINT media_asset_version_number UNIQUE(asset_id,version);

CREATE TABLE bop_media.image_processing_intent (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  system_actor_id platform_helpers.uuid_v7 NOT NULL,
  asset_id platform_helpers.uuid_v7 NOT NULL,
  source_asset_version_id platform_helpers.uuid_v7 NOT NULL,
  target_asset_version_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  expected_asset_version bigint NOT NULL CHECK (expected_asset_version BETWEEN 1 AND 9007199254740990),
  scan_event_id text NOT NULL CHECK (scan_event_id ~ '^[A-Za-z0-9-]{1,128}$'),
  source_binding_digest text NOT NULL CHECK (source_binding_digest ~ '^sha256:[0-9a-f]{64}$'),
  plan_digest text NOT NULL CHECK (plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  intent_json jsonb NOT NULL CHECK (jsonb_typeof(intent_json)='object' AND octet_length(intent_json::text)<=262144),
  recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  UNIQUE(source_asset_version_id,scan_event_id),
  CHECK (source_asset_version_id<>target_asset_version_id),
  FOREIGN KEY(tenant_id,brand_id,asset_id) REFERENCES bop_media.asset(tenant_id,brand_id,asset_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(tenant_id,brand_id,source_asset_version_id) REFERENCES bop_media.asset_version(tenant_id,brand_id,asset_version_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE bop_media.image_processing_completion (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY REFERENCES bop_media.image_processing_intent(operation_id) DEFERRABLE INITIALLY DEFERRED,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  system_actor_id platform_helpers.uuid_v7 NOT NULL,
  asset_id platform_helpers.uuid_v7 NOT NULL,
  source_asset_version_id platform_helpers.uuid_v7 NOT NULL,
  target_asset_version_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
  completion_digest text NOT NULL CHECK (completion_digest ~ '^sha256:[0-9a-f]{64}$'),
  completion_json jsonb NOT NULL CHECK (jsonb_typeof(completion_json)='object' AND octet_length(completion_json::text)<=262144),
  asset_snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(asset_snapshot_json)='object' AND octet_length(asset_snapshot_json::text)<=65536),
  new_version_json jsonb NOT NULL CHECK (jsonb_typeof(new_version_json)='object' AND octet_length(new_version_json::text)<=65536),
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  FOREIGN KEY(tenant_id,brand_id,asset_id) REFERENCES bop_media.asset(tenant_id,brand_id,asset_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(tenant_id,brand_id,source_asset_version_id) REFERENCES bop_media.asset_version(tenant_id,brand_id,asset_version_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(tenant_id,brand_id,target_asset_version_id) REFERENCES bop_media.asset_version(tenant_id,brand_id,asset_version_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE bop_media.image_rendition (
  asset_version_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/webp')),
  width integer NOT NULL CHECK (width IN (320,640,1280)),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 16383 AND width::bigint*height<=25000000),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  checksum text NOT NULL CHECK (checksum ~ '^sha256:[0-9a-f]{64}$'),
  object_evidence_reference platform_helpers.uuid_v7 NOT NULL UNIQUE,
  provider_object_version platform_helpers.uuid_v7 NOT NULL UNIQUE,
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=65536),
  PRIMARY KEY(asset_version_id,content_type,width),
  FOREIGN KEY(tenant_id,brand_id,asset_version_id) REFERENCES bop_media.asset_version(tenant_id,brand_id,asset_version_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION bop_media.guard_media_promoted_asset()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  body jsonb;
  keys text[];
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') OR (TG_TABLE_NAME='asset_version' AND TG_OP<>'INSERT') THEN
    RAISE EXCEPTION 'MEDIA_UPLOAD_STORAGE_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  body:=NEW.snapshot_json;
  IF TG_TABLE_NAME='asset' THEN
    IF (TG_OP='INSERT' AND (NEW.version<>1 OR NEW.current_version_id IS NOT NULL))
      OR (TG_OP='UPDATE' AND (NEW.version<>OLD.version+1 OR NEW.current_version_id IS NULL
        OR NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id
        OR (to_jsonb(NEW)-ARRAY['version','current_version_id','snapshot_json']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['version','current_version_id','snapshot_json'])
        OR (body-ARRAY['version','currentVersionReference']) IS DISTINCT FROM (OLD.snapshot_json-ARRAY['version','currentVersionReference']))) THEN
      RAISE EXCEPTION 'MEDIA_UPLOAD_STORAGE_IMMUTABLE' USING ERRCODE='55000';
    END IF;
    keys:=ARRAY['assetId','purpose','scope','mediaKind','ownerType','ownerReference','classification','currentVersionReference','version'];
    IF NOT ((body ?& keys AND body-keys='{}'::jsonb
      AND body->'assetId'=to_jsonb(NEW.asset_id::text) AND body->'version'=to_jsonb(NEW.version)
      AND body->'currentVersionReference'=COALESCE(to_jsonb(NEW.current_version_id::text),'null'::jsonb)
      AND body->'scope'=jsonb_build_object('kind',CASE WHEN NEW.store_id IS NULL THEN 'Brand' ELSE 'Store' END,'brandReference',NEW.brand_id::text,'storeReference',NEW.store_id::text)
      AND body->>'mediaKind' IN ('Image','Video') AND (TG_OP='INSERT' OR body->>'mediaKind'='Image')
      AND jsonb_typeof(body->'purpose')='string' AND body->>'purpose' ~ '^[A-Z][A-Z0-9_]{2,63}$'
      AND jsonb_typeof(body->'ownerType')='string' AND body->>'ownerType' ~ '^[A-Z][A-Z0-9_]{2,31}$'
      AND jsonb_typeof(body->'ownerReference')='string' AND body->>'ownerReference' ~ uuid_pattern
      AND body->>'classification' IN ('Public','Internal','Confidential','Restricted')) IS TRUE) THEN
      RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_INVALID' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='asset_version' THEN
    keys:=ARRAY['assetVersionId','assetId','version','objectEvidenceReference','providerObjectVersion','byteSize','checksum','contentType','checkState','readinessState','createdAt'];
    IF NOT ((body ?& keys AND body-keys='{}'::jsonb
      AND body->'assetVersionId'=to_jsonb(NEW.asset_version_id::text)
      AND body->'assetId'=to_jsonb(NEW.asset_id::text) AND body->'version'=to_jsonb(NEW.version)
      AND jsonb_typeof(body->'objectEvidenceReference')='string' AND body->>'objectEvidenceReference' ~ uuid_pattern
      AND jsonb_typeof(body->'providerObjectVersion')='string' AND body->>'providerObjectVersion' ~ uuid_pattern
      AND ((NEW.version=1 AND body->'checkState'='"Quarantined"'::jsonb AND body->'readinessState'='"Pending"'::jsonb)
        OR (NEW.version>1 AND body->'checkState'='"Clean"'::jsonb AND body->'readinessState'='"Ready"'::jsonb AND body->'contentType'='"image/jpeg"'::jsonb))
      AND jsonb_typeof(body->'byteSize')='number' AND body->>'byteSize' ~ '^[0-9]+$'
      AND (body->>'byteSize')::numeric BETWEEN 1 AND (CASE WHEN NEW.version=1 THEN 100000000 ELSE 10485760 END)
      AND jsonb_typeof(body->'checksum')='string' AND body->>'checksum' ~ '^sha256:[0-9a-f]{64}$'
      AND jsonb_typeof(body->'contentType')='string' AND body->>'contentType' ~ '^(image|video)/[a-z0-9][a-z0-9.+-]{0,63}$'
      AND body->'createdAt'=to_jsonb(to_char(NEW.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) IS TRUE) THEN
      RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_INVALID' USING ERRCODE='23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_media.guard_media_promoted_asset() FROM PUBLIC;
DROP TRIGGER media_asset_guard ON bop_media.asset;
DROP TRIGGER media_asset_version_guard ON bop_media.asset_version;
CREATE TRIGGER media_asset_guard BEFORE INSERT OR UPDATE OR DELETE ON bop_media.asset FOR EACH ROW EXECUTE FUNCTION bop_media.guard_media_promoted_asset();
CREATE TRIGGER media_asset_version_guard BEFORE INSERT OR UPDATE OR DELETE ON bop_media.asset_version FOR EACH ROW EXECUTE FUNCTION bop_media.guard_media_promoted_asset();

CREATE FUNCTION bop_media.guard_media_image_processing()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  body jsonb;
  keys text[];
  current_version bigint;
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF TG_TABLE_NAME='image_processing_intent' THEN
    body:=NEW.intent_json;
    keys:=ARRAY['profile','operationReference','tenantReference','scope','systemActorReference','sourceBindingDigest','source','plan','createdAt','auditId','correlationId','admissionReference'];
    IF NOT ((body ?& keys AND body-keys='{}'::jsonb AND body->'profile'='"MEDIA_IMAGE_PROCESSING_INTENT_V1"'::jsonb
      AND body->'operationReference'=to_jsonb(NEW.operation_id::text) AND body->'tenantReference'=to_jsonb(NEW.tenant_id::text)
      AND body->'systemActorReference'=to_jsonb(NEW.system_actor_id::text)
      AND body->'scope'=jsonb_build_object('kind',CASE WHEN NEW.store_id IS NULL THEN 'Brand' ELSE 'Store' END,'brandReference',NEW.brand_id::text,'storeReference',NEW.store_id::text)
      AND body->'sourceBindingDigest'=to_jsonb(NEW.source_binding_digest)
      AND body->'createdAt'=to_jsonb(to_char(NEW.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      AND body->'auditId'=to_jsonb(NEW.audit_id::text)
      AND jsonb_typeof(body->'correlationId')='string' AND body->>'correlationId' ~ uuid_pattern
      AND jsonb_typeof(body->'admissionReference')='string' AND body->>'admissionReference' ~ uuid_pattern
      AND jsonb_typeof(body->'source')='object' AND jsonb_typeof(body->'plan')='object') IS TRUE) THEN
      RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_INVALID' USING ERRCODE='23514';
    END IF;
    SELECT a.version INTO current_version FROM bop_media.asset a WHERE a.asset_id=NEW.asset_id AND a.tenant_id=NEW.tenant_id
      AND a.brand_id=NEW.brand_id AND a.store_id IS NOT DISTINCT FROM NEW.store_id FOR UPDATE;
    IF NOT FOUND OR current_version<>NEW.expected_asset_version THEN
      RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_ROOT_CONFLICT' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='image_processing_completion' THEN
    body:=NEW.completion_json;
    keys:=ARRAY['profile','operationReference','planDigest','sourceEvidence','scanEvidence','original','renditions','completedAt'];
    IF NOT ((body ?& keys AND body-keys='{}'::jsonb AND body->'profile'='"PUBLIC_IMAGE_RESULT_V1"'::jsonb
      AND body->'operationReference'=to_jsonb(NEW.operation_id::text)
      AND jsonb_typeof(body->'planDigest')='string' AND body->>'planDigest' ~ '^sha256:[0-9a-f]{64}$'
      AND jsonb_typeof(body->'completedAt')='string' AND body->>'completedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      AND jsonb_typeof(body->'sourceEvidence')='object' AND jsonb_typeof(body->'scanEvidence')='object'
      AND jsonb_typeof(body->'original')='object' AND jsonb_typeof(body->'renditions')='array') IS TRUE) THEN
      RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_INVALID' USING ERRCODE='23514';
    END IF;
    IF to_char((body->>'completedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>body->>'completedAt'
      OR (body->>'completedAt')::timestamptz>NEW.recorded_at THEN
      RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_INVALID' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='image_rendition' THEN
    body:=NEW.snapshot_json;
    keys:=ARRAY['key','objectEvidenceReference','providerObjectVersion','bucket','versionId','etag','contentType','byteSize','checksum','width','height'];
    IF NOT ((body ?& keys AND body-keys='{}'::jsonb
      AND body->'objectEvidenceReference'=to_jsonb(NEW.object_evidence_reference::text)
      AND body->'providerObjectVersion'=to_jsonb(NEW.provider_object_version::text)
      AND body->'contentType'=to_jsonb(NEW.content_type) AND body->'byteSize'=to_jsonb(NEW.byte_size)
      AND body->'checksum'=to_jsonb(NEW.checksum) AND body->'width'=to_jsonb(NEW.width) AND body->'height'=to_jsonb(NEW.height)) IS TRUE) THEN
      RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_INVALID' USING ERRCODE='23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_media.guard_media_image_processing() FROM PUBLIC;

CREATE FUNCTION bop_media.assert_media_image_processing_origin()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  intent_row bop_media.image_processing_intent%ROWTYPE;
  completion_row bop_media.image_processing_completion%ROWTYPE;
  asset_row bop_media.asset%ROWTYPE;
  source_version bop_media.asset_version%ROWTYPE;
  target_version bop_media.asset_version%ROWTYPE;
  final_binding bop_media.finalized_object_binding%ROWTYPE;
  upload_binding bop_media.upload_object_binding%ROWTYPE;
  original_operation bop_media.operation_record%ROWTYPE;
  session_row bop_media.upload_session%ROWTYPE;
  body jsonb;
  source_body jsonb;
  plan_body jsonb;
  destination jsonb;
  event_body jsonb;
  detail_body jsonb;
  scan_body jsonb;
  object_body jsonb;
  output_body jsonb;
  planned_body jsonb;
  representative jsonb;
  expected_asset jsonb;
  expected_version jsonb;
  keys text[];
  seen_keys text[]:=ARRAY[]::text[];
  seen_references text[]:=ARRAY[]::text[];
  widths integer[]:=ARRAY[320,320,640,640,1280,1280];
  types text[]:=ARRAY['image/jpeg','image/webp','image/jpeg','image/webp','image/jpeg','image/webp'];
  object_fields text[]:=ARRAY['key','objectEvidenceReference','providerObjectVersion'];
  output_fields text[]:=ARRAY['key','objectEvidenceReference','providerObjectVersion','bucket','versionId','etag','contentType','byteSize','checksum'];
  index_value integer;
  actual_count bigint;
  total_bytes bigint;
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
BEGIN
  -- Legacy v1 paths must return before touching any newly granted table.
  IF TG_TABLE_NAME='asset' THEN
    IF TG_OP='INSERT' THEN RETURN NEW; END IF;
    SELECT * INTO intent_row FROM bop_media.image_processing_intent i WHERE i.target_asset_version_id=NEW.current_version_id
      AND i.tenant_id=NEW.tenant_id AND i.brand_id=NEW.brand_id AND i.store_id IS NOT DISTINCT FROM NEW.store_id;
  ELSIF TG_TABLE_NAME='asset_version' THEN
    IF NEW.version=1 THEN RETURN NEW; END IF;
    SELECT * INTO intent_row FROM bop_media.image_processing_intent i WHERE i.target_asset_version_id=NEW.asset_version_id
      AND i.tenant_id=NEW.tenant_id AND i.brand_id=NEW.brand_id AND i.store_id IS NOT DISTINCT FROM NEW.store_id;
  ELSIF TG_TABLE_NAME='image_rendition' THEN
    SELECT * INTO intent_row FROM bop_media.image_processing_intent i WHERE i.target_asset_version_id=NEW.asset_version_id
      AND i.tenant_id=NEW.tenant_id AND i.brand_id=NEW.brand_id AND i.store_id IS NOT DISTINCT FROM NEW.store_id;
  ELSE
    SELECT * INTO intent_row FROM bop_media.image_processing_intent i WHERE i.operation_id=NEW.operation_id
      AND i.tenant_id=NEW.tenant_id AND i.brand_id=NEW.brand_id AND i.store_id IS NOT DISTINCT FROM NEW.store_id;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_ORIGIN_INVALID' USING ERRCODE='23514'; END IF;
  body:=intent_row.intent_json;
  source_body:=body->'source';
  plan_body:=body->'plan';
  keys:=ARRAY['tenantReference','session','asset','assetVersion','object','scanEvent'];
  IF NOT ((source_body ?& keys AND source_body-keys='{}'::jsonb
    AND source_body->'tenantReference'=to_jsonb(intent_row.tenant_id::text)) IS TRUE) THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_ORIGIN_INVALID' USING ERRCODE='23514';
  END IF;
  SELECT * INTO asset_row FROM bop_media.asset a WHERE a.asset_id=intent_row.asset_id AND a.tenant_id=intent_row.tenant_id
    AND a.brand_id=intent_row.brand_id AND a.store_id IS NOT DISTINCT FROM intent_row.store_id;
  IF NOT FOUND OR asset_row.version<intent_row.expected_asset_version
    OR asset_row.snapshot_json->>'mediaKind' IS DISTINCT FROM 'Image' THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_ORIGIN_INVALID' USING ERRCODE='23514';
  END IF;
  SELECT * INTO source_version FROM bop_media.asset_version v WHERE v.asset_version_id=intent_row.source_asset_version_id
    AND v.asset_id=intent_row.asset_id AND v.version=1 AND v.tenant_id=intent_row.tenant_id
    AND v.brand_id=intent_row.brand_id AND v.store_id IS NOT DISTINCT FROM intent_row.store_id;
  IF NOT FOUND OR source_body->'assetVersion' IS DISTINCT FROM source_version.snapshot_json THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_SOURCE_INVALID' USING ERRCODE='23514';
  END IF;
  SELECT * INTO final_binding FROM bop_media.finalized_object_binding b WHERE b.asset_version_id=source_version.asset_version_id
    AND b.asset_id=intent_row.asset_id AND b.upload_session_id=source_version.upload_session_id AND b.tenant_id=intent_row.tenant_id
    AND b.brand_id=intent_row.brand_id AND b.store_id IS NOT DISTINCT FROM intent_row.store_id;
  IF NOT FOUND OR final_binding.binding_digest<>intent_row.source_binding_digest
    OR source_body->'object' IS DISTINCT FROM final_binding.binding_json->'object' THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_SOURCE_INVALID' USING ERRCODE='23514';
  END IF;
  SELECT * INTO upload_binding FROM bop_media.upload_object_binding b WHERE b.upload_session_id=final_binding.upload_session_id
    AND b.tenant_id=intent_row.tenant_id AND b.brand_id=intent_row.brand_id AND b.store_id IS NOT DISTINCT FROM intent_row.store_id;
  IF NOT FOUND OR final_binding.actor_id<>upload_binding.actor_id
    OR final_binding.binding_json->>'uploadBindingDigest' IS DISTINCT FROM upload_binding.binding_digest
    OR source_version.snapshot_json->'checksum' IS DISTINCT FROM upload_binding.binding_json->'checksum' THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_SOURCE_INVALID' USING ERRCODE='23514';
  END IF;
  SELECT * INTO original_operation FROM bop_media.operation_record o WHERE o.operation_id=final_binding.operation_id
    AND o.tenant_id=intent_row.tenant_id AND o.brand_id=intent_row.brand_id AND o.store_id IS NOT DISTINCT FROM intent_row.store_id;
  IF NOT FOUND OR original_operation.action_code<>'FinalizeAsset' OR NOT original_operation.object_binding_required
    OR original_operation.actor_id<>final_binding.actor_id OR original_operation.asset_id<>intent_row.asset_id
    OR original_operation.asset_version_id<>intent_row.source_asset_version_id
    OR original_operation.upload_session_id<>source_version.upload_session_id
    OR original_operation.recorded_at<>final_binding.recorded_at OR intent_row.recorded_at<final_binding.recorded_at
    OR final_binding.binding_json->>'commandDigest' IS DISTINCT FROM original_operation.intent_digest
    OR source_body->'asset' IS DISTINCT FROM original_operation.result_json->'asset'
    OR source_body->'assetVersion' IS DISTINCT FROM original_operation.result_json->'assetVersion'
    OR source_body->'session' IS DISTINCT FROM original_operation.result_json->'session'
    OR ((source_body->'asset')-ARRAY['version','currentVersionReference']) IS DISTINCT FROM (asset_row.snapshot_json-ARRAY['version','currentVersionReference']) THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_SOURCE_INVALID' USING ERRCODE='23514';
  END IF;
  SELECT * INTO session_row FROM bop_media.upload_session s WHERE s.upload_session_id=source_version.upload_session_id
    AND s.tenant_id=intent_row.tenant_id AND s.brand_id=intent_row.brand_id AND s.store_id IS NOT DISTINCT FROM intent_row.store_id;
  IF NOT FOUND OR source_body->'session' IS DISTINCT FROM session_row.snapshot_json
    OR session_row.actor_id<>final_binding.actor_id OR source_version.snapshot_json->>'checkState' IS DISTINCT FROM 'Quarantined'
    OR source_version.snapshot_json->>'readinessState' IS DISTINCT FROM 'Pending'
    OR source_version.snapshot_json->>'contentType' NOT IN ('image/jpeg','image/png','image/webp')
    OR (source_version.snapshot_json->>'byteSize')::bigint>10485760 THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_SOURCE_INVALID' USING ERRCODE='23514';
  END IF;
  keys:=ARRAY['profile','operationReference','tenantReference','scope','assetReference','sourceAssetVersionReference','targetAssetVersionReference','expectedAssetVersion','sourceBindingDigest','destination','original','renditions'];
  IF NOT ((plan_body ?& keys AND plan_body-keys='{}'::jsonb AND plan_body->'profile'='"PUBLIC_IMAGE_V1"'::jsonb
    AND plan_body->'operationReference'=to_jsonb(intent_row.operation_id::text)
    AND plan_body->'tenantReference'=to_jsonb(intent_row.tenant_id::text) AND plan_body->'scope'=body->'scope'
    AND plan_body->'assetReference'=to_jsonb(intent_row.asset_id::text)
    AND plan_body->'sourceAssetVersionReference'=to_jsonb(intent_row.source_asset_version_id::text)
    AND plan_body->'targetAssetVersionReference'=to_jsonb(intent_row.target_asset_version_id::text)
    AND plan_body->'expectedAssetVersion'=to_jsonb(intent_row.expected_asset_version)
    AND plan_body->'sourceBindingDigest'=to_jsonb(intent_row.source_binding_digest)
    AND jsonb_typeof(plan_body->'renditions')='array' AND jsonb_typeof(plan_body->'destination')='object') IS TRUE) THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_INVALID' USING ERRCODE='23514';
  END IF;
  IF jsonb_array_length(plan_body->'renditions')<>6 THEN RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_INVALID' USING ERRCODE='23514'; END IF;
  destination:=plan_body->'destination';
  keys:=ARRAY['accountId','bucket','cleanPrefix','kmsKeyArn'];
  IF NOT ((destination ?& keys AND destination-keys='{}'::jsonb
    AND destination->'accountId'=upload_binding.binding_json#>'{config,accountId}'
    AND jsonb_typeof(destination->'bucket')='string' AND destination->>'bucket' ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'
    AND destination->>'bucket' !~ '^xn--' AND destination->>'bucket' !~ '(-s3alias|--ol-s3|--x-s3)$'
    AND jsonb_typeof(destination->'cleanPrefix')='string' AND destination->>'cleanPrefix' ~ '^([a-z0-9][a-z0-9_-]{0,31}/){1,4}$'
    AND jsonb_typeof(destination->'kmsKeyArn')='string'
    AND destination->>'kmsKeyArn' ~ ('^arn:aws:kms:ca-central-1:' || (destination->>'accountId') || ':key/([a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}|mrk-[a-f0-9]{32})$')) IS TRUE) THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_INVALID' USING ERRCODE='23514';
  END IF;
  IF destination->>'bucket'=upload_binding.bucket AND
    (starts_with(destination->>'cleanPrefix',upload_binding.binding_json#>>'{config,quarantinePrefix}')
      OR starts_with(upload_binding.binding_json#>>'{config,quarantinePrefix}',destination->>'cleanPrefix')) THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_SOURCE_INVALID' USING ERRCODE='23514';
  END IF;
  FOR index_value IN 0..6 LOOP
    object_body:=CASE WHEN index_value=0 THEN plan_body->'original' ELSE plan_body->'renditions'->(index_value-1) END;
    keys:=CASE WHEN index_value=0 THEN object_fields ELSE object_fields||ARRAY['contentType','width'] END;
    IF NOT ((jsonb_typeof(object_body)='object' AND object_body ?& keys AND object_body-keys='{}'::jsonb
      AND jsonb_typeof(object_body->'key')='string'
      AND starts_with(object_body->>'key',destination->>'cleanPrefix')
      AND substring(object_body->>'key' from length(destination->>'cleanPrefix')+1) ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(object_body->'objectEvidenceReference')='string' AND object_body->>'objectEvidenceReference' ~ uuid_pattern
      AND jsonb_typeof(object_body->'providerObjectVersion')='string' AND object_body->>'providerObjectVersion' ~ uuid_pattern) IS TRUE) THEN
      RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_INVALID' USING ERRCODE='23514';
    END IF;
    IF (index_value>0 AND (object_body->'contentType' IS DISTINCT FROM to_jsonb(types[index_value]) OR object_body->'width' IS DISTINCT FROM to_jsonb(widths[index_value])))
      OR object_body->>'key'=ANY(seen_keys) OR object_body->>'objectEvidenceReference'=ANY(seen_references)
      OR object_body->>'providerObjectVersion'=ANY(seen_references)
      OR object_body->'objectEvidenceReference'=object_body->'providerObjectVersion'
      OR object_body->>'objectEvidenceReference' IN (final_binding.object_evidence_reference::text,final_binding.provider_object_version::text)
      OR object_body->>'providerObjectVersion' IN (final_binding.object_evidence_reference::text,final_binding.provider_object_version::text) THEN
      RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_INVALID' USING ERRCODE='23514';
    END IF;
    seen_keys:=array_append(seen_keys,object_body->>'key');
    seen_references:=seen_references||ARRAY[object_body->>'objectEvidenceReference',object_body->>'providerObjectVersion'];
  END LOOP;
  event_body:=source_body->'scanEvent';
  detail_body:=event_body->'detail';
  scan_body:=detail_body->'s3ObjectDetails';
  keys:=ARRAY['version','id','detail-type','source','account','time','region','resources','detail'];
  IF NOT ((jsonb_typeof(event_body)='object' AND event_body ?& keys AND event_body-keys='{}'::jsonb
    AND event_body->'version'='"0"'::jsonb AND event_body->'id'=to_jsonb(intent_row.scan_event_id)
    AND event_body->'detail-type'='"GuardDuty Malware Protection Object Scan Result"'::jsonb
    AND event_body->'source'='"aws.guardduty"'::jsonb AND event_body->'account'=upload_binding.binding_json#>'{config,accountId}'
    AND event_body->'region'='"ca-central-1"'::jsonb
    AND event_body->'resources'=jsonb_build_array(upload_binding.binding_json#>'{config,protectionPlanArn}')
    AND jsonb_typeof(event_body->'time')='string' AND event_body->>'time' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$'
    AND jsonb_typeof(scan_body->'s3Throttled')='boolean'
    AND scan_body=jsonb_build_object('bucketName',final_binding.bucket,'objectKey',final_binding.key,'eTag',final_binding.etag,'versionId',final_binding.version_id,'s3Throttled',scan_body->'s3Throttled')
    AND detail_body=jsonb_build_object('schemaVersion','1.0','scanStatus','COMPLETED','resourceType','S3_OBJECT','s3ObjectDetails',scan_body,
      'scanResultDetails',jsonb_build_object('scanResultStatus','NO_THREATS_FOUND','threats',NULL,'statusReasons',NULL))) IS TRUE) THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_SOURCE_INVALID' USING ERRCODE='23514';
  END IF;
  IF to_char((event_body->>'time')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>
      (CASE WHEN position('.' in event_body->>'time')>0 THEN event_body->>'time' ELSE replace(event_body->>'time','Z','.000Z') END)
    OR (event_body->>'time')::timestamptz>intent_row.recorded_at THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_SOURCE_INVALID' USING ERRCODE='23514';
  END IF;
  -- An intent may remain pending while real Provider/decoder work is retried.
  IF TG_TABLE_NAME='image_processing_intent' THEN RETURN NEW; END IF;
  SELECT * INTO completion_row FROM bop_media.image_processing_completion c WHERE c.operation_id=intent_row.operation_id
    AND c.tenant_id=intent_row.tenant_id AND c.brand_id=intent_row.brand_id AND c.store_id IS NOT DISTINCT FROM intent_row.store_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_COMPLETION_REQUIRED' USING ERRCODE='23514'; END IF;
  body:=completion_row.completion_json;
  IF completion_row.system_actor_id<>intent_row.system_actor_id OR completion_row.asset_id<>intent_row.asset_id
    OR completion_row.source_asset_version_id<>intent_row.source_asset_version_id OR completion_row.target_asset_version_id<>intent_row.target_asset_version_id
    OR completion_row.recorded_at<intent_row.recorded_at OR completion_row.audit_id=intent_row.audit_id
    OR body->>'planDigest' IS DISTINCT FROM intent_row.plan_digest OR (body->>'completedAt')::timestamptz<intent_row.recorded_at
    OR body->'sourceEvidence' IS DISTINCT FROM (source_body->'object'||jsonb_build_object('tenantReference',intent_row.tenant_id::text,
      'scope',intent_row.intent_json->'scope','uploadSessionReference',session_row.upload_session_id::text,'assetReference',intent_row.asset_id::text,
      'assetVersionReference',source_version.asset_version_id::text,'byteSize',source_version.snapshot_json->'byteSize','checksum',source_version.snapshot_json->'checksum',
      'kmsKeyArn',upload_binding.binding_json#>'{config,kmsKeyArn}'))
    OR body->'scanEvidence' IS DISTINCT FROM jsonb_build_object('eventId',intent_row.scan_event_id,'eventTime',event_body->'time',
      'accountId',event_body->'account','region','ca-central-1','protectionPlanArn',upload_binding.binding_json#>'{config,protectionPlanArn}',
      'result','NO_THREATS_FOUND','s3Throttled',scan_body->'s3Throttled') THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_ORIGIN_INVALID' USING ERRCODE='23514';
  END IF;
  IF jsonb_array_length(body->'renditions')<>6 THEN RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_INVALID' USING ERRCODE='23514'; END IF;
  FOR index_value IN 0..6 LOOP
    output_body:=CASE WHEN index_value=0 THEN body->'original' ELSE body->'renditions'->(index_value-1) END;
    planned_body:=CASE WHEN index_value=0 THEN plan_body->'original' ELSE plan_body->'renditions'->(index_value-1) END;
    keys:=CASE WHEN index_value=0 THEN output_fields ELSE output_fields||ARRAY['width','height'] END;
    IF NOT ((jsonb_typeof(output_body)='object' AND output_body ?& keys AND output_body-keys='{}'::jsonb
      AND output_body->'key'=planned_body->'key' AND output_body->'objectEvidenceReference'=planned_body->'objectEvidenceReference'
      AND output_body->'providerObjectVersion'=planned_body->'providerObjectVersion' AND output_body->'bucket'=destination->'bucket'
      AND jsonb_typeof(output_body->'versionId')='string' AND output_body->>'versionId' ~ '^[!-~]+$'
      AND length(output_body->>'versionId')<=1024 AND output_body->>'versionId'<>'null'
      AND jsonb_typeof(output_body->'etag')='string' AND output_body->>'etag' ~ '^[!-~]{1,128}$'
      AND position('"' in output_body->>'etag')=0 AND position(chr(92) in output_body->>'etag')=0
      AND jsonb_typeof(output_body->'checksum')='string' AND output_body->>'checksum' ~ '^sha256:[0-9a-f]{64}$'
      AND jsonb_typeof(output_body->'byteSize')='number' AND output_body->>'byteSize' ~ '^[0-9]+$'
      AND (output_body->>'byteSize')::numeric BETWEEN 1 AND 10485760) IS TRUE) THEN
      RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_INVALID' USING ERRCODE='23514';
    END IF;
    IF index_value=0 THEN
      IF output_body->'contentType' IS DISTINCT FROM source_version.snapshot_json->'contentType'
        OR output_body->'byteSize' IS DISTINCT FROM source_version.snapshot_json->'byteSize'
        OR output_body->'checksum' IS DISTINCT FROM source_version.snapshot_json->'checksum' THEN
        RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_SOURCE_INVALID' USING ERRCODE='23514';
      END IF;
    ELSE
      SELECT count(*) INTO actual_count FROM bop_media.image_rendition r WHERE r.asset_version_id=intent_row.target_asset_version_id
        AND r.tenant_id=intent_row.tenant_id AND r.brand_id=intent_row.brand_id AND r.store_id IS NOT DISTINCT FROM intent_row.store_id
        AND r.content_type=types[index_value] AND r.width=widths[index_value] AND r.snapshot_json=output_body;
      IF actual_count<>1 THEN RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_RENDITIONS_REQUIRED' USING ERRCODE='23514'; END IF;
      IF mod(index_value,2)=0 AND output_body->'height' IS DISTINCT FROM body->'renditions'->(index_value-2)->'height' THEN
        RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_INVALID' USING ERRCODE='23514';
      END IF;
    END IF;
  END LOOP;
  SELECT count(*),sum(r.byte_size) INTO actual_count,total_bytes FROM bop_media.image_rendition r
    WHERE r.asset_version_id=intent_row.target_asset_version_id AND r.tenant_id=intent_row.tenant_id
      AND r.brand_id=intent_row.brand_id AND r.store_id IS NOT DISTINCT FROM intent_row.store_id;
  IF actual_count<>6 OR total_bytes>31457280 THEN RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_RENDITIONS_REQUIRED' USING ERRCODE='23514'; END IF;
  representative:=body->'renditions'->4;
  expected_asset:=(source_body->'asset')||jsonb_build_object('version',intent_row.expected_asset_version+1,'currentVersionReference',intent_row.target_asset_version_id::text);
  expected_version:=jsonb_build_object('assetVersionId',intent_row.target_asset_version_id::text,'assetId',intent_row.asset_id::text,
    'version',intent_row.expected_asset_version+1,'objectEvidenceReference',representative->'objectEvidenceReference',
    'providerObjectVersion',representative->'providerObjectVersion','byteSize',representative->'byteSize','checksum',representative->'checksum',
    'contentType','image/jpeg','checkState','Clean','readinessState','Ready',
    'createdAt',to_char(completion_row.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  IF completion_row.asset_snapshot_json IS DISTINCT FROM expected_asset OR completion_row.new_version_json IS DISTINCT FROM expected_version
    OR asset_row.version<intent_row.expected_asset_version+1
    OR (asset_row.version=intent_row.expected_asset_version+1 AND asset_row.snapshot_json IS DISTINCT FROM expected_asset) THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_ROOT_CONFLICT' USING ERRCODE='23514';
  END IF;
  SELECT * INTO target_version FROM bop_media.asset_version v WHERE v.asset_version_id=intent_row.target_asset_version_id
    AND v.asset_id=intent_row.asset_id AND v.upload_session_id=source_version.upload_session_id AND v.tenant_id=intent_row.tenant_id
    AND v.brand_id=intent_row.brand_id AND v.store_id IS NOT DISTINCT FROM intent_row.store_id;
  IF NOT FOUND OR target_version.version<>intent_row.expected_asset_version+1 OR target_version.created_at<>completion_row.recorded_at
    OR target_version.snapshot_json IS DISTINCT FROM expected_version THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_ORIGIN_INVALID' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='asset' THEN
    IF NEW.snapshot_json IS DISTINCT FROM expected_asset OR OLD.version<>intent_row.expected_asset_version THEN
      RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_ROOT_CONFLICT' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_media.assert_media_image_processing_origin() FROM PUBLIC;

-- Preserve the original upload origin checks, selecting its immutable v1
-- source after promotion and comparing only immutable Asset metadata.
CREATE OR REPLACE FUNCTION bop_media.assert_media_upload_origin()
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
  IF TG_TABLE_NAME='asset_version' THEN
    IF NEW.version>1 THEN RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME='asset' THEN
    SELECT v.upload_session_id INTO session_id FROM bop_media.asset_version v
      WHERE v.asset_id=NEW.asset_id AND v.version=1 AND v.tenant_id=NEW.tenant_id AND v.brand_id=NEW.brand_id AND v.store_id IS NOT DISTINCT FROM NEW.store_id;
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
  IF NOT FOUND OR finalized.result_json#>'{asset,version}' IS DISTINCT FROM '1'::jsonb
    OR finalized.result_json#>'{asset,currentVersionReference}' IS DISTINCT FROM 'null'::jsonb
    OR ((finalized.result_json->'asset')-ARRAY['version','currentVersionReference']) IS DISTINCT FROM (asset_row.snapshot_json-ARRAY['version','currentVersionReference']) THEN
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

CREATE TRIGGER media_image_processing_intent_guard BEFORE INSERT OR UPDATE OR DELETE ON bop_media.image_processing_intent FOR EACH ROW EXECUTE FUNCTION bop_media.guard_media_image_processing();
CREATE TRIGGER media_image_processing_intent_no_truncate BEFORE TRUNCATE ON bop_media.image_processing_intent FOR EACH STATEMENT EXECUTE FUNCTION bop_media.guard_media_image_processing();
CREATE CONSTRAINT TRIGGER media_image_processing_intent_origin AFTER INSERT ON bop_media.image_processing_intent DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_media.assert_media_image_processing_origin();
ALTER TABLE bop_media.image_processing_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_media.image_processing_intent FORCE ROW LEVEL SECURITY;
CREATE POLICY media_image_processing_intent_scope ON bop_media.image_processing_intent
  USING (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id())
  WITH CHECK (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id());
REVOKE ALL ON TABLE bop_media.image_processing_intent FROM PUBLIC;

CREATE TRIGGER media_image_processing_completion_guard BEFORE INSERT OR UPDATE OR DELETE ON bop_media.image_processing_completion FOR EACH ROW EXECUTE FUNCTION bop_media.guard_media_image_processing();
CREATE TRIGGER media_image_processing_completion_no_truncate BEFORE TRUNCATE ON bop_media.image_processing_completion FOR EACH STATEMENT EXECUTE FUNCTION bop_media.guard_media_image_processing();
CREATE CONSTRAINT TRIGGER media_image_processing_completion_origin AFTER INSERT ON bop_media.image_processing_completion DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_media.assert_media_image_processing_origin();
ALTER TABLE bop_media.image_processing_completion ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_media.image_processing_completion FORCE ROW LEVEL SECURITY;
CREATE POLICY media_image_processing_completion_scope ON bop_media.image_processing_completion
  USING (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id())
  WITH CHECK (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id());
REVOKE ALL ON TABLE bop_media.image_processing_completion FROM PUBLIC;

CREATE TRIGGER media_image_rendition_guard BEFORE INSERT OR UPDATE OR DELETE ON bop_media.image_rendition FOR EACH ROW EXECUTE FUNCTION bop_media.guard_media_image_processing();
CREATE TRIGGER media_image_rendition_no_truncate BEFORE TRUNCATE ON bop_media.image_rendition FOR EACH STATEMENT EXECUTE FUNCTION bop_media.guard_media_image_processing();
CREATE CONSTRAINT TRIGGER media_image_rendition_origin AFTER INSERT ON bop_media.image_rendition DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_media.assert_media_image_processing_origin();
ALTER TABLE bop_media.image_rendition ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_media.image_rendition FORCE ROW LEVEL SECURITY;
CREATE POLICY media_image_rendition_scope ON bop_media.image_rendition
  USING (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id())
  WITH CHECK (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id());
REVOKE ALL ON TABLE bop_media.image_rendition FROM PUBLIC;

CREATE CONSTRAINT TRIGGER media_promoted_asset_origin AFTER UPDATE ON bop_media.asset DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_media.assert_media_image_processing_origin();
CREATE CONSTRAINT TRIGGER media_promoted_version_origin AFTER INSERT ON bop_media.asset_version DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_media.assert_media_image_processing_origin();
