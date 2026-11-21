-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_ordering.cart_quote_expiry_record (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  cart_id platform_helpers.uuid_v7 NOT NULL,
  guest_session_id platform_helpers.uuid_v7 NOT NULL,
  quote_id platform_helpers.uuid_v7 NOT NULL,
  resolution_version integer NOT NULL CHECK (resolution_version = 1),
  cart_version integer NOT NULL CHECK (cart_version > 0),
  quote_input_digest text NOT NULL CHECK (quote_input_digest ~ '^sha256:[0-9a-f]{64}$'),
  request_intent_digest text NOT NULL CHECK (request_intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  quote_created_at timestamptz NOT NULL,
  quote_expires_at timestamptz NOT NULL,
  request_created_at timestamptz NOT NULL,
  request_expires_at timestamptz NOT NULL,
  expired_at timestamptz NOT NULL,
  PRIMARY KEY (brand_id, store_id, operation_id),
  FOREIGN KEY (cart_id, brand_id, store_id) REFERENCES rms_ordering.cart (cart_id, brand_id, store_id),
  CHECK (quote_created_at <= request_created_at AND request_created_at < quote_expires_at AND quote_expires_at <= expired_at),
  CHECK (request_expires_at = request_created_at + interval '24 hours'),
  CHECK (isfinite(quote_created_at) AND quote_created_at = date_trunc('milliseconds',quote_created_at)),
  CHECK (isfinite(quote_expires_at) AND quote_expires_at = date_trunc('milliseconds',quote_expires_at)),
  CHECK (isfinite(request_created_at) AND request_created_at = date_trunc('milliseconds',request_created_at)),
  CHECK (isfinite(request_expires_at) AND request_expires_at = date_trunc('milliseconds',request_expires_at)),
  CHECK (isfinite(expired_at) AND expired_at = date_trunc('milliseconds',expired_at))
);
CREATE RULE cart_quote_expiry_no_update AS ON UPDATE TO rms_ordering.cart_quote_expiry_record DO INSTEAD NOTHING;
CREATE RULE cart_quote_expiry_no_delete AS ON DELETE TO rms_ordering.cart_quote_expiry_record DO INSTEAD NOTHING;
ALTER TABLE rms_ordering.cart_quote_expiry_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.cart_quote_expiry_record FORCE ROW LEVEL SECURITY;
CREATE POLICY cart_quote_expiry_scope ON rms_ordering.cart_quote_expiry_record
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.cart_quote_expiry_record FROM PUBLIC;
