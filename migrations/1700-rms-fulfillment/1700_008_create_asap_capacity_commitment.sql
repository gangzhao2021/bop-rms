-- bop-rms-migration: 1
-- owner: @rms/fulfillment
-- schema: rms_fulfillment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_fulfillment.capacity_asap_commitment (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  allocation_id platform_helpers.uuid_v7 NOT NULL,
  version bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('Prepared','PaymentPending','Released','Expired','Consumed')),
  slot_id platform_helpers.uuid_v7 NOT NULL,
  config_version bigint NOT NULL,
  guest_session_id platform_helpers.uuid_v7 NOT NULL,
  cart_id platform_helpers.uuid_v7 NOT NULL,
  cart_version bigint NOT NULL CHECK (cart_version BETWEEN 1 AND 9007199254740991),
  quote_id platform_helpers.uuid_v7 NOT NULL,
  submission_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  order_batch_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_id platform_helpers.uuid_v7 NOT NULL,
  payment_operation_id platform_helpers.uuid_v7 NOT NULL,
  capacity_units bigint NOT NULL CHECK (capacity_units BETWEEN 1 AND 9007199254740991),
  units_rule_version bigint NOT NULL CHECK (units_rule_version BETWEEN 1 AND 9007199254740991),
  units_input_digest text NOT NULL CHECK (units_input_digest ~ '^sha256:[0-9a-f]{64}$'),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  prepared_at timestamptz NOT NULL,
  preparation_valid_until timestamptz NOT NULL,
  ordering_linked_at timestamptz,
  payment_requested_at timestamptz,
  capacity_expires_at timestamptz,
  terminal_at timestamptz,
  PRIMARY KEY (brand_id,store_id,allocation_id,version),
  FOREIGN KEY (brand_id,store_id,slot_id,config_version)
    REFERENCES rms_fulfillment.capacity_slot_configuration (brand_id,store_id,slot_id,config_version),
  CHECK ((preparation_valid_until > prepared_at) IS TRUE),
  CHECK (((payment_requested_at IS NULL AND ordering_linked_at IS NULL AND capacity_expires_at IS NULL)
    OR (payment_requested_at IS NOT NULL AND ordering_linked_at IS NOT NULL AND capacity_expires_at IS NOT NULL
      AND ordering_linked_at >= prepared_at AND payment_requested_at >= ordering_linked_at
      AND payment_requested_at < preparation_valid_until
      AND capacity_expires_at = payment_requested_at + interval '30 minutes')) IS TRUE),
  CHECK (((state='Prepared' AND version=1 AND payment_requested_at IS NULL AND terminal_at IS NULL)
    OR (state='PaymentPending' AND version=2 AND payment_requested_at IS NOT NULL AND terminal_at IS NULL)
    OR (state IN ('Released','Expired','Consumed') AND terminal_at IS NOT NULL
      AND terminal_at >= coalesce(payment_requested_at,prepared_at)
      AND version=CASE WHEN payment_requested_at IS NULL THEN 2 ELSE 3 END
      AND (state<>'Consumed' OR payment_requested_at IS NOT NULL)
      AND (state<>'Expired' OR terminal_at >= coalesce(capacity_expires_at,preparation_valid_until)))) IS TRUE)
);
CREATE UNIQUE INDEX capacity_asap_submission_idx ON rms_fulfillment.capacity_asap_commitment
  (brand_id,store_id,submission_id) WHERE version=1;
CREATE UNIQUE INDEX capacity_asap_payment_idx ON rms_fulfillment.capacity_asap_commitment
  (brand_id,store_id,payment_operation_id) WHERE version=1;
CREATE INDEX capacity_asap_slot_idx ON rms_fulfillment.capacity_asap_commitment
  (brand_id,store_id,slot_id,allocation_id,version);
ALTER TABLE rms_fulfillment.capacity_asap_commitment ADD CHECK ((prepared_at IS NULL OR (isfinite(prepared_at) AND prepared_at=date_trunc('milliseconds',prepared_at))) IS TRUE);
ALTER TABLE rms_fulfillment.capacity_asap_commitment ADD CHECK ((preparation_valid_until IS NULL OR (isfinite(preparation_valid_until) AND preparation_valid_until=date_trunc('milliseconds',preparation_valid_until))) IS TRUE);
ALTER TABLE rms_fulfillment.capacity_asap_commitment ADD CHECK ((ordering_linked_at IS NULL OR (isfinite(ordering_linked_at) AND ordering_linked_at=date_trunc('milliseconds',ordering_linked_at))) IS TRUE);
ALTER TABLE rms_fulfillment.capacity_asap_commitment ADD CHECK ((payment_requested_at IS NULL OR (isfinite(payment_requested_at) AND payment_requested_at=date_trunc('milliseconds',payment_requested_at))) IS TRUE);
ALTER TABLE rms_fulfillment.capacity_asap_commitment ADD CHECK ((capacity_expires_at IS NULL OR (isfinite(capacity_expires_at) AND capacity_expires_at=date_trunc('milliseconds',capacity_expires_at))) IS TRUE);
ALTER TABLE rms_fulfillment.capacity_asap_commitment ADD CHECK ((terminal_at IS NULL OR (isfinite(terminal_at) AND terminal_at=date_trunc('milliseconds',terminal_at))) IS TRUE);

CREATE FUNCTION rms_fulfillment.validate_asap_capacity_commitment() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  original rms_fulfillment.capacity_asap_commitment%ROWTYPE;
  prior rms_fulfillment.capacity_asap_commitment%ROWTYPE;
  slot_end timestamptz;
  slot_type text;
  evaluated_at timestamptz;
  current_version bigint;
  current_limit bigint;
  current_publication timestamptz;
  occupied numeric;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'capacity writes require read committed' USING ERRCODE='25000';
  END IF;
  SELECT ends_at,fulfillment_type INTO slot_end,slot_type FROM rms_fulfillment.capacity_slot
    WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND slot_id=NEW.slot_id FOR UPDATE;
  IF NOT FOUND OR slot_type<>'Pickup' THEN
    RAISE EXCEPTION 'invalid capacity scope' USING ERRCODE='23514';
  END IF;
  evaluated_at:=clock_timestamp();
  IF NEW.version=1 THEN
    SELECT config_version,capacity_limit,published_at
      INTO current_version,current_limit,current_publication
      FROM rms_fulfillment.capacity_slot_configuration
      WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND slot_id=NEW.slot_id
      ORDER BY config_version DESC LIMIT 1;
    IF current_version IS NULL OR NEW.config_version<>current_version
      OR NEW.prepared_at<current_publication OR NEW.prepared_at>evaluated_at
      OR NEW.prepared_at>=slot_end OR evaluated_at>=slot_end
      OR NEW.preparation_valid_until<=evaluated_at THEN
      RAISE EXCEPTION 'invalid ASAP preparation' USING ERRCODE='23514';
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
    UNION ALL
    SELECT a.capacity_units AS units FROM rms_fulfillment.capacity_asap_commitment a
    WHERE a.brand_id=NEW.brand_id AND a.store_id=NEW.store_id AND a.slot_id=NEW.slot_id
      AND NOT EXISTS (SELECT 1 FROM rms_fulfillment.capacity_asap_commitment later
        WHERE later.brand_id=a.brand_id AND later.store_id=a.store_id
          AND later.allocation_id=a.allocation_id AND later.version>a.version)
      AND (a.state='Consumed' OR
        (a.state='Prepared' AND a.preparation_valid_until>evaluated_at) OR
        (a.state='PaymentPending' AND a.capacity_expires_at>evaluated_at))
  ) occupied_units;

    IF NEW.capacity_units>current_limit-occupied THEN
      RAISE EXCEPTION 'insufficient capacity' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO original FROM rms_fulfillment.capacity_asap_commitment
      WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id
        AND allocation_id=NEW.allocation_id AND version=1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid ASAP history' USING ERRCODE='23514';
    END IF;
    SELECT * INTO prior FROM rms_fulfillment.capacity_asap_commitment
      WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND allocation_id=NEW.allocation_id
      ORDER BY version DESC LIMIT 1;
    IF NEW.version<>prior.version+1 OR prior.state NOT IN ('Prepared','PaymentPending')
      OR (to_jsonb(NEW)-ARRAY['version','state','ordering_linked_at','payment_requested_at','capacity_expires_at','terminal_at'])
         IS DISTINCT FROM
         (to_jsonb(original)-ARRAY['version','state','ordering_linked_at','payment_requested_at','capacity_expires_at','terminal_at'])
      OR (NEW.state='PaymentPending' AND
        (prior.state<>'Prepared' OR NEW.payment_requested_at>evaluated_at
          OR evaluated_at>=original.preparation_valid_until))
      OR (NEW.state='Consumed' AND
        (prior.state<>'PaymentPending' OR NEW.terminal_at>=prior.capacity_expires_at
          OR evaluated_at>=prior.capacity_expires_at))
      OR (NEW.state<>'PaymentPending' AND
        (NEW.ordering_linked_at IS DISTINCT FROM prior.ordering_linked_at
          OR NEW.payment_requested_at IS DISTINCT FROM prior.payment_requested_at
          OR NEW.capacity_expires_at IS DISTINCT FROM prior.capacity_expires_at
          OR NEW.terminal_at>evaluated_at))
    THEN
      RAISE EXCEPTION 'invalid ASAP transition' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_fulfillment.validate_asap_capacity_commitment() FROM PUBLIC;
CREATE TRIGGER capacity_asap_validate BEFORE INSERT ON rms_fulfillment.capacity_asap_commitment
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.validate_asap_capacity_commitment();
CREATE TRIGGER capacity_asap_no_mutation BEFORE UPDATE OR DELETE ON rms_fulfillment.capacity_asap_commitment
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE TRIGGER capacity_asap_no_truncate BEFORE TRUNCATE ON rms_fulfillment.capacity_asap_commitment
  FOR EACH STATEMENT EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
ALTER TABLE rms_fulfillment.capacity_asap_commitment ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.capacity_asap_commitment FORCE ROW LEVEL SECURITY;
CREATE POLICY capacity_asap_scope ON rms_fulfillment.capacity_asap_commitment
  USING ((brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE)
  WITH CHECK ((brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_fulfillment.capacity_asap_commitment FROM PUBLIC;

CREATE FUNCTION rms_fulfillment.validate_capacity_hold_with_asap() RETURNS trigger
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
    UNION ALL
    SELECT a.capacity_units AS units FROM rms_fulfillment.capacity_asap_commitment a
    WHERE a.brand_id=NEW.brand_id AND a.store_id=NEW.store_id AND a.slot_id=NEW.slot_id
      AND NOT EXISTS (SELECT 1 FROM rms_fulfillment.capacity_asap_commitment later
        WHERE later.brand_id=a.brand_id AND later.store_id=a.store_id
          AND later.allocation_id=a.allocation_id AND later.version>a.version)
      AND (a.state='Consumed' OR
        (a.state='Prepared' AND a.preparation_valid_until>evaluated_at) OR
        (a.state='PaymentPending' AND a.capacity_expires_at>evaluated_at))
  ) occupied_units;
  IF NEW.capacity_units > current_limit - occupied THEN
    RAISE EXCEPTION 'insufficient capacity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_fulfillment.validate_capacity_hold_with_asap() FROM PUBLIC;
DROP TRIGGER capacity_hold_validate ON rms_fulfillment.capacity_hold;
CREATE TRIGGER capacity_hold_validate BEFORE INSERT ON rms_fulfillment.capacity_hold
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.validate_capacity_hold_with_asap();
