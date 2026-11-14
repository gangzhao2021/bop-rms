-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Legacy absence remains NULL, never synthesized complete empty content.
ALTER TABLE rms_catalog.product_version ADD COLUMN editor_content_json jsonb;
ALTER TABLE rms_catalog.product_version ADD CONSTRAINT product_version_editor_content_check
CHECK(editor_content_json IS NULL OR (
 jsonb_typeof(editor_content_json)='object'
 AND (editor_content_json->>'profile') IS NOT DISTINCT FROM 'CatalogProductEditorContentV1'
 AND octet_length(editor_content_json::text)<=1048576
));
-- Forward compatibility only; previously applied migration bytes remain immutable.
ALTER TABLE rms_catalog.product_publication_content DROP CONSTRAINT product_publication_content_snapshot_json_check1;
ALTER TABLE rms_catalog.product_publication_content ADD CONSTRAINT product_publication_content_profile_check
CHECK(((snapshot_json->>'profile') IN ('CatalogSupportedProductDraftContentV1','CatalogFullProductDraftContentV2')) IS TRUE);
ALTER TABLE rms_catalog.product_publication_content ADD CONSTRAINT product_publication_content_profile_coverage_check
CHECK((
 ((snapshot_json->>'profile')='CatalogSupportedProductDraftContentV1' AND NOT ((snapshot_json->'sourceDraft') ? 'editorContent'))
 OR ((snapshot_json->>'profile')='CatalogFullProductDraftContentV2' AND jsonb_typeof(snapshot_json#>'{sourceDraft,editorContent}')='object')
) IS TRUE);
