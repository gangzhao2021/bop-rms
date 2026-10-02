-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Complete own-source snapshots; not a fabricated complete cross-module projection.
CREATE TABLE rms_catalog.product_search_generation (
  generation_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  build_kind text NOT NULL CHECK (build_kind IN ('Rebuild','Event')),
  actor_id platform_helpers.uuid_v7 NOT NULL,
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_revision bigint NOT NULL CHECK (source_revision >= 0),
  source_digest text NOT NULL CHECK (source_digest ~ '^sha256:[0-9a-f]{64}$'),
  projected_at timestamp with time zone NOT NULL CHECK (date_trunc('milliseconds',projected_at)=projected_at),
  product_count integer NOT NULL CHECK (product_count >= 0),
  source_coverage text NOT NULL CHECK (source_coverage = 'CatalogProductDraftV1'),
  is_partial boolean NOT NULL CHECK (is_partial IS TRUE),
  data_classification text NOT NULL DEFAULT 'ConfigurationMetadata' CHECK (data_classification = 'ConfigurationMetadata'),
  UNIQUE(brand_id,build_kind,operation_id),
  UNIQUE(generation_id,brand_id),
  UNIQUE(generation_id,brand_id,source_revision,source_digest)
);
CREATE TABLE rms_catalog.product_search_row (
  generation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  product_id platform_helpers.uuid_v7 NOT NULL,
  source_json jsonb NOT NULL CHECK (jsonb_typeof(source_json)='object'),
  list_json jsonb NOT NULL CHECK (jsonb_typeof(list_json)='object'),
  list_digest text NOT NULL CHECK (list_digest ~ '^sha256:[0-9a-f]{64}$'),
  row_digest text NOT NULL CHECK (row_digest ~ '^sha256:[0-9a-f]{64}$'),
  data_classification text NOT NULL DEFAULT 'ConfigurationMetadata' CHECK (data_classification = 'ConfigurationMetadata'),
  PRIMARY KEY(generation_id,product_id),
  FOREIGN KEY(generation_id,brand_id) REFERENCES rms_catalog.product_search_generation(generation_id,brand_id),
  CHECK ((source_json->>'productReference') IS NOT DISTINCT FROM product_id::text),
  CHECK ((source_json->>'brandReference') IS NOT DISTINCT FROM brand_id::text),
  CHECK ((list_json->>'productReference') IS NOT DISTINCT FROM product_id::text),
  CHECK ((list_json->>'brandReference') IS NOT DISTINCT FROM brand_id::text)
);
CREATE TABLE rms_catalog.product_search_activation (
  brand_id platform_helpers.uuid_v7 PRIMARY KEY,
  generation_id platform_helpers.uuid_v7 NOT NULL,
  source_revision bigint NOT NULL CHECK (source_revision >= 0),
  source_digest text NOT NULL CHECK (source_digest ~ '^sha256:[0-9a-f]{64}$'),
  data_classification text NOT NULL DEFAULT 'ConfigurationMetadata' CHECK (data_classification = 'ConfigurationMetadata'),
  FOREIGN KEY(generation_id,brand_id,source_revision,source_digest)
    REFERENCES rms_catalog.product_search_generation(generation_id,brand_id,source_revision,source_digest)
);
CREATE RULE product_search_generation_no_update AS ON UPDATE TO rms_catalog.product_search_generation DO INSTEAD NOTHING;
CREATE RULE product_search_generation_no_delete AS ON DELETE TO rms_catalog.product_search_generation DO INSTEAD NOTHING;
CREATE RULE product_search_row_no_update AS ON UPDATE TO rms_catalog.product_search_row DO INSTEAD NOTHING;
CREATE RULE product_search_row_no_delete AS ON DELETE TO rms_catalog.product_search_row DO INSTEAD NOTHING;
ALTER TABLE rms_catalog.product_search_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_search_generation FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_search_row ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_search_row FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_search_activation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_search_activation FORCE ROW LEVEL SECURITY;
CREATE POLICY product_search_generation_brand_scope ON rms_catalog.product_search_generation
  USING (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY product_search_row_brand_scope ON rms_catalog.product_search_row
  USING (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY product_search_activation_brand_scope ON rms_catalog.product_search_activation
  USING (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON TABLE rms_catalog.product_search_generation,rms_catalog.product_search_row,rms_catalog.product_search_activation FROM PUBLIC;
