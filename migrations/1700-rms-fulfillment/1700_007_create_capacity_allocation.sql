-- bop-rms-migration: 1
-- owner: @rms/fulfillment
-- schema: rms_fulfillment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_fulfillment.capacity_hold_terminal (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  hold_id platform_helpers.uuid_v7 NOT NULL,
  terminal_state text NOT NULL CHECK (terminal_state IN ('Converted', 'Released', 'Expired')),
  allocation_id platform_helpers.uuid_v7,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (brand_id, store_id, hold_id),
  UNIQUE (brand_id, store_id, operation_id),
  UNIQUE (brand_id, store_id, hold_id, allocation_id),
  FOREIGN KEY (brand_id, store_id, hold_id)
    REFERENCES rms_fulfillment.capacity_hold (brand_id, store_id, hold_id),
  CHECK (((terminal_state = 'Converted') = (allocation_id IS NOT NULL)) IS TRUE),
  CHECK ((isfinite(occurred_at) AND occurred_at = date_trunc('milliseconds', occurred_at)) IS TRUE)
);

CREATE TABLE rms_fulfillment.capacity_allocation (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  allocation_id platform_helpers.uuid_v7 NOT NULL,
  hold_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_id platform_helpers.uuid_v7 NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (brand_id, store_id, allocation_id),
  UNIQUE (brand_id, store_id, hold_id),
  UNIQUE (brand_id, store_id, hold_id, allocation_id),
  FOREIGN KEY (brand_id, store_id, hold_id, allocation_id)
    REFERENCES rms_fulfillment.capacity_hold_terminal (brand_id, store_id, hold_id, allocation_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK ((isfinite(created_at) AND created_at = date_trunc('milliseconds', created_at)) IS TRUE)
);
ALTER TABLE rms_fulfillment.capacity_hold_terminal
  ADD CONSTRAINT capacity_hold_converted_allocation_fk
  FOREIGN KEY (brand_id, store_id, hold_id, allocation_id)
  REFERENCES rms_fulfillment.capacity_allocation (brand_id, store_id, hold_id, allocation_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE rms_fulfillment.capacity_allocation_terminal (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  allocation_id platform_helpers.uuid_v7 NOT NULL,
  terminal_state text NOT NULL CHECK (terminal_state IN ('Consumed', 'Released')),
  operation_id platform_helpers.uuid_v7 NOT NULL,
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  fulfillment_in_progress_at timestamptz,
  consumed_at timestamptz,
  PRIMARY KEY (brand_id, store_id, allocation_id),
  UNIQUE (brand_id, store_id, operation_id),
  FOREIGN KEY (brand_id, store_id, allocation_id)
    REFERENCES rms_fulfillment.capacity_allocation (brand_id, store_id, allocation_id),
  CHECK (((terminal_state = 'Consumed') = (consumed_at IS NOT NULL)) IS TRUE),
  CHECK ((terminal_state <> 'Released' OR fulfillment_in_progress_at IS NULL) IS TRUE),
  CHECK ((isfinite(occurred_at) AND occurred_at = date_trunc('milliseconds', occurred_at)) IS TRUE),
  CHECK ((fulfillment_in_progress_at IS NULL OR
    (isfinite(fulfillment_in_progress_at) AND fulfillment_in_progress_at = date_trunc('milliseconds', fulfillment_in_progress_at))) IS TRUE),
  CHECK ((consumed_at IS NULL OR
    (isfinite(consumed_at) AND consumed_at = date_trunc('milliseconds', consumed_at))) IS TRUE)
);

CREATE FUNCTION rms_fulfillment.validate_capacity_hold_terminal() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  held rms_fulfillment.capacity_hold%ROWTYPE;
  slot_start timestamptz;
  evaluated_at timestamptz;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'capacity writes require read committed' USING ERRCODE = '25000';
  END IF;
  SELECT * INTO held FROM rms_fulfillment.capacity_hold
    WHERE brand_id = NEW.brand_id AND store_id = NEW.store_id AND hold_id = NEW.hold_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid capacity scope' USING ERRCODE = '23514';
  END IF;
  SELECT starts_at INTO slot_start FROM rms_fulfillment.capacity_slot
    WHERE brand_id = NEW.brand_id AND store_id = NEW.store_id AND slot_id = held.slot_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid capacity scope' USING ERRCODE = '23514';
  END IF;
  evaluated_at := clock_timestamp();
  IF EXISTS (SELECT 1 FROM rms_fulfillment.capacity_hold_terminal
      WHERE brand_id = NEW.brand_id AND store_id = NEW.store_id AND hold_id = NEW.hold_id)
    OR NEW.occurred_at < held.created_at OR NEW.occurred_at > evaluated_at
    OR (NEW.terminal_state IN ('Converted', 'Released') AND
      (NEW.occurred_at >= held.expires_at OR evaluated_at >= held.expires_at))
    OR (NEW.terminal_state = 'Expired' AND NEW.occurred_at < held.expires_at)
    OR (NEW.terminal_state = 'Converted' AND
      (NEW.occurred_at >= slot_start OR evaluated_at >= slot_start))
  THEN
    RAISE EXCEPTION 'invalid capacity hold transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_fulfillment.validate_capacity_hold_terminal() FROM PUBLIC;
CREATE TRIGGER capacity_hold_terminal_validate BEFORE INSERT ON rms_fulfillment.capacity_hold_terminal
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.validate_capacity_hold_terminal();

CREATE FUNCTION rms_fulfillment.validate_capacity_allocation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  slot_start timestamptz;
  hold_expiry timestamptz;
  conversion_at timestamptz;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'capacity writes require read committed' USING ERRCODE = '25000';
  END IF;
  SELECT s.starts_at, h.expires_at INTO slot_start, hold_expiry
    FROM rms_fulfillment.capacity_hold h
    JOIN rms_fulfillment.capacity_slot s
      ON s.brand_id = h.brand_id AND s.store_id = h.store_id AND s.slot_id = h.slot_id
    WHERE h.brand_id = NEW.brand_id AND h.store_id = NEW.store_id AND h.hold_id = NEW.hold_id
    FOR UPDATE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid capacity scope' USING ERRCODE = '23514';
  END IF;
  SELECT occurred_at INTO conversion_at FROM rms_fulfillment.capacity_hold_terminal
    WHERE brand_id = NEW.brand_id AND store_id = NEW.store_id AND hold_id = NEW.hold_id
      AND allocation_id = NEW.allocation_id AND terminal_state = 'Converted';
  IF conversion_at IS NULL OR NEW.created_at <> conversion_at
    OR clock_timestamp() >= hold_expiry OR clock_timestamp() >= slot_start
  THEN
    RAISE EXCEPTION 'invalid capacity allocation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_fulfillment.validate_capacity_allocation() FROM PUBLIC;
CREATE TRIGGER capacity_allocation_validate BEFORE INSERT ON rms_fulfillment.capacity_allocation
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.validate_capacity_allocation();

CREATE FUNCTION rms_fulfillment.validate_capacity_allocation_terminal() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  slot_start timestamptz;
  allocation_created timestamptz;
  evaluated_at timestamptz;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'capacity writes require read committed' USING ERRCODE = '25000';
  END IF;
  SELECT s.starts_at, a.created_at INTO slot_start, allocation_created
    FROM rms_fulfillment.capacity_allocation a
    JOIN rms_fulfillment.capacity_hold h
      ON h.brand_id = a.brand_id AND h.store_id = a.store_id AND h.hold_id = a.hold_id
    JOIN rms_fulfillment.capacity_slot s
      ON s.brand_id = h.brand_id AND s.store_id = h.store_id AND s.slot_id = h.slot_id
    WHERE a.brand_id = NEW.brand_id AND a.store_id = NEW.store_id AND a.allocation_id = NEW.allocation_id
    FOR UPDATE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid capacity scope' USING ERRCODE = '23514';
  END IF;
  evaluated_at := clock_timestamp();
  IF EXISTS (SELECT 1 FROM rms_fulfillment.capacity_allocation_terminal
      WHERE brand_id = NEW.brand_id AND store_id = NEW.store_id AND allocation_id = NEW.allocation_id)
    OR NEW.occurred_at < allocation_created OR NEW.occurred_at > evaluated_at
    OR (NEW.fulfillment_in_progress_at IS NOT NULL AND
      (NEW.fulfillment_in_progress_at < allocation_created OR NEW.fulfillment_in_progress_at > NEW.occurred_at))
    OR (NEW.terminal_state = 'Released' AND
      (NEW.occurred_at >= slot_start OR evaluated_at >= slot_start))
    OR (NEW.terminal_state = 'Consumed' AND
      (NEW.consumed_at IS DISTINCT FROM least(slot_start, NEW.fulfillment_in_progress_at)
        OR NEW.consumed_at > NEW.occurred_at))
  THEN
    RAISE EXCEPTION 'invalid capacity allocation transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_fulfillment.validate_capacity_allocation_terminal() FROM PUBLIC;
CREATE TRIGGER capacity_allocation_terminal_validate BEFORE INSERT ON rms_fulfillment.capacity_allocation_terminal
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.validate_capacity_allocation_terminal();

CREATE TRIGGER capacity_hold_terminal_no_mutation BEFORE UPDATE OR DELETE ON rms_fulfillment.capacity_hold_terminal
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE TRIGGER capacity_hold_terminal_no_truncate BEFORE TRUNCATE ON rms_fulfillment.capacity_hold_terminal
  FOR EACH STATEMENT EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
ALTER TABLE rms_fulfillment.capacity_hold_terminal ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.capacity_hold_terminal FORCE ROW LEVEL SECURITY;
CREATE POLICY capacity_hold_terminal_scope ON rms_fulfillment.capacity_hold_terminal
  USING ((brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id()) IS TRUE)
  WITH CHECK ((brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_fulfillment.capacity_hold_terminal FROM PUBLIC;

CREATE TRIGGER capacity_allocation_no_mutation BEFORE UPDATE OR DELETE ON rms_fulfillment.capacity_allocation
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE TRIGGER capacity_allocation_no_truncate BEFORE TRUNCATE ON rms_fulfillment.capacity_allocation
  FOR EACH STATEMENT EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
ALTER TABLE rms_fulfillment.capacity_allocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.capacity_allocation FORCE ROW LEVEL SECURITY;
CREATE POLICY capacity_allocation_scope ON rms_fulfillment.capacity_allocation
  USING ((brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id()) IS TRUE)
  WITH CHECK ((brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_fulfillment.capacity_allocation FROM PUBLIC;

CREATE TRIGGER capacity_allocation_terminal_no_mutation BEFORE UPDATE OR DELETE ON rms_fulfillment.capacity_allocation_terminal
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE TRIGGER capacity_allocation_terminal_no_truncate BEFORE TRUNCATE ON rms_fulfillment.capacity_allocation_terminal
  FOR EACH STATEMENT EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
ALTER TABLE rms_fulfillment.capacity_allocation_terminal ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.capacity_allocation_terminal FORCE ROW LEVEL SECURITY;
CREATE POLICY capacity_allocation_terminal_scope ON rms_fulfillment.capacity_allocation_terminal
  USING ((brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id()) IS TRUE)
  WITH CHECK ((brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_fulfillment.capacity_allocation_terminal FROM PUBLIC;

CREATE FUNCTION rms_fulfillment.validate_capacity_hold_with_allocations() RETURNS trigger
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
  SELECT coalesce(sum(units), 0) INTO occupied FROM (
    SELECT h.capacity_units AS units FROM rms_fulfillment.capacity_hold h
    WHERE h.brand_id = NEW.brand_id AND h.store_id = NEW.store_id AND h.slot_id = NEW.slot_id
      AND h.expires_at > evaluated_at
      AND NOT EXISTS (SELECT 1 FROM rms_fulfillment.capacity_hold_terminal t
        WHERE t.brand_id = h.brand_id AND t.store_id = h.store_id AND t.hold_id = h.hold_id
          AND (t.terminal_state IN ('Released', 'Expired') OR EXISTS (
            SELECT 1 FROM rms_fulfillment.capacity_allocation a
            WHERE a.brand_id = h.brand_id AND a.store_id = h.store_id AND a.hold_id = h.hold_id
          )))
    UNION ALL
    SELECT h.capacity_units AS units FROM rms_fulfillment.capacity_allocation a
    JOIN rms_fulfillment.capacity_hold h
      ON h.brand_id = a.brand_id AND h.store_id = a.store_id AND h.hold_id = a.hold_id
    WHERE h.brand_id = NEW.brand_id AND h.store_id = NEW.store_id AND h.slot_id = NEW.slot_id
      AND NOT EXISTS (SELECT 1 FROM rms_fulfillment.capacity_allocation_terminal t
        WHERE t.brand_id = a.brand_id AND t.store_id = a.store_id
          AND t.allocation_id = a.allocation_id AND t.terminal_state = 'Released')
  ) occupied_units;
  IF NEW.capacity_units > current_limit - occupied THEN
    RAISE EXCEPTION 'insufficient capacity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_fulfillment.validate_capacity_hold_with_allocations() FROM PUBLIC;
DROP TRIGGER capacity_hold_validate ON rms_fulfillment.capacity_hold;
CREATE TRIGGER capacity_hold_validate BEFORE INSERT ON rms_fulfillment.capacity_hold
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.validate_capacity_hold_with_allocations();
