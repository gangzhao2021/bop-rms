-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_ordering.dining_cart_replacement (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  dining_session_id platform_helpers.uuid_v7 NOT NULL,
  previous_cart_id platform_helpers.uuid_v7 NOT NULL,
  cart_id platform_helpers.uuid_v7 NOT NULL,
  previous_cart_version integer NOT NULL CHECK (previous_cart_version > 0),
  guest_session_id platform_helpers.uuid_v7 NOT NULL,
  participant_id platform_helpers.uuid_v7 NOT NULL,
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (brand_id, store_id, operation_id),
  UNIQUE (brand_id, store_id, previous_cart_id),
  UNIQUE (brand_id, store_id, cart_id),
  FOREIGN KEY (previous_cart_id, brand_id, store_id, dining_session_id)
    REFERENCES rms_ordering.cart (cart_id, brand_id, store_id, dining_session_id),
  FOREIGN KEY (cart_id, brand_id, store_id, dining_session_id)
    REFERENCES rms_ordering.cart (cart_id, brand_id, store_id, dining_session_id),
  CHECK (previous_cart_id <> cart_id),
  CHECK (expires_at = occurred_at + interval '24 hours'),
  CHECK (isfinite(occurred_at) AND occurred_at = date_trunc('milliseconds', occurred_at)),
  CHECK (isfinite(expires_at) AND expires_at = date_trunc('milliseconds', expires_at))
);

CREATE FUNCTION rms_ordering.validate_dining_cart_replacement() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM rms_ordering.cart AS previous
    JOIN rms_ordering.cart AS successor
      ON successor.brand_id = previous.brand_id AND successor.store_id = previous.store_id
      AND successor.dining_session_id = previous.dining_session_id
    WHERE previous.cart_id = NEW.previous_cart_id
      AND previous.brand_id = NEW.brand_id AND previous.store_id = NEW.store_id
      AND previous.dining_session_id = NEW.dining_session_id
      AND previous.aggregate_version = NEW.previous_cart_version
      AND previous.order_type = 'DineIn' AND previous.source_channel IN ('Qr', 'Web')
      AND previous.lifecycle_status IN ('Expired', 'Abandoned')
      AND previous.terminal_at <= NEW.occurred_at AND previous.updated_at <= NEW.occurred_at
      AND successor.cart_id = NEW.cart_id AND successor.order_type = 'DineIn'
      AND successor.source_channel = previous.source_channel
      AND successor.aggregate_version = 1 AND successor.lifecycle_status = 'Active'
      AND successor.created_at = NEW.occurred_at AND successor.updated_at = NEW.occurred_at
      AND successor.created_by_actor_id = NEW.guest_session_id
      AND successor.idle_expires_at > NEW.occurred_at
      AND successor.absolute_expires_at > NEW.occurred_at
      AND NOT EXISTS (SELECT 1 FROM rms_ordering.cart_line AS line
        WHERE line.cart_id = successor.cart_id AND line.brand_id = successor.brand_id
          AND line.store_id = successor.store_id)
      AND NOT EXISTS (SELECT 1 FROM rms_ordering.cart_quote_attachment AS quote
        WHERE quote.cart_id = successor.cart_id AND quote.brand_id = successor.brand_id
          AND quote.store_id = successor.store_id)
  ) THEN
    RAISE EXCEPTION 'invalid cart replacement' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.validate_dining_cart_replacement() FROM PUBLIC;
CREATE TRIGGER dining_cart_replacement_validate BEFORE INSERT
  ON rms_ordering.dining_cart_replacement FOR EACH ROW
  EXECUTE FUNCTION rms_ordering.validate_dining_cart_replacement();

CREATE FUNCTION rms_ordering.reject_dining_cart_replacement_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'append-only cart replacement history' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.reject_dining_cart_replacement_mutation() FROM PUBLIC;
CREATE TRIGGER dining_cart_replacement_no_mutation BEFORE UPDATE OR DELETE
  ON rms_ordering.dining_cart_replacement FOR EACH ROW
  EXECUTE FUNCTION rms_ordering.reject_dining_cart_replacement_mutation();
CREATE TRIGGER dining_cart_replacement_no_truncate BEFORE TRUNCATE
  ON rms_ordering.dining_cart_replacement FOR EACH STATEMENT
  EXECUTE FUNCTION rms_ordering.reject_dining_cart_replacement_mutation();
ALTER TABLE rms_ordering.dining_cart_replacement ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.dining_cart_replacement FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_cart_replacement_scope ON rms_ordering.dining_cart_replacement
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.dining_cart_replacement FROM PUBLIC;
