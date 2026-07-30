-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA rms_catalog;
REVOKE ALL ON SCHEMA rms_catalog FROM PUBLIC;

CREATE TABLE rms_catalog.product (
  product_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  internal_code text NOT NULL CHECK (internal_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  product_type text NOT NULL CHECK (product_type IN ('PreparedFood', 'NonAlcoholicBeverage')),
  lifecycle text NOT NULL CHECK (
    lifecycle IN ('Draft', 'Active', 'Suspended', 'Discontinued', 'Archived')
  ),
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT product_brand_code_unique UNIQUE (brand_id, internal_code),
  CONSTRAINT product_brand_identity_unique UNIQUE (product_id, brand_id),
  CONSTRAINT product_time_order_check CHECK (updated_at >= created_at)
);

CREATE TABLE rms_catalog.product_version (
  product_version_id platform_helpers.uuid_v7 PRIMARY KEY,
  product_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  base_product_version_id platform_helpers.uuid_v7,
  status text NOT NULL CHECK (status = 'Draft'),
  default_locale text NOT NULL CHECK (char_length(default_locale) BETWEEN 2 AND 35),
  localized_names_json jsonb NOT NULL CHECK (jsonb_typeof(localized_names_json) = 'object'),
  tax_classification_id platform_helpers.uuid_v7,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT product_version_product_fk
    FOREIGN KEY (product_id, brand_id)
    REFERENCES rms_catalog.product (product_id, brand_id),
  CONSTRAINT product_version_base_fk
    FOREIGN KEY (base_product_version_id)
    REFERENCES rms_catalog.product_version (product_version_id),
  CONSTRAINT product_version_product_identity_unique UNIQUE (product_version_id, product_id, brand_id),
  CONSTRAINT product_version_one_draft_unique UNIQUE (product_id, status),
  CONSTRAINT product_version_time_order_check CHECK (updated_at >= created_at)
);

CREATE TABLE rms_catalog.sku (
  sku_id platform_helpers.uuid_v7 PRIMARY KEY,
  product_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  product_version_id platform_helpers.uuid_v7 NOT NULL,
  sku_code text NOT NULL CHECK (sku_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  lifecycle text NOT NULL CHECK (
    lifecycle IN ('Draft', 'Active', 'Suspended', 'Discontinued', 'Archived')
  ),
  localized_names_json jsonb NOT NULL CHECK (jsonb_typeof(localized_names_json) = 'object'),
  variant_selections_json jsonb NOT NULL CHECK (jsonb_typeof(variant_selections_json) = 'array'),
  variant_digest text NOT NULL CHECK (variant_digest ~ '^sha256:[0-9a-f]{64}$'),
  unit_of_sale text NOT NULL CHECK (unit_of_sale ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  unit_quantity numeric(20,6) NOT NULL CHECK (unit_quantity > 0),
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  CONSTRAINT sku_product_fk
    FOREIGN KEY (product_id, brand_id)
    REFERENCES rms_catalog.product (product_id, brand_id),
  CONSTRAINT sku_version_fk
    FOREIGN KEY (product_version_id, product_id, brand_id)
    REFERENCES rms_catalog.product_version (product_version_id, product_id, brand_id),
  CONSTRAINT sku_brand_code_unique UNIQUE (brand_id, sku_code),
  CONSTRAINT sku_product_variant_unique UNIQUE (product_id, variant_digest),
  CONSTRAINT sku_product_identity_unique UNIQUE (sku_id, product_id, brand_id)
);

CREATE TABLE rms_catalog.product_operation_record (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  product_id platform_helpers.uuid_v7 NOT NULL,
  action_code text NOT NULL CHECK (
    action_code IN ('Create', 'ReplaceDraft', 'ChangeLifecycle')
  ),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  result_aggregate_version integer NOT NULL CHECK (result_aggregate_version > 0),
  occurred_at timestamp with time zone NOT NULL,
  CONSTRAINT product_operation_product_fk
    FOREIGN KEY (product_id, brand_id)
    REFERENCES rms_catalog.product (product_id, brand_id)
);

CREATE RULE product_operation_no_update AS
  ON UPDATE TO rms_catalog.product_operation_record DO INSTEAD NOTHING;
CREATE RULE product_operation_no_delete AS
  ON DELETE TO rms_catalog.product_operation_record DO INSTEAD NOTHING;
CREATE RULE product_identity_no_update AS
  ON UPDATE TO rms_catalog.product
  WHERE (
    OLD.product_id IS DISTINCT FROM NEW.product_id
    OR OLD.brand_id IS DISTINCT FROM NEW.brand_id
    OR OLD.internal_code IS DISTINCT FROM NEW.internal_code
    OR OLD.product_type IS DISTINCT FROM NEW.product_type
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.created_by_actor_id IS DISTINCT FROM NEW.created_by_actor_id
  )
  DO INSTEAD NOTHING;
CREATE RULE sku_identity_no_update AS
  ON UPDATE TO rms_catalog.sku
  WHERE (
    OLD.sku_id IS DISTINCT FROM NEW.sku_id
    OR OLD.product_id IS DISTINCT FROM NEW.product_id
    OR OLD.brand_id IS DISTINCT FROM NEW.brand_id
    OR OLD.product_version_id IS DISTINCT FROM NEW.product_version_id
    OR OLD.sku_code IS DISTINCT FROM NEW.sku_code
    OR OLD.unit_of_sale IS DISTINCT FROM NEW.unit_of_sale
    OR OLD.unit_quantity IS DISTINCT FROM NEW.unit_quantity
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.created_by_actor_id IS DISTINCT FROM NEW.created_by_actor_id
  )
  DO INSTEAD NOTHING;

CREATE INDEX product_brand_lifecycle_idx
  ON rms_catalog.product (brand_id, lifecycle, updated_at DESC);
CREATE INDEX sku_product_lifecycle_idx
  ON rms_catalog.sku (brand_id, product_id, lifecycle);

ALTER TABLE rms_catalog.product ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_version FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.sku ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.sku FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_operation_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_operation_record FORCE ROW LEVEL SECURITY;

CREATE POLICY product_brand_scope_policy ON rms_catalog.product
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND platform_helpers.current_store_id() IS NULL
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND platform_helpers.current_store_id() IS NULL
  );
CREATE POLICY product_version_brand_scope_policy ON rms_catalog.product_version
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND platform_helpers.current_store_id() IS NULL
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND platform_helpers.current_store_id() IS NULL
  );
CREATE POLICY sku_brand_scope_policy ON rms_catalog.sku
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND platform_helpers.current_store_id() IS NULL
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND platform_helpers.current_store_id() IS NULL
  );
CREATE POLICY product_operation_brand_scope_policy ON rms_catalog.product_operation_record
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND platform_helpers.current_store_id() IS NULL
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND platform_helpers.current_store_id() IS NULL
  );

REVOKE ALL ON TABLE rms_catalog.product FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.product_version FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.sku FROM PUBLIC;
REVOKE ALL ON TABLE rms_catalog.product_operation_record FROM PUBLIC;
