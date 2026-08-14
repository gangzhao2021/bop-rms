-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- work-package: WP-2101
ALTER TABLE rms_catalog.availability_rule
  ADD COLUMN sellable_type text NOT NULL DEFAULT 'Sku'
    CHECK (sellable_type IN ('Product', 'Sku', 'Bundle')),
  ADD COLUMN product_id platform_helpers.uuid_v7,
  ADD COLUMN bundle_id platform_helpers.uuid_v7;

ALTER TABLE rms_catalog.availability_rule
  ALTER COLUMN sku_id DROP NOT NULL,
  ADD CONSTRAINT availability_rule_sku_compatibility_check CHECK (
    (sellable_type = 'Sku' AND sku_id IS NOT NULL AND product_id IS NULL AND bundle_id IS NULL) OR
    (sellable_type = 'Product' AND product_id IS NOT NULL AND sku_id IS NULL AND bundle_id IS NULL) OR
    (sellable_type = 'Bundle' AND bundle_id IS NOT NULL AND sku_id IS NULL AND product_id IS NULL)
  ),
  ADD CONSTRAINT availability_rule_product_fk FOREIGN KEY (product_id, brand_id)
    REFERENCES rms_catalog.product (product_id, brand_id),
  ADD CONSTRAINT availability_rule_bundle_fk FOREIGN KEY (bundle_id, brand_id)
    REFERENCES rms_catalog.bundle (bundle_id, brand_id);

DROP INDEX rms_catalog.availability_rule_resolution_idx;
CREATE INDEX availability_rule_resolution_idx ON rms_catalog.availability_rule
  (brand_id, sellable_type, store_id, lifecycle, priority DESC, effective_from, effective_until);
CREATE INDEX availability_rule_product_resolution_idx ON rms_catalog.availability_rule (brand_id, product_id) WHERE product_id IS NOT NULL;
CREATE INDEX availability_rule_bundle_resolution_idx ON rms_catalog.availability_rule (brand_id, bundle_id) WHERE bundle_id IS NOT NULL;

CREATE TABLE rms_catalog.availability_workbench_projection_generation (
  generation_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  projection_version integer NOT NULL CHECK (projection_version > 0),
  source_event_sequence bigint NOT NULL CHECK (source_event_sequence >= 0),
  built_at timestamp with time zone NOT NULL,
  CONSTRAINT availability_workbench_generation_brand_unique UNIQUE (generation_id, brand_id)
);

CREATE TABLE rms_catalog.availability_workbench_projection (
  generation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  availability_rule_id platform_helpers.uuid_v7 NOT NULL,
  internal_code text NOT NULL CHECK (internal_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft', 'Active', 'Inactive', 'Archived')),
  sellable_type text NOT NULL CHECK (sellable_type IN ('Product', 'Sku', 'Bundle')),
  sellable_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  channel_codes_json jsonb NOT NULL CHECK (jsonb_typeof(channel_codes_json) = 'array'),
  order_type_codes_json jsonb NOT NULL CHECK (jsonb_typeof(order_type_codes_json) = 'array'),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  decision text NOT NULL CHECK (decision IN ('Available', 'Unavailable')),
  priority integer NOT NULL CHECK (priority BETWEEN 1 AND 1000),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  projected_at timestamp with time zone NOT NULL,
  PRIMARY KEY (generation_id, availability_rule_id),
  CONSTRAINT availability_workbench_projection_generation_fk FOREIGN KEY (generation_id, brand_id)
    REFERENCES rms_catalog.availability_workbench_projection_generation (generation_id, brand_id),
  CONSTRAINT availability_workbench_projection_period_check CHECK (effective_until IS NULL OR effective_until > effective_from)
);

CREATE TABLE rms_catalog.availability_workbench_projection_checkpoint (
  brand_id platform_helpers.uuid_v7 PRIMARY KEY,
  active_generation_id platform_helpers.uuid_v7 NOT NULL,
  projection_version integer NOT NULL CHECK (projection_version > 0),
  source_event_sequence bigint NOT NULL CHECK (source_event_sequence >= 0),
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT availability_workbench_checkpoint_generation_fk FOREIGN KEY (active_generation_id, brand_id)
    REFERENCES rms_catalog.availability_workbench_projection_generation (generation_id, brand_id)
);

CREATE RULE availability_workbench_generation_no_update AS ON UPDATE TO rms_catalog.availability_workbench_projection_generation DO INSTEAD NOTHING;
CREATE RULE availability_workbench_generation_no_delete AS ON DELETE TO rms_catalog.availability_workbench_projection_generation DO INSTEAD NOTHING;

ALTER TABLE rms_catalog.availability_workbench_projection_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.availability_workbench_projection_generation FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.availability_workbench_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.availability_workbench_projection FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.availability_workbench_projection_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.availability_workbench_projection_checkpoint FORCE ROW LEVEL SECURITY;

CREATE POLICY availability_workbench_generation_brand_scope_policy ON rms_catalog.availability_workbench_projection_generation
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY availability_workbench_projection_brand_scope_policy ON rms_catalog.availability_workbench_projection
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
CREATE POLICY availability_workbench_checkpoint_brand_scope_policy ON rms_catalog.availability_workbench_projection_checkpoint
  USING (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);

REVOKE ALL ON TABLE rms_catalog.availability_workbench_projection_generation,
  rms_catalog.availability_workbench_projection,
  rms_catalog.availability_workbench_projection_checkpoint FROM PUBLIC;
