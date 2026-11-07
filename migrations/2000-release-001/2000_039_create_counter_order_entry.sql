-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q7: staff take a pickup order at the counter for a guest without a phone, or enter a paper
-- order taken while the system was unreachable. The order goes through the ordinary customer checks
-- (menu, sold out, price, tax, store open, capacity) under a walk-up guest session the counter opens;
-- its Cart is a counter (Pos) Cart. This record names the staff member who took it and makes the
-- staff command idempotent: one operation, one counter Cart. Append-only.
CREATE TABLE rms_ordering.counter_order_entry (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 intent_hash text NOT NULL CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$'),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 guest_session_id platform_helpers.uuid_v7 NOT NULL,
 cart_id platform_helpers.uuid_v7 NOT NULL,
 tip_selection_id platform_helpers.uuid_v7 NOT NULL,
 order_type text NOT NULL CHECK (order_type = 'Pickup'),
 source_channel text NOT NULL CHECK (source_channel = 'Pos'),
 recorded_after_outage boolean NOT NULL,
 created_at timestamptz NOT NULL CHECK (isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 PRIMARY KEY (brand_id,store_id,operation_id),
 CONSTRAINT counter_order_entry_cart_unique UNIQUE (brand_id,store_id,cart_id),
 CONSTRAINT counter_order_entry_tip_unique UNIQUE (brand_id,store_id,tip_selection_id),
 CONSTRAINT counter_order_entry_cart_fk FOREIGN KEY (cart_id,brand_id,store_id)
  REFERENCES rms_ordering.cart (cart_id,brand_id,store_id)
);

CREATE FUNCTION rms_ordering.check_counter_order_entry() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.cart c WHERE c.brand_id=NEW.brand_id AND c.store_id=NEW.store_id
  AND c.cart_id=NEW.cart_id AND c.order_type='Pickup' AND c.source_channel='Pos'
  AND c.created_by_actor_id=NEW.guest_session_id AND c.created_at<=NEW.created_at) THEN
  RAISE EXCEPTION 'counter order entry does not match a counter cart' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.check_counter_order_entry() FROM PUBLIC;
CREATE TRIGGER counter_order_entry_check BEFORE INSERT ON rms_ordering.counter_order_entry
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.check_counter_order_entry();

CREATE FUNCTION rms_ordering.reject_counter_order_entry_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only counter order entry' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.reject_counter_order_entry_mutation() FROM PUBLIC;
CREATE TRIGGER counter_order_entry_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.counter_order_entry
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_counter_order_entry_mutation();
CREATE TRIGGER counter_order_entry_no_truncate BEFORE TRUNCATE ON rms_ordering.counter_order_entry
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_counter_order_entry_mutation();
ALTER TABLE rms_ordering.counter_order_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.counter_order_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY counter_order_entry_scope ON rms_ordering.counter_order_entry
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.counter_order_entry FROM PUBLIC;
