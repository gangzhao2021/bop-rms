-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE rms_pricing.tax_configuration_operation_record
  ADD COLUMN outbox_event_id platform_helpers.uuid_v7,
  ADD CONSTRAINT tax_configuration_operation_outbox_unique UNIQUE (outbox_event_id);

CREATE TABLE rms_pricing.tax_config_admin_projection_generation (
  generation_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  projection_version integer NOT NULL CHECK (projection_version > 0),
  source_event_sequence bigint NOT NULL CHECK (source_event_sequence >= 0),
  built_at timestamp with time zone NOT NULL,
  CONSTRAINT tax_config_admin_generation_scope_unique UNIQUE (generation_id, brand_id, store_id)
);

CREATE TABLE rms_pricing.tax_config_admin_projection (
  generation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  tax_configuration_id platform_helpers.uuid_v7 NOT NULL,
  tax_configuration_version_id platform_helpers.uuid_v7 NOT NULL,
  stable_code text NOT NULL CHECK (stable_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft', 'Published')),
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  jurisdiction_code text NOT NULL CHECK (jurisdiction_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  registration_status text NOT NULL CHECK (registration_status IN ('Missing', 'Verified')),
  fixture_status text NOT NULL CHECK (fixture_status IN ('Missing', 'Approved', 'Failed')),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  projected_at timestamp with time zone NOT NULL,
  PRIMARY KEY (generation_id, tax_configuration_id),
  CONSTRAINT tax_config_admin_projection_generation_fk FOREIGN KEY (generation_id, brand_id, store_id)
    REFERENCES rms_pricing.tax_config_admin_projection_generation (generation_id, brand_id, store_id),
  CONSTRAINT tax_config_admin_projection_period_check CHECK (effective_until IS NULL OR effective_until > effective_from)
);

CREATE TABLE rms_pricing.tax_config_rule_projection (
  generation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  tax_configuration_id platform_helpers.uuid_v7 NOT NULL,
  tax_configuration_rule_id platform_helpers.uuid_v7 NOT NULL,
  tax_classification_id platform_helpers.uuid_v7 NOT NULL,
  category_code text NOT NULL CHECK (category_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  treatment text NOT NULL CHECK (treatment IN ('Taxable', 'Exempt', 'ZeroRated')),
  tax_rate numeric(18,12) NOT NULL CHECK (tax_rate >= 0),
  price_inclusion text NOT NULL CHECK (price_inclusion IN ('Exclusive', 'Inclusive')),
  receipt_presentation_code text NOT NULL CHECK (receipt_presentation_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  PRIMARY KEY (generation_id, tax_configuration_rule_id),
  CONSTRAINT tax_config_rule_projection_generation_fk FOREIGN KEY (generation_id, brand_id, store_id)
    REFERENCES rms_pricing.tax_config_admin_projection_generation (generation_id, brand_id, store_id)
);

CREATE TABLE rms_pricing.tax_config_receipt_fixture_projection (
  generation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  tax_configuration_id platform_helpers.uuid_v7 NOT NULL,
  fixture_reference_id platform_helpers.uuid_v7 NOT NULL,
  fixture_kind text NOT NULL CHECK (fixture_kind IN ('Basket', 'Refund')),
  fixture_suite_digest text NOT NULL CHECK (fixture_suite_digest ~ '^sha256:[0-9a-f]{64}$'),
  net_amount_minor numeric NOT NULL,
  tax_amount_minor numeric NOT NULL,
  gross_amount_minor numeric NOT NULL,
  receipt_preview_digest text NOT NULL CHECK (receipt_preview_digest ~ '^sha256:[0-9a-f]{64}$'),
  PRIMARY KEY (generation_id, fixture_reference_id),
  CONSTRAINT tax_config_fixture_projection_generation_fk FOREIGN KEY (generation_id, brand_id, store_id)
    REFERENCES rms_pricing.tax_config_admin_projection_generation (generation_id, brand_id, store_id),
  CONSTRAINT tax_config_fixture_projection_minor_units CHECK (
    net_amount_minor = trunc(net_amount_minor)
    AND tax_amount_minor = trunc(tax_amount_minor)
    AND gross_amount_minor = trunc(gross_amount_minor)
    AND net_amount_minor > -1e30 AND net_amount_minor < 1e30
    AND tax_amount_minor > -1e30 AND tax_amount_minor < 1e30
    AND gross_amount_minor > -1e30 AND gross_amount_minor < 1e30
  )
);

CREATE TABLE rms_pricing.tax_config_admin_projection_checkpoint (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  active_generation_id platform_helpers.uuid_v7 NOT NULL,
  projection_version integer NOT NULL CHECK (projection_version > 0),
  source_event_sequence bigint NOT NULL CHECK (source_event_sequence >= 0),
  updated_at timestamp with time zone NOT NULL,
  PRIMARY KEY (brand_id, store_id),
  CONSTRAINT tax_config_admin_checkpoint_generation_fk FOREIGN KEY (active_generation_id, brand_id, store_id)
    REFERENCES rms_pricing.tax_config_admin_projection_generation (generation_id, brand_id, store_id)
);

CREATE RULE tax_config_admin_generation_no_update AS ON UPDATE TO rms_pricing.tax_config_admin_projection_generation DO INSTEAD NOTHING;
CREATE RULE tax_config_admin_generation_no_delete AS ON DELETE TO rms_pricing.tax_config_admin_projection_generation DO INSTEAD NOTHING;

ALTER TABLE rms_pricing.tax_config_admin_projection_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_config_admin_projection_generation FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_config_admin_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_config_admin_projection FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_config_rule_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_config_rule_projection FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_config_receipt_fixture_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_config_receipt_fixture_projection FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_config_admin_projection_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_config_admin_projection_checkpoint FORCE ROW LEVEL SECURITY;

CREATE POLICY tax_config_admin_generation_store_scope_policy ON rms_pricing.tax_config_admin_projection_generation USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id()) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY tax_config_admin_projection_store_scope_policy ON rms_pricing.tax_config_admin_projection USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id()) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY tax_config_rule_projection_store_scope_policy ON rms_pricing.tax_config_rule_projection USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id()) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY tax_config_fixture_projection_store_scope_policy ON rms_pricing.tax_config_receipt_fixture_projection USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id()) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY tax_config_admin_checkpoint_store_scope_policy ON rms_pricing.tax_config_admin_projection_checkpoint USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id()) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());

REVOKE ALL ON TABLE rms_pricing.tax_config_admin_projection_generation,
  rms_pricing.tax_config_admin_projection,
  rms_pricing.tax_config_rule_projection,
  rms_pricing.tax_config_receipt_fixture_projection,
  rms_pricing.tax_config_admin_projection_checkpoint FROM PUBLIC;
