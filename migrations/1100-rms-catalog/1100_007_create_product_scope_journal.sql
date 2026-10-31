-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- New participating publication operations only; historical absence is NotRecorded.
ALTER TABLE rms_catalog.product_publication_revision ADD CONSTRAINT product_publication_journal_tuple_unique
 UNIQUE(operation_id,tenant_id,brand_id,product_id,source_aggregate_version,intent_digest,state);
CREATE TABLE rms_catalog.product_scope_journal (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL REFERENCES rms_catalog.product_source_head(brand_id),
 product_id platform_helpers.uuid_v7 NOT NULL,
 source_aggregate_version integer NOT NULL CHECK(source_aggregate_version>0),
 source_revision bigint NOT NULL CHECK(source_revision>0),
 intent_digest text NOT NULL CHECK(intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 journal_digest text NOT NULL CHECK(journal_digest ~ '^sha256:[0-9a-f]{64}$'),
 state text NOT NULL DEFAULT 'Published' CHECK(state='Published'),
 snapshot_json jsonb NOT NULL CHECK(jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=2097152),
 data_classification text NOT NULL DEFAULT 'ConfigurationMetadata' CHECK(data_classification='ConfigurationMetadata'),
 FOREIGN KEY(operation_id,tenant_id,brand_id,product_id,source_aggregate_version,intent_digest,state)
 REFERENCES rms_catalog.product_publication_revision(operation_id,tenant_id,brand_id,product_id,source_aggregate_version,intent_digest,state),
 CHECK((snapshot_json->>'profile') IS NOT DISTINCT FROM 'CatalogProductScopeJournalV1'),
 CHECK((snapshot_json->>'coverage') IS NOT DISTINCT FROM 'CompleteLatestOwningPublicationHeads'),
 CHECK((snapshot_json->>'eligibility') IS NOT DISTINCT FROM 'NotEvaluated'),
 CHECK((snapshot_json->>'wholeVersionSupersession') IS NOT DISTINCT FROM 'NotEvaluated'),
 CHECK((snapshot_json->>'digest') IS NOT DISTINCT FROM journal_digest),
 CHECK((snapshot_json->'sourceAggregateVersion') IS NOT DISTINCT FROM to_jsonb(source_aggregate_version)),
 CHECK((snapshot_json->>'sourceRevision') IS NOT DISTINCT FROM source_revision::text),
 CHECK((snapshot_json->'incoming'->>'tenantReference') IS NOT DISTINCT FROM tenant_id::text),
 CHECK((snapshot_json->'incoming'->>'brandReference') IS NOT DISTINCT FROM brand_id::text),
 CHECK((snapshot_json->'incoming'->>'productReference') IS NOT DISTINCT FROM product_id::text),
 CHECK((snapshot_json->'incoming'->>'operationReference') IS NOT DISTINCT FROM operation_id::text),
 CHECK((snapshot_json->'incoming'->>'intentDigest') IS NOT DISTINCT FROM intent_digest),
 CHECK((snapshot_json->'incoming'->>'state') IS NOT DISTINCT FROM state),
 CHECK((jsonb_typeof(snapshot_json->'latest')='array' AND jsonb_typeof(snapshot_json->'plan')='object' AND snapshot_json->'plan'->>'analysis'='CompleteSelectorAnalysis') IS TRUE)
);
CREATE TRIGGER product_scope_journal_immutable BEFORE UPDATE OR DELETE ON rms_catalog.product_scope_journal
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_publication_immutable();
ALTER TABLE rms_catalog.product_scope_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_scope_journal FORCE ROW LEVEL SECURITY;
CREATE POLICY product_scope_journal_scope ON rms_catalog.product_scope_journal
 USING (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
 WITH CHECK (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON TABLE rms_catalog.product_scope_journal FROM PUBLIC;
