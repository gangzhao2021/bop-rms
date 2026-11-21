-- bop-rms-migration: 1
-- owner: @rms/fulfillment
-- schema: rms_fulfillment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_fulfillment.capacity_slot (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  slot_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_type text NOT NULL CHECK (fulfillment_type IN ('Pickup', 'Delivery')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  time_zone text NOT NULL,
  business_date date NOT NULL,
  PRIMARY KEY (brand_id, store_id, slot_id),
  UNIQUE (brand_id, store_id, fulfillment_type, starts_at, ends_at),
  CHECK ((isfinite(starts_at) AND starts_at = date_trunc('milliseconds', starts_at)) IS TRUE),
  CHECK ((isfinite(ends_at) AND ends_at = date_trunc('milliseconds', ends_at)) IS TRUE),
  CHECK ((ends_at > starts_at AND isfinite(business_date)) IS TRUE)
);

CREATE TABLE rms_fulfillment.capacity_slot_configuration (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  slot_id platform_helpers.uuid_v7 NOT NULL,
  config_version bigint NOT NULL CHECK (config_version BETWEEN 1 AND 9007199254740991),
  capacity_limit bigint NOT NULL CHECK (capacity_limit BETWEEN 0 AND 9007199254740991),
  published_at timestamptz NOT NULL,
  PRIMARY KEY (brand_id, store_id, slot_id, config_version),
  FOREIGN KEY (brand_id, store_id, slot_id)
    REFERENCES rms_fulfillment.capacity_slot (brand_id, store_id, slot_id),
  CHECK ((isfinite(published_at) AND published_at = date_trunc('milliseconds', published_at)) IS TRUE)
);

CREATE TABLE rms_fulfillment.capacity_hold (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  hold_id platform_helpers.uuid_v7 NOT NULL,
  slot_id platform_helpers.uuid_v7 NOT NULL,
  config_version bigint NOT NULL,
  cart_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  capacity_units bigint NOT NULL CHECK (capacity_units BETWEEN 1 AND 9007199254740991),
  units_rule_version bigint NOT NULL CHECK (units_rule_version BETWEEN 1 AND 9007199254740991),
  units_input_digest text NOT NULL CHECK (units_input_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'IndirectIdentifier'),
  PRIMARY KEY (brand_id, store_id, hold_id),
  UNIQUE (brand_id, store_id, operation_id),
  FOREIGN KEY (brand_id, store_id, slot_id, config_version)
    REFERENCES rms_fulfillment.capacity_slot_configuration (brand_id, store_id, slot_id, config_version),
  CHECK ((isfinite(created_at) AND created_at = date_trunc('milliseconds', created_at)) IS TRUE),
  CHECK ((isfinite(expires_at) AND expires_at = date_trunc('milliseconds', expires_at)) IS TRUE),
  CHECK ((expires_at > created_at) IS TRUE)
);
CREATE INDEX capacity_hold_live_slot_idx
  ON rms_fulfillment.capacity_hold (brand_id, store_id, slot_id, expires_at);

CREATE FUNCTION rms_fulfillment.validate_capacity_slot() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.time_zone)
  THEN
    RAISE EXCEPTION 'invalid capacity slot' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_fulfillment.validate_capacity_slot() FROM PUBLIC;
CREATE TRIGGER capacity_slot_validate BEFORE INSERT ON rms_fulfillment.capacity_slot
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.validate_capacity_slot();

CREATE FUNCTION rms_fulfillment.validate_capacity_configuration() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  previous_version bigint;
  previous_publication timestamptz;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'capacity writes require read committed' USING ERRCODE = '25000';
  END IF;
  PERFORM 1 FROM rms_fulfillment.capacity_slot
    WHERE brand_id = NEW.brand_id AND store_id = NEW.store_id AND slot_id = NEW.slot_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid capacity scope' USING ERRCODE = '23514';
  END IF;
  SELECT config_version, published_at INTO previous_version, previous_publication
    FROM rms_fulfillment.capacity_slot_configuration
    WHERE brand_id = NEW.brand_id AND store_id = NEW.store_id AND slot_id = NEW.slot_id
    ORDER BY config_version DESC LIMIT 1;
  IF NEW.config_version <> coalesce(previous_version, 0) + 1
    OR NEW.published_at > clock_timestamp()
    OR NEW.published_at < previous_publication
  THEN
    RAISE EXCEPTION 'invalid capacity configuration' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_fulfillment.validate_capacity_configuration() FROM PUBLIC;
CREATE TRIGGER capacity_configuration_validate BEFORE INSERT
  ON rms_fulfillment.capacity_slot_configuration FOR EACH ROW
  EXECUTE FUNCTION rms_fulfillment.validate_capacity_configuration();

CREATE FUNCTION rms_fulfillment.validate_capacity_hold() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  slot_start timestamptz;
  current_version bigint;
  current_limit bigint;
  current_publication timestamptz;
  occupied numeric;
  evaluated_at timestamptz;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'capacity writes require read committed' USING ERRCODE = '25000';
  END IF;
  SELECT starts_at INTO slot_start FROM rms_fulfillment.capacity_slot
    WHERE brand_id = NEW.brand_id AND store_id = NEW.store_id AND slot_id = NEW.slot_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid capacity scope' USING ERRCODE = '23514';
  END IF;
  evaluated_at := clock_timestamp();
  SELECT config_version, capacity_limit, published_at
    INTO current_version, current_limit, current_publication
    FROM rms_fulfillment.capacity_slot_configuration
    WHERE brand_id = NEW.brand_id AND store_id = NEW.store_id AND slot_id = NEW.slot_id
    ORDER BY config_version DESC LIMIT 1;
  IF current_version IS NULL OR NEW.config_version <> current_version
    OR NEW.created_at < current_publication OR NEW.created_at > evaluated_at
    OR NEW.created_at >= slot_start OR evaluated_at >= slot_start
    OR NEW.expires_at <= evaluated_at
  THEN
    RAISE EXCEPTION 'invalid capacity hold' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(sum(capacity_units), 0) INTO occupied FROM rms_fulfillment.capacity_hold
    WHERE brand_id = NEW.brand_id AND store_id = NEW.store_id AND slot_id = NEW.slot_id
      AND expires_at > evaluated_at;
  IF NEW.capacity_units > current_limit - occupied THEN
    RAISE EXCEPTION 'insufficient capacity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_fulfillment.validate_capacity_hold() FROM PUBLIC;
CREATE TRIGGER capacity_hold_validate BEFORE INSERT ON rms_fulfillment.capacity_hold
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.validate_capacity_hold();

CREATE TRIGGER capacity_slot_no_mutation BEFORE UPDATE OR DELETE ON rms_fulfillment.capacity_slot
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE TRIGGER capacity_slot_no_truncate BEFORE TRUNCATE ON rms_fulfillment.capacity_slot
  FOR EACH STATEMENT EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
ALTER TABLE rms_fulfillment.capacity_slot ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.capacity_slot FORCE ROW LEVEL SECURITY;
CREATE POLICY capacity_slot_scope ON rms_fulfillment.capacity_slot
  USING ((brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id()) IS TRUE)
  WITH CHECK ((brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_fulfillment.capacity_slot FROM PUBLIC;

CREATE TRIGGER capacity_slot_configuration_no_mutation BEFORE UPDATE OR DELETE ON rms_fulfillment.capacity_slot_configuration
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE TRIGGER capacity_slot_configuration_no_truncate BEFORE TRUNCATE ON rms_fulfillment.capacity_slot_configuration
  FOR EACH STATEMENT EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
ALTER TABLE rms_fulfillment.capacity_slot_configuration ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.capacity_slot_configuration FORCE ROW LEVEL SECURITY;
CREATE POLICY capacity_slot_configuration_scope ON rms_fulfillment.capacity_slot_configuration
  USING ((brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id()) IS TRUE)
  WITH CHECK ((brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_fulfillment.capacity_slot_configuration FROM PUBLIC;

CREATE TRIGGER capacity_hold_no_mutation BEFORE UPDATE OR DELETE ON rms_fulfillment.capacity_hold
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE TRIGGER capacity_hold_no_truncate BEFORE TRUNCATE ON rms_fulfillment.capacity_hold
  FOR EACH STATEMENT EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
ALTER TABLE rms_fulfillment.capacity_hold ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.capacity_hold FORCE ROW LEVEL SECURITY;
CREATE POLICY capacity_hold_scope ON rms_fulfillment.capacity_hold
  USING ((brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id()) IS TRUE)
  WITH CHECK ((brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_fulfillment.capacity_hold FROM PUBLIC;
