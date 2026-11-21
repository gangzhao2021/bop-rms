-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_ordering.checkout_session_allocation (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  create_operation_id platform_helpers.uuid_v7 NOT NULL,
  guest_session_id platform_helpers.uuid_v7 NOT NULL,
  cart_id platform_helpers.uuid_v7 NOT NULL,
  cart_version integer NOT NULL CHECK (cart_version > 0),
  quote_id platform_helpers.uuid_v7 NOT NULL,
  quote_version integer NOT NULL CHECK (quote_version IN (1,2)),
  checkout_session_id platform_helpers.uuid_v7 NOT NULL,
  submission_id platform_helpers.uuid_v7 NOT NULL,
  payment_operation_id platform_helpers.uuid_v7 NOT NULL,
  allocated_at timestamptz NOT NULL,
  PRIMARY KEY (brand_id,store_id,create_operation_id),
  UNIQUE (brand_id,store_id,checkout_session_id),
  UNIQUE (brand_id,store_id,submission_id),
  UNIQUE (brand_id,store_id,payment_operation_id),
  FOREIGN KEY (cart_id,brand_id,store_id)
    REFERENCES rms_ordering.cart(cart_id,brand_id,store_id),
  CHECK (checkout_session_id <> create_operation_id AND checkout_session_id <> submission_id
    AND checkout_session_id <> payment_operation_id AND create_operation_id <> submission_id
    AND create_operation_id <> payment_operation_id AND submission_id <> payment_operation_id),
  CHECK (isfinite(allocated_at) AND allocated_at=date_trunc('milliseconds',allocated_at))
);
CREATE RULE checkout_session_allocation_no_update AS ON UPDATE TO rms_ordering.checkout_session_allocation DO INSTEAD NOTHING;
CREATE RULE checkout_session_allocation_no_delete AS ON DELETE TO rms_ordering.checkout_session_allocation DO INSTEAD NOTHING;
ALTER TABLE rms_ordering.checkout_session_allocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.checkout_session_allocation FORCE ROW LEVEL SECURITY;
CREATE POLICY checkout_session_allocation_scope ON rms_ordering.checkout_session_allocation
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.checkout_session_allocation FROM PUBLIC;
