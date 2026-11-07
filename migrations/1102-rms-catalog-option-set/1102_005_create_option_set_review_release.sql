-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Original preimages and cross-owner references, never current eligibility.
CREATE TABLE rms_catalog.option_set_review_content (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 option_set_id platform_helpers.uuid_v7 NOT NULL,
 option_set_version_id platform_helpers.uuid_v7 NOT NULL,
 source_operation_id platform_helpers.uuid_v7 NOT NULL,
 lifecycle_id platform_helpers.uuid_v7 NOT NULL,
 binding_digest text NOT NULL CHECK(binding_digest ~ '^sha256:[0-9a-f]{64}$'),
 record_digest text NOT NULL CHECK(record_digest ~ '^sha256:[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL CHECK(date_trunc('milliseconds',recorded_at)=recorded_at),
 snapshot_json jsonb NOT NULL,
 data_classification text NOT NULL DEFAULT 'ConfigurationMetadata' CHECK(data_classification='ConfigurationMetadata'),
 UNIQUE(lifecycle_id),
 UNIQUE(operation_id,tenant_id,brand_id,option_set_id,option_set_version_id,binding_digest),
 FOREIGN KEY(source_operation_id) REFERENCES rms_catalog.option_set_draft_content_snapshot(operation_id),
 FOREIGN KEY(option_set_version_id,option_set_id,brand_id) REFERENCES rms_catalog.option_set_version(option_set_version_id,option_set_id,brand_id),
 CHECK((jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=2097152
 AND snapshot_json->>'profile'='CatalogOptionSetReviewRecordV1'
 AND snapshot_json->>'operationReference'=operation_id::text
 AND snapshot_json->>'sourceOperationReference'=source_operation_id::text
 AND snapshot_json->>'lifecycleReference'=lifecycle_id::text
 AND snapshot_json->>'digest'=record_digest
 AND snapshot_json->>'recordedAt'=to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 AND snapshot_json#>>'{binding,profile}'='CatalogOptionSetContentReviewBindingV1'
 AND snapshot_json#>>'{binding,tenantReference}'=tenant_id::text
 AND snapshot_json#>>'{binding,brandReference}'=brand_id::text
 AND snapshot_json#>>'{binding,optionSetReference}'=option_set_id::text
 AND snapshot_json#>>'{binding,versionReference}'=option_set_version_id::text
 AND snapshot_json#>>'{binding,digest}'=binding_digest
 AND snapshot_json#>>'{content,profile}'='CatalogOptionSetEditorContentV1') IS TRUE)
);
CREATE TABLE rms_catalog.option_set_publication_release (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 option_set_id platform_helpers.uuid_v7 NOT NULL,
 option_set_version_id platform_helpers.uuid_v7 NOT NULL,
 review_operation_id platform_helpers.uuid_v7 NOT NULL,
 seal_operation_id platform_helpers.uuid_v7 NOT NULL,
 release_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 binding_digest text NOT NULL CHECK(binding_digest ~ '^sha256:[0-9a-f]{64}$'),
 seal_record_digest text NOT NULL CHECK(seal_record_digest ~ '^sha256:[0-9a-f]{64}$'),
 record_digest text NOT NULL CHECK(record_digest ~ '^sha256:[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL CHECK(date_trunc('milliseconds',recorded_at)=recorded_at),
 snapshot_json jsonb NOT NULL,
 data_classification text NOT NULL DEFAULT 'ConfigurationMetadata' CHECK(data_classification='ConfigurationMetadata'),
 FOREIGN KEY(review_operation_id,tenant_id,brand_id,option_set_id,option_set_version_id,binding_digest)
  REFERENCES rms_catalog.option_set_review_content(operation_id,tenant_id,brand_id,option_set_id,option_set_version_id,binding_digest),
 FOREIGN KEY(seal_operation_id) REFERENCES rms_catalog.option_set_publication_content(operation_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=1048576
 AND snapshot_json->>'profile'='CatalogOptionSetReleaseRecordV1'
 AND snapshot_json->>'operationReference'=operation_id::text
 AND snapshot_json->>'tenantReference'=tenant_id::text
 AND snapshot_json->>'brandReference'=brand_id::text
 AND snapshot_json->>'optionSetReference'=option_set_id::text
 AND snapshot_json->>'versionReference'=option_set_version_id::text
 AND snapshot_json->>'reviewOperationReference'=review_operation_id::text
 AND snapshot_json->>'sealOperationReference'=seal_operation_id::text
 AND snapshot_json->>'reviewBindingDigest'=binding_digest
 AND snapshot_json->>'sealRecordDigest'=seal_record_digest
 AND snapshot_json->>'digest'=record_digest
 AND snapshot_json->>'recordedAt'=to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 AND snapshot_json#>>'{release,releaseId}'=release_id::text
 AND snapshot_json#>>'{release,familyReference}'=option_set_id::text
 AND snapshot_json#>>'{release,snapshotReference}'=option_set_version_id::text
 AND snapshot_json#>>'{release,snapshotDigest}'=binding_digest
 AND snapshot_json#>>'{release,configurationType}'='CATALOG_OPTION_SET'
 AND snapshot_json#>>'{release,purposeCode}'='CATALOG_OPTION_SET_PUBLICATION'
 AND snapshot_json#>>'{release,kind}'='Publish'
 AND snapshot_json#>>'{release,scope,brandReference}'=brand_id::text
 AND snapshot_json#>>'{release,createdAt}'=snapshot_json->>'recordedAt') IS TRUE)
);
ALTER TABLE rms_catalog.option_set_review_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.option_set_review_content FORCE ROW LEVEL SECURITY;
CREATE POLICY option_set_review_content_scope ON rms_catalog.option_set_review_content
 USING((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE)
 WITH CHECK((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE);
ALTER TABLE rms_catalog.option_set_publication_release ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.option_set_publication_release FORCE ROW LEVEL SECURITY;
CREATE POLICY option_set_publication_release_scope ON rms_catalog.option_set_publication_release
 USING((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE)
 WITH CHECK((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE);
REVOKE ALL ON TABLE rms_catalog.option_set_review_content,rms_catalog.option_set_publication_release FROM PUBLIC;
CREATE FUNCTION rms_catalog.option_set_review_release_immutable() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'OPTION_SET_REVIEW_RELEASE_IMMUTABLE' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.option_set_review_release_immutable() FROM PUBLIC;
CREATE TRIGGER option_set_review_content_immutable BEFORE UPDATE OR DELETE ON rms_catalog.option_set_review_content
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.option_set_review_release_immutable();
CREATE TRIGGER option_set_publication_release_immutable BEFORE UPDATE OR DELETE ON rms_catalog.option_set_publication_release
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.option_set_review_release_immutable();
CREATE FUNCTION rms_catalog.option_set_review_release_coherent() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE source_row rms_catalog.option_set_draft_content_snapshot%ROWTYPE;
 review_row rms_catalog.option_set_review_content%ROWTYPE;
 sealed_row rms_catalog.option_set_publication_content%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='option_set_review_content' THEN
  SELECT * INTO source_row FROM rms_catalog.option_set_draft_content_snapshot WHERE operation_id=NEW.source_operation_id;
  IF NOT FOUND OR (source_row.tenant_id=NEW.tenant_id AND source_row.brand_id=NEW.brand_id
   AND source_row.option_set_id=NEW.option_set_id AND source_row.option_set_version_id=NEW.option_set_version_id
   AND source_row.snapshot_json=NEW.snapshot_json->'content'
   AND to_jsonb(source_row.result_aggregate_version)=NEW.snapshot_json#>'{binding,expectedAggregateVersion}'
   AND source_row.source_digest=NEW.snapshot_json#>>'{binding,sourceDigest}'
   AND source_row.content_digest=NEW.snapshot_json#>>'{binding,contentDigest}'
   AND source_row.configuration_digest=NEW.snapshot_json#>>'{binding,configurationDigest}'
   AND source_row.occurred_at<=NEW.recorded_at) IS NOT TRUE THEN
   RAISE EXCEPTION 'OPTION_SET_REVIEW_SOURCE_INCOHERENT' USING ERRCODE='23514';
  END IF;
 ELSE
  SELECT * INTO review_row FROM rms_catalog.option_set_review_content WHERE operation_id=NEW.review_operation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'OPTION_SET_REVIEW_SOURCE_INCOHERENT' USING ERRCODE='23514'; END IF;
  SELECT * INTO sealed_row FROM rms_catalog.option_set_publication_content WHERE operation_id=NEW.seal_operation_id;
  IF NOT FOUND OR (sealed_row.tenant_id=NEW.tenant_id AND sealed_row.brand_id=NEW.brand_id
   AND sealed_row.option_set_id=NEW.option_set_id AND sealed_row.option_set_version_id=NEW.option_set_version_id
   AND sealed_row.record_digest=NEW.seal_record_digest AND sealed_row.sealed_at=NEW.recorded_at
   AND sealed_row.snapshot_json->'editorContent'=review_row.snapshot_json->'content'
   AND sealed_row.source_digest=review_row.snapshot_json#>>'{binding,sourceDigest}'
   AND sealed_row.content_digest=review_row.snapshot_json#>>'{binding,contentDigest}'
   AND sealed_row.configuration_digest=review_row.snapshot_json#>>'{binding,configurationDigest}'
   AND review_row.record_digest=NEW.snapshot_json->>'reviewRecordDigest'
   AND review_row.lifecycle_id::text=NEW.snapshot_json#>>'{release,sourceLifecycleId}'
   AND review_row.recorded_at<=NEW.recorded_at) IS NOT TRUE THEN
   RAISE EXCEPTION 'OPTION_SET_RELEASE_SOURCE_INCOHERENT' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.option_set_review_release_coherent() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER option_set_review_source_coherent AFTER INSERT ON rms_catalog.option_set_review_content
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_catalog.option_set_review_release_coherent();
CREATE CONSTRAINT TRIGGER option_set_release_source_coherent AFTER INSERT ON rms_catalog.option_set_publication_release
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_catalog.option_set_review_release_coherent();
CREATE TRIGGER option_set_review_content_no_truncate BEFORE TRUNCATE ON rms_catalog.option_set_review_content
 FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.option_set_review_release_immutable();
CREATE TRIGGER option_set_publication_release_no_truncate BEFORE TRUNCATE ON rms_catalog.option_set_publication_release
 FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.option_set_review_release_immutable();
