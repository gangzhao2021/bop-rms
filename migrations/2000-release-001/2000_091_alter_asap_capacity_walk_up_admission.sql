-- bop-rms-migration: 1
-- owner: @rms/fulfillment
-- schema: rms_fulfillment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-COUNTER-WALK-UP-CAPACITY (2026-10-19): a customer standing at the counter is always
-- served. A pickup commitment staff take at the counter (a counter/Pos Cart, including a paper
-- order entered after an outage) is admitted as WalkUp: it is recorded and counts against the
-- pickup hour like any other order, so online pickup orders are paced by the real kitchen load, but
-- it is never refused because the hour is full. Online (Paced) commitments keep the existing limit
-- check, which now also sees the walk-up orders. Later versions of a commitment always carry the
-- admission of its first version (the trigger copies it), so the existing writers of sealing,
-- release, expiry and consumption need no change. Rows written before this migration are Paced
-- (the default); no row is updated (the table stays append-only) and no grant changes (the API
-- role already inserts and selects whole rows).
ALTER TABLE rms_fulfillment.capacity_asap_commitment
  ADD COLUMN admission text NOT NULL DEFAULT 'Paced';
ALTER TABLE rms_fulfillment.capacity_asap_commitment
  ADD CONSTRAINT capacity_asap_commitment_admission_check
    CHECK (admission IN ('Paced', 'WalkUp'));

CREATE OR REPLACE FUNCTION rms_fulfillment.validate_asap_capacity_commitment() RETURNS trigger
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

    -- A walk-up (counter) commitment is counted above by every later check but never refused.
    IF NEW.admission<>'WalkUp' AND NEW.capacity_units>current_limit-occupied THEN
      RAISE EXCEPTION 'insufficient capacity' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO original FROM rms_fulfillment.capacity_asap_commitment
      WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id
        AND allocation_id=NEW.allocation_id AND version=1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid ASAP history' USING ERRCODE='23514';
    END IF;
    -- Every later version keeps how the commitment was first admitted.
    NEW.admission:=original.admission;
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
