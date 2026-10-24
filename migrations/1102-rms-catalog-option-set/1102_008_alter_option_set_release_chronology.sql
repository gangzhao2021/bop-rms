-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Preserve immutable Review and Seal observations; Release records actual Publish time.
-- Existing deferred triggers keep using the same owner function and full source tuple.
CREATE OR REPLACE FUNCTION rms_catalog.option_set_review_release_coherent() RETURNS trigger LANGUAGE plpgsql
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
   AND sealed_row.record_digest=NEW.seal_record_digest
   AND review_row.recorded_at<=sealed_row.sealed_at AND sealed_row.sealed_at<=NEW.recorded_at
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
