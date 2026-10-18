-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_pricing.option_price_rule (
  option_price_rule_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  binding_id platform_helpers.uuid_v7 NOT NULL,
  option_id platform_helpers.uuid_v7 NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  current_version_id platform_helpers.uuid_v7,
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT option_price_rule_scope_identity_unique
    UNIQUE (option_price_rule_id, brand_id, binding_id, option_id),
  CONSTRAINT option_price_rule_time_check CHECK (updated_at >= created_at)
);
CREATE TABLE rms_pricing.option_price_rule_version (
  option_price_rule_version_id platform_helpers.uuid_v7 PRIMARY KEY,
  option_price_rule_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  binding_id platform_helpers.uuid_v7 NOT NULL,
  option_id platform_helpers.uuid_v7 NOT NULL,
  version_number bigint NOT NULL CHECK (version_number > 0),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft', 'Published', 'Archived')),
  sku_id platform_helpers.uuid_v7,
  scope_kind text NOT NULL CHECK (scope_kind IN ('Brand', 'Region', 'StoreGroup', 'Store')),
  scope_id platform_helpers.uuid_v7,
  channel_code text CHECK (channel_code IS NULL OR channel_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  order_type text CHECK (order_type IS NULL OR order_type IN ('DineIn', 'Pickup')),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  currency_minor_unit_exponent smallint NOT NULL CHECK (currency_minor_unit_exponent BETWEEN 0 AND 6),
  currency_metadata_version integer NOT NULL CHECK (currency_metadata_version > 0),
  currency_metadata_version_id platform_helpers.uuid_v7 NOT NULL,
  currency_metadata_digest text NOT NULL CHECK (currency_metadata_digest ~ '^sha256:[0-9a-f]{64}$'),
  unit_amount_minor bigint NOT NULL CHECK (unit_amount_minor >= 0),
  included_quantity integer NOT NULL CHECK (included_quantity >= 0),
  quantity_basis text NOT NULL CHECK (quantity_basis = 'PerItemChoice'),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  effective_time_zone text NOT NULL CHECK (length(effective_time_zone) BETWEEN 1 AND 100),
  created_at timestamp with time zone NOT NULL,
  CONSTRAINT option_price_rule_version_root_fk
    FOREIGN KEY (option_price_rule_id, brand_id, binding_id, option_id)
    REFERENCES rms_pricing.option_price_rule (option_price_rule_id, brand_id, binding_id, option_id),
  CONSTRAINT option_price_rule_version_identity_unique
    UNIQUE (option_price_rule_version_id, option_price_rule_id, brand_id, binding_id, option_id),
  CONSTRAINT option_price_rule_version_number_unique UNIQUE (option_price_rule_id, version_number),
  CONSTRAINT option_price_rule_version_scope_check CHECK (
    (scope_kind = 'Brand' AND scope_id IS NULL) OR (scope_kind <> 'Brand' AND scope_id IS NOT NULL)
  ),
  CONSTRAINT option_price_rule_version_period_check CHECK (
    effective_until IS NULL OR effective_until > effective_from
  )
);
ALTER TABLE rms_pricing.option_price_rule ADD CONSTRAINT option_price_rule_current_version_fk
  FOREIGN KEY (current_version_id, option_price_rule_id, brand_id, binding_id, option_id)
  REFERENCES rms_pricing.option_price_rule_version
    (option_price_rule_version_id, option_price_rule_id, brand_id, binding_id, option_id);
CREATE INDEX option_price_rule_binding_idx
  ON rms_pricing.option_price_rule (brand_id, binding_id, option_id);
CREATE FUNCTION rms_pricing.reject_option_price_version_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'append-only Option price version' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.reject_option_price_version_mutation() FROM PUBLIC;
CREATE TRIGGER option_price_version_no_mutation
  BEFORE UPDATE OR DELETE ON rms_pricing.option_price_rule_version
  FOR EACH ROW EXECUTE FUNCTION rms_pricing.reject_option_price_version_mutation();
CREATE TRIGGER option_price_version_no_truncate
  BEFORE TRUNCATE ON rms_pricing.option_price_rule_version
  FOR EACH STATEMENT EXECUTE FUNCTION rms_pricing.reject_option_price_version_mutation();
ALTER TABLE rms_pricing.option_price_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.option_price_rule FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.option_price_rule_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.option_price_rule_version FORCE ROW LEVEL SECURITY;
CREATE POLICY option_price_rule_brand_scope ON rms_pricing.option_price_rule
  USING (brand_id = platform_helpers.current_brand_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id());
CREATE POLICY option_price_rule_version_brand_scope ON rms_pricing.option_price_rule_version
  USING (brand_id = platform_helpers.current_brand_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_pricing.option_price_rule FROM PUBLIC;
REVOKE ALL ON TABLE rms_pricing.option_price_rule_version FROM PUBLIC;
