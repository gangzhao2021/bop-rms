-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Exact results for new operations; never infer legacy results from current Drafts.
CREATE TABLE rms_catalog.product_operation_snapshot (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY
    REFERENCES rms_catalog.product_operation_record (operation_id),
  brand_id platform_helpers.uuid_v7 NOT NULL,
  product_id platform_helpers.uuid_v7 NOT NULL,
  result_aggregate_version integer NOT NULL CHECK (result_aggregate_version > 0),
  occurred_at timestamp with time zone NOT NULL,
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  data_classification text NOT NULL DEFAULT 'ConfigurationMetadata'
    CHECK (data_classification = 'ConfigurationMetadata'),
  FOREIGN KEY (product_id, brand_id) REFERENCES rms_catalog.product (product_id, brand_id),
  CHECK ((snapshot_json->>'brandReference') IS NOT DISTINCT FROM brand_id::text),
  CHECK ((snapshot_json->>'productReference') IS NOT DISTINCT FROM product_id::text),
  CHECK ((snapshot_json->'aggregateVersion') IS NOT DISTINCT FROM to_jsonb(result_aggregate_version)),
  UNIQUE (brand_id, product_id, result_aggregate_version)
);
CREATE RULE product_operation_snapshot_no_update AS
  ON UPDATE TO rms_catalog.product_operation_snapshot DO INSTEAD NOTHING;
CREATE RULE product_operation_snapshot_no_delete AS
  ON DELETE TO rms_catalog.product_operation_snapshot DO INSTEAD NOTHING;
ALTER TABLE rms_catalog.product_operation_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_operation_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY product_operation_snapshot_brand_scope ON rms_catalog.product_operation_snapshot
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON TABLE rms_catalog.product_operation_snapshot FROM PUBLIC;
