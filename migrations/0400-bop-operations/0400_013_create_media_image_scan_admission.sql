-- bop-rms-migration: 1
-- owner: @bop/media
-- schema: bop_media
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Immutable owning receipt for an authenticated, scoped scan delivery. Neither
-- this stored JSON nor these SQL constraints confer System Permission or prove
-- transport authenticity; the private admission factory holds both authorities.
CREATE TABLE bop_media.image_scan_admission (
  admission_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  workload_id platform_helpers.uuid_v7 NOT NULL,
  deployment_config_digest text NOT NULL CHECK (deployment_config_digest ~ '^sha256:[0-9a-f]{64}$'),
  quarantine_config_digest text NOT NULL CHECK (quarantine_config_digest ~ '^sha256:[0-9a-f]{64}$'),
  provider_account text NOT NULL CHECK (provider_account ~ '^[0-9]{12}$'),
  region text NOT NULL CHECK (region='ca-central-1'),
  protection_plan_arn text NOT NULL,
  event_id text NOT NULL CHECK (event_id ~ '^[A-Za-z0-9-]{1,128}$'),
  event_digest text NOT NULL CHECK (event_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_asset_version_id platform_helpers.uuid_v7 NOT NULL,
  source_binding_digest text NOT NULL CHECK (source_binding_digest ~ '^sha256:[0-9a-f]{64}$'),
  bucket text NOT NULL,
  key text NOT NULL,
  version_id text NOT NULL CHECK (version_id ~ '^[!-~]+$' AND length(version_id)<=1024 AND version_id<>'null'),
  etag text NOT NULL CHECK (etag ~ '^[!-~]{1,128}$' AND position('"' in etag)=0 AND position(chr(92) in etag)=0),
  admitted_at timestamptz NOT NULL CHECK (isfinite(admitted_at) AND admitted_at=date_trunc('milliseconds',admitted_at)),
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  correlation_id platform_helpers.uuid_v7 NOT NULL,
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=65536),
  digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  UNIQUE(provider_account,region,event_id),
  UNIQUE(tenant_id,brand_id,admission_id),
  FOREIGN KEY (tenant_id,brand_id,source_asset_version_id) REFERENCES bop_media.asset_version(tenant_id,brand_id,asset_version_id) DEFERRABLE INITIALLY DEFERRED
);

-- NOT VALID deliberately preserves pre-admission history, without rewriting its
-- JSON or permitting any new unadmitted intent. PostgreSQL enforces this CHECK
-- for every subsequent insert even though old rows are not scanned.
ALTER TABLE bop_media.image_processing_intent ADD COLUMN scan_admission_id platform_helpers.uuid_v7;
ALTER TABLE bop_media.image_processing_intent ADD CONSTRAINT media_image_processing_admission_required CHECK (scan_admission_id IS NOT NULL) NOT VALID;
ALTER TABLE bop_media.image_processing_intent ADD CONSTRAINT media_image_processing_admission_scope FOREIGN KEY (tenant_id,brand_id,scan_admission_id) REFERENCES bop_media.image_scan_admission(tenant_id,brand_id,admission_id) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION bop_media.guard_media_image_scan_admission()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  body jsonb;
  event_body jsonb;
  detail_body jsonb;
  object_body jsonb;
  transport_body jsonb;
  keys text[];
  instant_text text;
  field_name text;
  instant_pattern constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$';
  digest_pattern constant text := '^sha256:[0-9a-f]{64}$';
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'MEDIA_IMAGE_SCAN_ADMISSION_IMMUTABLE' USING ERRCODE='55000'; END IF;
  body:=NEW.snapshot_json;
  keys:=ARRAY['profile','admissionReference','tenantReference','scope','workloadReference','deploymentConfigurationDigest','quarantineConfigurationDigest','providerAccount','region','protectionPlanArn','eventId','scanEventDigest','scanEvent','sourceAssetVersionReference','sourceBindingDigest','object','transport','admittedAt','auditReference','correlationId','digest'];
  IF NOT ((body ?& keys AND body-keys='{}'::jsonb
    AND body->'profile'='"MEDIA_IMAGE_SCAN_ADMISSION_V1"'::jsonb
    AND body->'admissionReference'=to_jsonb(NEW.admission_id::text)
    AND body->'tenantReference'=to_jsonb(NEW.tenant_id::text)
    AND body->'scope'=jsonb_build_object('kind',CASE WHEN NEW.store_id IS NULL THEN 'Brand' ELSE 'Store' END,'brandReference',NEW.brand_id::text,'storeReference',NEW.store_id::text)
    AND body->'workloadReference'=to_jsonb(NEW.workload_id::text)
    AND body->'deploymentConfigurationDigest'=to_jsonb(NEW.deployment_config_digest)
    AND body->'quarantineConfigurationDigest'=to_jsonb(NEW.quarantine_config_digest)
    AND body->'providerAccount'=to_jsonb(NEW.provider_account)
    AND body->'region'=to_jsonb(NEW.region)
    AND body->'protectionPlanArn'=to_jsonb(NEW.protection_plan_arn)
    AND NEW.protection_plan_arn ~ ('^arn:aws:guardduty:ca-central-1:' || NEW.provider_account || ':malware-protection-plan/[A-Za-z0-9]{1,64}$')
    AND body->'eventId'=to_jsonb(NEW.event_id) AND body->'scanEventDigest'=to_jsonb(NEW.event_digest)
    AND body->'sourceAssetVersionReference'=to_jsonb(NEW.source_asset_version_id::text)
    AND body->'sourceBindingDigest'=to_jsonb(NEW.source_binding_digest)
    AND body->'auditReference'=to_jsonb(NEW.audit_id::text)
    AND body->'correlationId'=to_jsonb(NEW.correlation_id::text) AND body->'digest'=to_jsonb(NEW.digest)
    AND body->'admittedAt'=to_jsonb(to_char(NEW.admitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    AND NEW.bucket ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' AND NEW.bucket !~ '^xn--' AND NEW.bucket !~ '(-s3alias|--ol-s3|--x-s3)$'
    AND NEW.key ~ '^[a-z0-9/_-]+$' AND length(NEW.key)<=256) IS TRUE) THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_SCAN_ADMISSION_INVALID' USING ERRCODE='23514';
  END IF;
  object_body:=body->'object';
  keys:=ARRAY['bucket','key','versionId','etag','objectEvidenceReference','providerObjectVersion'];
  IF NOT ((jsonb_typeof(object_body)='object' AND object_body ?& keys AND object_body-keys='{}'::jsonb
    AND object_body->'bucket'=to_jsonb(NEW.bucket) AND object_body->'key'=to_jsonb(NEW.key)
    AND object_body->'versionId'=to_jsonb(NEW.version_id) AND object_body->'etag'=to_jsonb(NEW.etag)
    AND jsonb_typeof(object_body->'objectEvidenceReference')='string' AND object_body->>'objectEvidenceReference' ~ uuid_pattern
    AND jsonb_typeof(object_body->'providerObjectVersion')='string' AND object_body->>'providerObjectVersion' ~ uuid_pattern) IS TRUE) THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_SCAN_ADMISSION_INVALID' USING ERRCODE='23514';
  END IF;
  event_body:=body->'scanEvent';
  keys:=ARRAY['version','id','detail-type','source','account','time','region','resources','detail'];
  IF NOT ((jsonb_typeof(event_body)='object' AND event_body ?& keys AND event_body-keys='{}'::jsonb
    AND event_body->'version'='"0"'::jsonb AND event_body->'id'=to_jsonb(NEW.event_id)
    AND event_body->'detail-type'='"GuardDuty Malware Protection Object Scan Result"'::jsonb
    AND event_body->'source'='"aws.guardduty"'::jsonb AND event_body->'account'=to_jsonb(NEW.provider_account)
    AND event_body->'region'=to_jsonb(NEW.region) AND event_body->'resources'=jsonb_build_array(NEW.protection_plan_arn)
    AND jsonb_typeof(event_body->'time')='string'
    AND event_body->>'time' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$') IS TRUE) THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_SCAN_ADMISSION_INVALID' USING ERRCODE='23514';
  END IF;
  instant_text:=event_body->>'time';
  IF to_char(instant_text::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM
    (CASE WHEN position('.' in instant_text)>0 THEN instant_text ELSE replace(instant_text,'Z','.000Z') END)
    OR instant_text::timestamptz>NEW.admitted_at THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_SCAN_ADMISSION_INVALID' USING ERRCODE='23514';
  END IF;
  detail_body:=event_body->'detail';
  keys:=ARRAY['schemaVersion','scanStatus','resourceType','s3ObjectDetails','scanResultDetails'];
  IF NOT ((jsonb_typeof(detail_body)='object' AND detail_body ?& keys AND detail_body-keys='{}'::jsonb
    AND detail_body->'schemaVersion'='"1.0"'::jsonb AND detail_body->'scanStatus'='"COMPLETED"'::jsonb
    AND detail_body->'resourceType'='"S3_OBJECT"'::jsonb
    AND detail_body->'scanResultDetails'=jsonb_build_object('scanResultStatus','NO_THREATS_FOUND','threats',NULL,'statusReasons',NULL)
    AND jsonb_typeof(detail_body#>'{s3ObjectDetails,s3Throttled}')='boolean'
    AND detail_body->'s3ObjectDetails'=jsonb_build_object('bucketName',NEW.bucket,'objectKey',NEW.key,'eTag',NEW.etag,'versionId',NEW.version_id,'s3Throttled',detail_body#>'{s3ObjectDetails,s3Throttled}')) IS TRUE) THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_SCAN_ADMISSION_INVALID' USING ERRCODE='23514';
  END IF;
  transport_body:=body->'transport';
  keys:=ARRAY['profile','deploymentConfigurationDigest','queueArn','queueCreatedAt','queuePolicyDigest','messageId','sentAt','receivedAt','bodyDigest'];
  IF NOT ((jsonb_typeof(transport_body)='object' AND transport_body ?& keys AND transport_body-keys='{}'::jsonb
    AND transport_body->'profile'='"GUARDDUTY_SQS_DELIVERY_V1"'::jsonb
    AND transport_body->'deploymentConfigurationDigest'=to_jsonb(NEW.deployment_config_digest)
    AND jsonb_typeof(transport_body->'queueArn')='string'
    AND transport_body->>'queueArn' ~ ('^arn:aws:sqs:ca-central-1:' || NEW.provider_account || ':[A-Za-z0-9_-]{1,80}$')
    AND jsonb_typeof(transport_body->'queuePolicyDigest')='string' AND transport_body->>'queuePolicyDigest' ~ digest_pattern
    AND jsonb_typeof(transport_body->'bodyDigest')='string' AND transport_body->>'bodyDigest' ~ digest_pattern
    AND jsonb_typeof(transport_body->'messageId')='string' AND transport_body->>'messageId' ~ '^[A-Za-z0-9-]{1,128}$') IS TRUE) THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_SCAN_ADMISSION_INVALID' USING ERRCODE='23514';
  END IF;
  FOREACH field_name IN ARRAY ARRAY['queueCreatedAt','sentAt','receivedAt'] LOOP
    instant_text:=transport_body->>field_name;
    IF NOT ((jsonb_typeof(transport_body->field_name)='string' AND instant_text ~ instant_pattern) IS TRUE) THEN
      RAISE EXCEPTION 'MEDIA_IMAGE_SCAN_ADMISSION_INVALID' USING ERRCODE='23514';
    END IF;
    IF to_char(instant_text::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM instant_text THEN
      RAISE EXCEPTION 'MEDIA_IMAGE_SCAN_ADMISSION_INVALID' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF (transport_body->>'queueCreatedAt')::timestamptz>(transport_body->>'sentAt')::timestamptz
    OR (transport_body->>'sentAt')::timestamptz>(transport_body->>'receivedAt')::timestamptz
    OR (transport_body->>'receivedAt')::timestamptz>NEW.admitted_at THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_SCAN_ADMISSION_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_media.guard_media_image_scan_admission() FROM PUBLIC;

-- All origin reads remain inside Media, under invoker authority and the same
-- null-safe scope. Canonical hashes are checked by the owning parser; SQL never
-- substitutes jsonb serialization for RFC8785 or treats a hash as authority.
CREATE FUNCTION bop_media.assert_media_image_scan_admission_origin()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  admission_row bop_media.image_scan_admission%ROWTYPE;
  final_binding bop_media.finalized_object_binding%ROWTYPE;
  upload_binding bop_media.upload_object_binding%ROWTYPE;
  source_version bop_media.asset_version%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='image_processing_intent' THEN
    SELECT * INTO admission_row FROM bop_media.image_scan_admission a WHERE a.admission_id=NEW.scan_admission_id
      AND a.tenant_id=NEW.tenant_id AND a.brand_id=NEW.brand_id AND a.store_id IS NOT DISTINCT FROM NEW.store_id;
    IF NOT FOUND OR NEW.scan_admission_id::text IS DISTINCT FROM NEW.intent_json->>'admissionReference'
      OR admission_row.workload_id<>NEW.system_actor_id OR admission_row.source_asset_version_id<>NEW.source_asset_version_id
      OR admission_row.source_binding_digest<>NEW.source_binding_digest OR admission_row.event_id<>NEW.scan_event_id
      OR admission_row.snapshot_json->'scanEvent' IS DISTINCT FROM NEW.intent_json#>'{source,scanEvent}'
      OR admission_row.snapshot_json->'object' IS DISTINCT FROM NEW.intent_json#>'{source,object}'
      OR admission_row.admitted_at>NEW.recorded_at THEN
      RAISE EXCEPTION 'MEDIA_IMAGE_PROCESSING_ADMISSION_INVALID' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  admission_row:=NEW;
  SELECT * INTO source_version FROM bop_media.asset_version v WHERE v.asset_version_id=NEW.source_asset_version_id
    AND v.tenant_id=NEW.tenant_id AND v.brand_id=NEW.brand_id AND v.store_id IS NOT DISTINCT FROM NEW.store_id;
  IF NOT FOUND OR source_version.version<>1 OR source_version.snapshot_json->>'checkState' IS DISTINCT FROM 'Quarantined'
    OR source_version.snapshot_json->>'readinessState' IS DISTINCT FROM 'Pending'
    OR source_version.created_at>NEW.admitted_at THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_SCAN_ADMISSION_SOURCE_INVALID' USING ERRCODE='23514';
  END IF;
  SELECT * INTO final_binding FROM bop_media.finalized_object_binding f WHERE f.asset_version_id=NEW.source_asset_version_id
    AND f.tenant_id=NEW.tenant_id AND f.brand_id=NEW.brand_id AND f.store_id IS NOT DISTINCT FROM NEW.store_id;
  IF NOT FOUND OR final_binding.binding_digest<>NEW.source_binding_digest
    OR final_binding.binding_json->'object' IS DISTINCT FROM NEW.snapshot_json->'object'
    OR final_binding.recorded_at>NEW.admitted_at THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_SCAN_ADMISSION_SOURCE_INVALID' USING ERRCODE='23514';
  END IF;
  SELECT * INTO upload_binding FROM bop_media.upload_object_binding u WHERE u.upload_session_id=final_binding.upload_session_id
    AND u.tenant_id=NEW.tenant_id AND u.brand_id=NEW.brand_id AND u.store_id IS NOT DISTINCT FROM NEW.store_id;
  IF NOT FOUND OR final_binding.binding_json->>'uploadBindingDigest' IS DISTINCT FROM upload_binding.binding_digest
    OR upload_binding.binding_json#>>'{config,accountId}' IS DISTINCT FROM NEW.provider_account
    OR upload_binding.binding_json#>>'{config,region}' IS DISTINCT FROM NEW.region
    OR upload_binding.binding_json#>>'{config,protectionPlanArn}' IS DISTINCT FROM NEW.protection_plan_arn THEN
    RAISE EXCEPTION 'MEDIA_IMAGE_SCAN_ADMISSION_SOURCE_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_media.assert_media_image_scan_admission_origin() FROM PUBLIC;

CREATE TRIGGER media_image_scan_admission_guard BEFORE INSERT OR UPDATE OR DELETE ON bop_media.image_scan_admission FOR EACH ROW EXECUTE FUNCTION bop_media.guard_media_image_scan_admission();
CREATE TRIGGER media_image_scan_admission_no_truncate BEFORE TRUNCATE ON bop_media.image_scan_admission FOR EACH STATEMENT EXECUTE FUNCTION bop_media.guard_media_image_scan_admission();
CREATE CONSTRAINT TRIGGER media_image_scan_admission_origin AFTER INSERT ON bop_media.image_scan_admission DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_media.assert_media_image_scan_admission_origin();
CREATE CONSTRAINT TRIGGER media_image_processing_admission_origin AFTER INSERT ON bop_media.image_processing_intent DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_media.assert_media_image_scan_admission_origin();
ALTER TABLE bop_media.image_scan_admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_media.image_scan_admission FORCE ROW LEVEL SECURITY;
CREATE POLICY media_image_scan_admission_scope ON bop_media.image_scan_admission
  USING (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id())
  WITH CHECK (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id IS NOT DISTINCT FROM platform_helpers.current_store_id());
REVOKE ALL ON TABLE bop_media.image_scan_admission FROM PUBLIC;
