-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA rms_ordering;
REVOKE ALL ON SCHEMA rms_ordering FROM PUBLIC;

CREATE TABLE rms_ordering.cart (
  cart_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_type text NOT NULL CHECK (order_type IN ('DineIn', 'Pickup')),
  source_channel text NOT NULL CHECK (source_channel IN ('Api', 'Pos', 'Qr', 'Web')),
  dining_session_id platform_helpers.uuid_v7,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT cart_scope_identity_unique UNIQUE (cart_id, brand_id, store_id),
  CONSTRAINT cart_dining_context_check CHECK (
    (order_type = 'DineIn' AND dining_session_id IS NOT NULL)
    OR (order_type = 'Pickup' AND dining_session_id IS NULL)
  ),
  CONSTRAINT cart_time_order_check CHECK (updated_at >= created_at)
);

CREATE TABLE rms_ordering.cart_line (
  cart_line_id platform_helpers.uuid_v7 PRIMARY KEY,
  cart_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  sellable_id platform_helpers.uuid_v7 NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  option_selections_json jsonb NOT NULL CHECK (jsonb_typeof(option_selections_json) = 'array'),
  added_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  added_by_participant_id platform_helpers.uuid_v7,
  added_at timestamp with time zone NOT NULL,
  CONSTRAINT cart_line_cart_fk
    FOREIGN KEY (cart_id, brand_id, store_id)
    REFERENCES rms_ordering.cart (cart_id, brand_id, store_id),
  CONSTRAINT cart_line_scope_identity_unique UNIQUE (cart_line_id, cart_id, brand_id, store_id)
);

CREATE RULE cart_identity_no_update AS
  ON UPDATE TO rms_ordering.cart
  WHERE (
    OLD.cart_id IS DISTINCT FROM NEW.cart_id
    OR OLD.brand_id IS DISTINCT FROM NEW.brand_id
    OR OLD.store_id IS DISTINCT FROM NEW.store_id
    OR OLD.order_type IS DISTINCT FROM NEW.order_type
    OR OLD.source_channel IS DISTINCT FROM NEW.source_channel
    OR OLD.dining_session_id IS DISTINCT FROM NEW.dining_session_id
    OR OLD.created_by_actor_id IS DISTINCT FROM NEW.created_by_actor_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  )
  DO INSTEAD NOTHING;
CREATE RULE cart_line_identity_no_update AS
  ON UPDATE TO rms_ordering.cart_line
  WHERE (
    OLD.cart_line_id IS DISTINCT FROM NEW.cart_line_id
    OR OLD.cart_id IS DISTINCT FROM NEW.cart_id
    OR OLD.brand_id IS DISTINCT FROM NEW.brand_id
    OR OLD.store_id IS DISTINCT FROM NEW.store_id
    OR OLD.added_by_actor_id IS DISTINCT FROM NEW.added_by_actor_id
    OR OLD.added_by_participant_id IS DISTINCT FROM NEW.added_by_participant_id
    OR OLD.added_at IS DISTINCT FROM NEW.added_at
  )
  DO INSTEAD NOTHING;

CREATE INDEX cart_store_updated_idx ON rms_ordering.cart (brand_id, store_id, updated_at DESC);
CREATE INDEX cart_line_cart_idx ON rms_ordering.cart_line (brand_id, store_id, cart_id);

ALTER TABLE rms_ordering.cart ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.cart FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.cart_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.cart_line FORCE ROW LEVEL SECURITY;

CREATE POLICY cart_store_scope_policy ON rms_ordering.cart
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );
CREATE POLICY cart_line_store_scope_policy ON rms_ordering.cart_line
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND store_id = platform_helpers.current_store_id()
  );

REVOKE ALL ON TABLE rms_ordering.cart FROM PUBLIC;
REVOKE ALL ON TABLE rms_ordering.cart_line FROM PUBLIC;
