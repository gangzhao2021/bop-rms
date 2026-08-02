-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_pricing.price_quote (
  price_quote_id platform_helpers.uuid_v7 PRIMARY KEY,
  quote_version integer NOT NULL CHECK (quote_version = 1),
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  cart_id platform_helpers.uuid_v7 NOT NULL,
  cart_version integer NOT NULL CHECK (cart_version > 0),
  input_digest text NOT NULL CHECK (input_digest ~ '^sha256:[0-9a-f]{64}$'),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  currency_metadata_version integer NOT NULL CHECK (currency_metadata_version > 0),
  currency_metadata_version_id platform_helpers.uuid_v7 NOT NULL,
  currency_metadata_digest text NOT NULL CHECK (currency_metadata_digest ~ '^sha256:[0-9a-f]{64}$'),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor bigint NOT NULL CHECK (discount_minor >= 0),
  tax_minor bigint NOT NULL CHECK (tax_minor >= 0),
  fee_minor bigint NOT NULL CHECK (fee_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  applied_promotion_references_json jsonb NOT NULL CHECK (jsonb_typeof(applied_promotion_references_json) = 'array'),
  warnings_json jsonb NOT NULL CHECK (jsonb_typeof(warnings_json) = 'array'),
  blocking_reasons_json jsonb NOT NULL CHECK (jsonb_typeof(blocking_reasons_json) = 'array'),
  created_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  CONSTRAINT price_quote_scope_identity_unique UNIQUE (price_quote_id, brand_id, store_id),
  CONSTRAINT price_quote_total_check CHECK (total_minor = subtotal_minor - discount_minor + tax_minor + fee_minor),
  CONSTRAINT price_quote_expiry_check CHECK (expires_at > created_at)
);

CREATE TABLE rms_pricing.price_quote_line (
  price_quote_line_id platform_helpers.uuid_v7 PRIMARY KEY,
  price_quote_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  sellable_id platform_helpers.uuid_v7 NOT NULL,
  product_version_id platform_helpers.uuid_v7 NOT NULL,
  menu_version_id platform_helpers.uuid_v7 NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor bigint NOT NULL CHECK (discount_minor >= 0),
  tax_minor bigint NOT NULL CHECK (tax_minor >= 0),
  fee_minor bigint NOT NULL CHECK (fee_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  price_book_id platform_helpers.uuid_v7 NOT NULL,
  price_book_version_id platform_helpers.uuid_v7 NOT NULL,
  price_book_snapshot_digest text NOT NULL CHECK (price_book_snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  price_entry_id platform_helpers.uuid_v7 NOT NULL,
  tax_configuration_id platform_helpers.uuid_v7 NOT NULL,
  tax_configuration_version_id platform_helpers.uuid_v7 NOT NULL,
  tax_configuration_snapshot_digest text NOT NULL CHECK (tax_configuration_snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT price_quote_line_quote_fk FOREIGN KEY (price_quote_id, brand_id, store_id)
    REFERENCES rms_pricing.price_quote (price_quote_id, brand_id, store_id),
  CONSTRAINT price_quote_line_total_check CHECK (total_minor = subtotal_minor - discount_minor + tax_minor + fee_minor),
  CONSTRAINT price_quote_line_subtotal_check CHECK (subtotal_minor = unit_price_minor * quantity),
  CONSTRAINT price_quote_line_quote_unique UNIQUE (price_quote_id, price_quote_line_id, brand_id, store_id)
);

CREATE TABLE rms_pricing.price_quote_tax_line (
  price_quote_tax_line_id platform_helpers.uuid_v7 PRIMARY KEY,
  price_quote_id platform_helpers.uuid_v7 NOT NULL,
  price_quote_line_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  rule_version_id platform_helpers.uuid_v7 NOT NULL,
  tax_component_code text NOT NULL CHECK (tax_component_code ~ '^[A-Z][A-Z0-9_-]{0,63}$'),
  tax_classification_id platform_helpers.uuid_v7 NOT NULL,
  treatment text NOT NULL CHECK (treatment IN ('Taxable', 'Exempt', 'ZeroRated')),
  rate_decimal text NOT NULL CHECK (rate_decimal ~ '^(0|[1-9][0-9]{0,5})(\.[0-9]{0,11}[1-9])?$'),
  price_inclusion text NOT NULL CHECK (price_inclusion = 'Exclusive'),
  rounding_mode text NOT NULL CHECK (rounding_mode IN ('HalfUp', 'HalfEven', 'TowardZero', 'AwayFromZero')),
  calculation_order integer NOT NULL CHECK (calculation_order BETWEEN 1 AND 16),
  compound_on_prior_tax boolean NOT NULL,
  tax_minor bigint NOT NULL CHECK (tax_minor >= 0),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT price_quote_tax_line_line_fk
    FOREIGN KEY (price_quote_id, price_quote_line_id, brand_id, store_id)
    REFERENCES rms_pricing.price_quote_line (price_quote_id, price_quote_line_id, brand_id, store_id),
  CONSTRAINT price_quote_tax_component_unique UNIQUE (price_quote_line_id, calculation_order, tax_component_code)
);

CREATE RULE price_quote_no_update AS ON UPDATE TO rms_pricing.price_quote DO INSTEAD NOTHING;
CREATE RULE price_quote_no_delete AS ON DELETE TO rms_pricing.price_quote DO INSTEAD NOTHING;
CREATE RULE price_quote_line_no_update AS ON UPDATE TO rms_pricing.price_quote_line DO INSTEAD NOTHING;
CREATE RULE price_quote_line_no_delete AS ON DELETE TO rms_pricing.price_quote_line DO INSTEAD NOTHING;
CREATE RULE price_quote_tax_line_no_update AS ON UPDATE TO rms_pricing.price_quote_tax_line DO INSTEAD NOTHING;
CREATE RULE price_quote_tax_line_no_delete AS ON DELETE TO rms_pricing.price_quote_tax_line DO INSTEAD NOTHING;

CREATE INDEX price_quote_cart_idx ON rms_pricing.price_quote (brand_id, store_id, cart_id, cart_version, created_at);

ALTER TABLE rms_pricing.price_quote ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.price_quote FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.price_quote_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.price_quote_line FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.price_quote_tax_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.price_quote_tax_line FORCE ROW LEVEL SECURITY;

CREATE POLICY price_quote_store_scope_policy ON rms_pricing.price_quote
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY price_quote_line_store_scope_policy ON rms_pricing.price_quote_line
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY price_quote_tax_line_store_scope_policy ON rms_pricing.price_quote_tax_line
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());

REVOKE ALL ON TABLE rms_pricing.price_quote FROM PUBLIC;
REVOKE ALL ON TABLE rms_pricing.price_quote_line FROM PUBLIC;
REVOKE ALL ON TABLE rms_pricing.price_quote_tax_line FROM PUBLIC;
