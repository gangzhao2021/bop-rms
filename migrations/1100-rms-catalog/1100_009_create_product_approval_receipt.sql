-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_catalog.product_approval_receipt (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY REFERENCES rms_catalog.product_publication_revision(operation_id),
 approval_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 product_id platform_helpers.uuid_v7 NOT NULL,
 product_version_id platform_helpers.uuid_v7 NOT NULL,
 publication_version integer NOT NULL CHECK(publication_version>0),
 result_aggregate_version integer NOT NULL CHECK(result_aggregate_version>0),
 receipt_digest text NOT NULL CHECK(receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
 snapshot_json jsonb NOT NULL CHECK(jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=65536),
 recorded_at timestamptz NOT NULL CHECK(date_trunc('milliseconds',recorded_at)=recorded_at),
 data_classification text NOT NULL DEFAULT 'ApprovalEvidence' CHECK(data_classification='ApprovalEvidence'),
 CHECK((snapshot_json->>'profile') IS NOT DISTINCT FROM 'CatalogProductApprovalReceiptV1'),
 CHECK((snapshot_json->>'approvalOperationReference') IS NOT DISTINCT FROM operation_id::text),
 CHECK((snapshot_json#>>'{approval,evidenceReference}') IS NOT DISTINCT FROM approval_id::text),
 CHECK((snapshot_json->>'tenantReference') IS NOT DISTINCT FROM tenant_id::text),
 CHECK((snapshot_json->>'brandReference') IS NOT DISTINCT FROM brand_id::text),
 CHECK((snapshot_json->>'productReference') IS NOT DISTINCT FROM product_id::text),
 CHECK((snapshot_json->>'versionReference') IS NOT DISTINCT FROM product_version_id::text),
 CHECK((snapshot_json->'approvalPublicationVersion') IS NOT DISTINCT FROM to_jsonb(publication_version)),
 CHECK((snapshot_json->'resultAggregateVersion') IS NOT DISTINCT FROM to_jsonb(result_aggregate_version)),
 CHECK((snapshot_json->>'digest') IS NOT DISTINCT FROM receipt_digest),
 CHECK((snapshot_json->>'recordedAt') IS NOT DISTINCT FROM to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);
CREATE TRIGGER product_approval_receipt_immutable BEFORE UPDATE OR DELETE ON rms_catalog.product_approval_receipt
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_publication_immutable();
ALTER TABLE rms_catalog.product_approval_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_approval_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY product_approval_receipt_scope ON rms_catalog.product_approval_receipt
 USING (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
 WITH CHECK (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON TABLE rms_catalog.product_approval_receipt FROM PUBLIC;
