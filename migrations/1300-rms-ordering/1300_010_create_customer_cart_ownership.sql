-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_ordering.cart_customer_owner (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_type text NOT NULL CHECK (order_type IN ('Pickup', 'DineIn')),
  owner_id platform_helpers.uuid_v7 NOT NULL,
  cart_id platform_helpers.uuid_v7 NOT NULL,
  created_at timestamp with time zone NOT NULL,
  PRIMARY KEY (brand_id, store_id, order_type, owner_id),
  UNIQUE (cart_id, brand_id, store_id),
  UNIQUE (brand_id, store_id, order_type, owner_id, cart_id),
  FOREIGN KEY (cart_id, brand_id, store_id)
    REFERENCES rms_ordering.cart (cart_id, brand_id, store_id)
);

CREATE TABLE rms_ordering.cart_creation_operation (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  operation_intent_hash text NOT NULL CHECK (operation_intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  guest_session_id platform_helpers.uuid_v7 NOT NULL,
  order_type text NOT NULL CHECK (order_type IN ('Pickup', 'DineIn')),
  owner_id platform_helpers.uuid_v7 NOT NULL,
  cart_id platform_helpers.uuid_v7 NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('Created', 'Current')),
  result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
  occurred_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL CHECK (expires_at = occurred_at + interval '24 hours'),
  PRIMARY KEY (brand_id, store_id, operation_id),
  FOREIGN KEY (cart_id, brand_id, store_id)
    REFERENCES rms_ordering.cart_customer_owner (cart_id, brand_id, store_id),
  FOREIGN KEY (brand_id, store_id, order_type, owner_id, cart_id)
    REFERENCES rms_ordering.cart_customer_owner (brand_id, store_id, order_type, owner_id, cart_id)
);

CREATE RULE cart_customer_owner_no_update AS ON UPDATE TO rms_ordering.cart_customer_owner DO INSTEAD NOTHING;
CREATE RULE cart_customer_owner_no_delete AS ON DELETE TO rms_ordering.cart_customer_owner DO INSTEAD NOTHING;
CREATE RULE cart_creation_operation_no_update AS ON UPDATE TO rms_ordering.cart_creation_operation DO INSTEAD NOTHING;
CREATE RULE cart_creation_operation_no_delete AS ON DELETE TO rms_ordering.cart_creation_operation DO INSTEAD NOTHING;

ALTER TABLE rms_ordering.cart_customer_owner ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.cart_customer_owner FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.cart_creation_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.cart_creation_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY cart_customer_owner_store_scope ON rms_ordering.cart_customer_owner
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY cart_creation_operation_store_scope ON rms_ordering.cart_creation_operation
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.cart_customer_owner FROM PUBLIC;
REVOKE ALL ON TABLE rms_ordering.cart_creation_operation FROM PUBLIC;
