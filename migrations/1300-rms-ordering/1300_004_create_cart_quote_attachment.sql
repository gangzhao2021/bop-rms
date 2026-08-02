-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_ordering.cart_quote_attachment (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  cart_id platform_helpers.uuid_v7 NOT NULL,
  cart_version integer NOT NULL CHECK (cart_version > 0),
  guest_session_id platform_helpers.uuid_v7 NOT NULL,
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  quote_id platform_helpers.uuid_v7 NOT NULL,
  quote_version integer NOT NULL CHECK (quote_version = 1),
  quote_input_digest text NOT NULL CHECK (quote_input_digest ~ '^sha256:[0-9a-f]{64}$'),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  currency_metadata_version integer NOT NULL CHECK (currency_metadata_version > 0),
  currency_metadata_version_id platform_helpers.uuid_v7 NOT NULL,
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor bigint NOT NULL CHECK (discount_minor >= 0),
  tax_minor bigint NOT NULL CHECK (tax_minor >= 0),
  fee_minor bigint NOT NULL CHECK (fee_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  line_count integer NOT NULL CHECK (line_count BETWEEN 1 AND 100),
  warnings_json jsonb NOT NULL CHECK (
    jsonb_typeof(warnings_json) = 'array'
    AND jsonb_array_length(warnings_json) <= 100
  ),
  quote_created_at timestamp with time zone NOT NULL,
  quote_expires_at timestamp with time zone NOT NULL,
  attached_at timestamp with time zone NOT NULL,
  idempotency_expires_at timestamp with time zone NOT NULL,
  CONSTRAINT cart_quote_attachment_cart_fk
    FOREIGN KEY (cart_id, brand_id, store_id)
    REFERENCES rms_ordering.cart (cart_id, brand_id, store_id),
  CONSTRAINT cart_quote_attachment_quote_unique UNIQUE (quote_id),
  CONSTRAINT cart_quote_attachment_scope_identity_unique
    UNIQUE (operation_id, brand_id, store_id, cart_id),
  CONSTRAINT cart_quote_attachment_total_check
    CHECK (total_minor = subtotal_minor - discount_minor + tax_minor + fee_minor),
  CONSTRAINT cart_quote_attachment_time_check CHECK (
    quote_expires_at > quote_created_at
    AND attached_at >= quote_created_at
    AND attached_at < quote_expires_at
  ),
  CONSTRAINT cart_quote_attachment_retention_check
    CHECK (idempotency_expires_at = attached_at + interval '24 hours')
);

CREATE TABLE rms_ordering.cart_quote_attachment_line (
  operation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  cart_id platform_helpers.uuid_v7 NOT NULL,
  cart_line_id platform_helpers.uuid_v7 NOT NULL,
  sellable_id platform_helpers.uuid_v7 NOT NULL,
  product_version_id platform_helpers.uuid_v7 NOT NULL,
  menu_version_id platform_helpers.uuid_v7 NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  PRIMARY KEY (operation_id, cart_line_id),
  CONSTRAINT cart_quote_attachment_line_parent_fk
    FOREIGN KEY (operation_id, brand_id, store_id, cart_id)
    REFERENCES rms_ordering.cart_quote_attachment (operation_id, brand_id, store_id, cart_id)
);

CREATE RULE cart_quote_attachment_no_update AS
  ON UPDATE TO rms_ordering.cart_quote_attachment DO INSTEAD NOTHING;
CREATE RULE cart_quote_attachment_no_delete AS
  ON DELETE TO rms_ordering.cart_quote_attachment DO INSTEAD NOTHING;
CREATE RULE cart_quote_attachment_line_no_update AS
  ON UPDATE TO rms_ordering.cart_quote_attachment_line DO INSTEAD NOTHING;
CREATE RULE cart_quote_attachment_line_no_delete AS
  ON DELETE TO rms_ordering.cart_quote_attachment_line DO INSTEAD NOTHING;

CREATE INDEX cart_quote_attachment_current_idx
  ON rms_ordering.cart_quote_attachment
  (brand_id, store_id, cart_id, cart_version, attached_at DESC);
CREATE INDEX cart_quote_attachment_expiry_idx
  ON rms_ordering.cart_quote_attachment (brand_id, store_id, quote_expires_at);

ALTER TABLE rms_ordering.cart_quote_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.cart_quote_attachment FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.cart_quote_attachment_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.cart_quote_attachment_line FORCE ROW LEVEL SECURITY;

CREATE POLICY cart_quote_attachment_store_scope_policy
  ON rms_ordering.cart_quote_attachment
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );

CREATE POLICY cart_quote_attachment_line_store_scope_policy
  ON rms_ordering.cart_quote_attachment_line
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );

REVOKE ALL ON TABLE rms_ordering.cart_quote_attachment FROM PUBLIC;
REVOKE ALL ON TABLE rms_ordering.cart_quote_attachment_line FROM PUBLIC;
