-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE UNIQUE INDEX cart_dining_association_unique
  ON rms_ordering.cart (cart_id, brand_id, store_id, dining_session_id);
CREATE INDEX cart_customer_session_history_idx
  ON rms_ordering.cart (brand_id, store_id, dining_session_id, cart_id)
  WHERE order_type = 'DineIn' AND source_channel IN ('Qr', 'Web');

CREATE TABLE rms_ordering.dining_cart_operation (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  dining_session_id platform_helpers.uuid_v7 NOT NULL,
  guest_session_id platform_helpers.uuid_v7 NOT NULL,
  participant_id platform_helpers.uuid_v7 NOT NULL,
  action_code text NOT NULL CHECK (action_code IN ('Create', 'Select')),
  cart_id platform_helpers.uuid_v7 NOT NULL,
  cart_version integer NOT NULL CHECK (cart_version > 0),
  occurred_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (brand_id, store_id, operation_id),
  FOREIGN KEY (cart_id, brand_id, store_id, dining_session_id)
    REFERENCES rms_ordering.cart (cart_id, brand_id, store_id, dining_session_id),
  CHECK ((action_code <> 'Create' OR cart_version = 1) IS TRUE),
  CHECK ((expires_at = occurred_at + interval '24 hours') IS TRUE),
  CHECK ((isfinite(occurred_at) AND occurred_at = date_trunc('milliseconds', occurred_at)) IS TRUE),
  CHECK ((isfinite(expires_at) AND expires_at = date_trunc('milliseconds', expires_at)) IS TRUE)
);
CREATE UNIQUE INDEX dining_cart_initial_create_unique
  ON rms_ordering.dining_cart_operation (brand_id, store_id, dining_session_id)
  WHERE action_code = 'Create';

CREATE FUNCTION rms_ordering.validate_dining_cart_operation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM rms_ordering.cart AS c
    WHERE c.cart_id = NEW.cart_id AND c.brand_id = NEW.brand_id AND c.store_id = NEW.store_id
      AND c.dining_session_id = NEW.dining_session_id AND c.order_type = 'DineIn'
      AND c.source_channel IN ('Qr', 'Web') AND c.aggregate_version = NEW.cart_version
      AND c.updated_at <= NEW.occurred_at AND c.lifecycle_status = 'Active'
      AND c.idle_expires_at > NEW.occurred_at AND c.absolute_expires_at > NEW.occurred_at
      AND (NEW.action_code <> 'Create' OR (
        c.created_by_actor_id = NEW.guest_session_id AND c.created_at = NEW.occurred_at
        AND NOT EXISTS (SELECT 1 FROM rms_ordering.cart_line AS l
          WHERE l.cart_id = c.cart_id AND l.brand_id = c.brand_id AND l.store_id = c.store_id)
      ))
  ) THEN
    RAISE EXCEPTION 'invalid cart selection' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.validate_dining_cart_operation() FROM PUBLIC;
CREATE TRIGGER dining_cart_operation_validate BEFORE INSERT
  ON rms_ordering.dining_cart_operation FOR EACH ROW
  EXECUTE FUNCTION rms_ordering.validate_dining_cart_operation();

CREATE FUNCTION rms_ordering.reject_dining_cart_operation_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'append-only cart selection history' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.reject_dining_cart_operation_mutation() FROM PUBLIC;
CREATE TRIGGER dining_cart_operation_no_mutation BEFORE UPDATE OR DELETE
  ON rms_ordering.dining_cart_operation FOR EACH ROW
  EXECUTE FUNCTION rms_ordering.reject_dining_cart_operation_mutation();
CREATE TRIGGER dining_cart_operation_no_truncate BEFORE TRUNCATE
  ON rms_ordering.dining_cart_operation FOR EACH STATEMENT
  EXECUTE FUNCTION rms_ordering.reject_dining_cart_operation_mutation();
ALTER TABLE rms_ordering.dining_cart_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.dining_cart_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_cart_operation_scope ON rms_ordering.dining_cart_operation
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.dining_cart_operation FROM PUBLIC;
