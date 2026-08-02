-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE rms_ordering.cart_line
  ADD COLUMN customer_note text
  CHECK (
    customer_note IS NULL
    OR (
      char_length(customer_note) BETWEEN 1 AND 500
      AND customer_note = btrim(customer_note)
    )
  );

CREATE TABLE rms_ordering.cart_operation_record (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  cart_id platform_helpers.uuid_v7 NOT NULL,
  cart_line_id platform_helpers.uuid_v7 NOT NULL,
  guest_session_id platform_helpers.uuid_v7 NOT NULL,
  action_code text NOT NULL CHECK (action_code IN ('Add', 'Update', 'Remove')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  result_aggregate_version integer NOT NULL CHECK (result_aggregate_version > 0),
  result_cart_snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(result_cart_snapshot_json) = 'object'),
  occurred_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  CONSTRAINT cart_operation_cart_fk
    FOREIGN KEY (cart_id, brand_id, store_id)
    REFERENCES rms_ordering.cart (cart_id, brand_id, store_id),
  CONSTRAINT cart_operation_retention_check
    CHECK (expires_at = occurred_at + interval '24 hours')
);

CREATE RULE cart_operation_no_update AS
  ON UPDATE TO rms_ordering.cart_operation_record DO INSTEAD NOTHING;
CREATE RULE cart_operation_no_delete AS
  ON DELETE TO rms_ordering.cart_operation_record DO INSTEAD NOTHING;

CREATE INDEX cart_operation_expiry_idx
  ON rms_ordering.cart_operation_record (brand_id, store_id, expires_at);

ALTER TABLE rms_ordering.cart_operation_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.cart_operation_record FORCE ROW LEVEL SECURITY;

CREATE POLICY cart_operation_store_scope_policy ON rms_ordering.cart_operation_record
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );

REVOKE ALL ON TABLE rms_ordering.cart_operation_record FROM PUBLIC;
