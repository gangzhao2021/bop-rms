-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_pricing.price_quote_request (
  operation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  guest_session_id platform_helpers.uuid_v7 NOT NULL,
  cart_id platform_helpers.uuid_v7 NOT NULL,
  cart_version integer NOT NULL CHECK (cart_version > 0),
  record_version integer NOT NULL CHECK (record_version = 1),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  quote_id platform_helpers.uuid_v7 NOT NULL,
  quote_outcome text NOT NULL CHECK (quote_outcome IN ('Created','Existing')),
  created_at timestamp with time zone NOT NULL,
  idempotency_expires_at timestamp with time zone NOT NULL,
  PRIMARY KEY (brand_id,store_id,operation_id),
  CONSTRAINT price_quote_request_quote_fk FOREIGN KEY (quote_id,brand_id,store_id)
    REFERENCES rms_pricing.price_quote (price_quote_id,brand_id,store_id),
  CONSTRAINT price_quote_request_time_check CHECK (
    created_at = date_trunc('milliseconds',created_at)
    AND idempotency_expires_at = created_at + interval '24 hours'
  )
);
CREATE RULE price_quote_request_no_update AS ON UPDATE TO rms_pricing.price_quote_request DO INSTEAD NOTHING;
CREATE RULE price_quote_request_no_delete AS ON DELETE TO rms_pricing.price_quote_request DO INSTEAD NOTHING;
ALTER TABLE rms_pricing.price_quote_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.price_quote_request FORCE ROW LEVEL SECURITY;
CREATE POLICY price_quote_request_store_scope_policy ON rms_pricing.price_quote_request
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_pricing.price_quote_request FROM PUBLIC;
