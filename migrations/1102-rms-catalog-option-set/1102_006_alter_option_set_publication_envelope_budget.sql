-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Frozen envelope duplicates the original supported source. Draft stays one MiB.
-- The old unnamed constraint is identified by its exact owning table and budget;
-- every profile, tuple and source-coherence predicate is retained below.
CREATE FUNCTION rms_catalog.option_set_replace_publication_budget_constraint() RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
 old_constraints name[];
BEGIN
 SELECT array_agg(c.conname) INTO old_constraints
 FROM pg_catalog.pg_constraint c
 WHERE c.conrelid = 'rms_catalog.option_set_publication_content'::regclass
  AND c.contype = 'c'
  AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%octet_length%snapshot_json%1048576%';
 IF cardinality(old_constraints) IS DISTINCT FROM 1 THEN
  RAISE EXCEPTION 'OPTION_SET_PUBLICATION_BUDGET_CONSTRAINT_INVALID' USING ERRCODE='23514';
 END IF;
 EXECUTE pg_catalog.format('ALTER TABLE rms_catalog.option_set_publication_content DROP CONSTRAINT %I', old_constraints[1]);
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.option_set_replace_publication_budget_constraint() FROM PUBLIC;
SELECT rms_catalog.option_set_replace_publication_budget_constraint();
DROP FUNCTION rms_catalog.option_set_replace_publication_budget_constraint();
ALTER TABLE rms_catalog.option_set_publication_content
 ADD CONSTRAINT option_set_publication_content_snapshot_coherence_check
CHECK((jsonb_typeof(snapshot_json)='object'
  AND octet_length(snapshot_json::text)<=3145728
  AND snapshot_json->>'profile'='CatalogFullOptionSetDraftContentV2'
  AND snapshot_json->>'eligibility'='NotEvaluated'
  AND snapshot_json->>'sourceDigest'=source_digest
  AND snapshot_json->>'contentDigest'=content_digest
  AND snapshot_json->>'configurationDigest'=configuration_digest
  AND snapshot_json->>'digest'=record_digest
  AND jsonb_typeof(snapshot_json->'supportedContent')='object'
  AND snapshot_json#>>'{supportedContent,profile}'='CatalogSupportedOptionSetDraftContentV1'
  AND snapshot_json#>>'{supportedContent,eligibility}'='NotEvaluated'
  AND snapshot_json#>>'{supportedContent,tenantReference}'=tenant_id::text
  AND snapshot_json#>>'{supportedContent,brandReference}'=brand_id::text
  AND snapshot_json#>>'{supportedContent,optionSetReference}'=option_set_id::text
  AND snapshot_json#>>'{supportedContent,versionReference}'=option_set_version_id::text
  AND snapshot_json#>'{supportedContent,sourceAggregateVersion}'=to_jsonb(source_aggregate_version)
  AND snapshot_json#>>'{supportedContent,publicationOperationReference}'=operation_id::text
  AND snapshot_json#>>'{supportedContent,publicationIntentDigest}'=intent_digest
  AND snapshot_json#>>'{supportedContent,successorDraftVersionReference}'=successor_draft_version_id::text
  AND snapshot_json#>>'{supportedContent,sealedAt}'=to_char(sealed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  AND jsonb_typeof(snapshot_json->'editorContent')='object'
  AND snapshot_json#>>'{editorContent,profile}'='CatalogOptionSetEditorContentV1'
  AND snapshot_json#>'{supportedContent,sourceAggregate}'=snapshot_json#>'{editorContent,sourceAggregate}'
  AND snapshot_json#>>'{editorContent,sourceAggregate,brandReference}'=brand_id::text
  AND snapshot_json#>>'{editorContent,sourceAggregate,optionSetReference}'=option_set_id::text
  AND snapshot_json#>'{editorContent,sourceAggregate,aggregateVersion}'=to_jsonb(source_aggregate_version)
  AND snapshot_json#>>'{editorContent,sourceAggregate,lifecycle}'='Draft'
  AND snapshot_json#>>'{editorContent,sourceAggregate,draft,versionReference}'=option_set_version_id::text
  AND snapshot_json#>>'{editorContent,sourceAggregate,draft,status}'='Draft') IS TRUE);
