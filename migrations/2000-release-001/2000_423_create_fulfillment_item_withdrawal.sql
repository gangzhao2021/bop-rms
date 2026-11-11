-- bop-rms-migration: 1
-- owner: @rms/fulfillment
-- schema: rms_fulfillment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 M10 (DEC-OWNER-DEFAULTS-2026-11-06 item 4): staff refunded some units of a pickup line
-- and said "stop making it too" (Ordering's order_item_refund_withdrawal, 2000_421). Each refunded
-- line keeps one append-only fact here, written in the refund transaction: these units are no
-- longer owed to the guest. The pickup proof and the handoff count ordered minus withdrawn units,
-- so the handover never records refunded units as handed over. A withdrawal is recorded only
-- while the pickup is Pending or Ready and nothing of it was handed over; it never changes the
-- pickup phase or its version (the kitchen still finishes or clears the line).
CREATE TABLE rms_fulfillment.fulfillment_item_withdrawal (
  fulfillment_item_withdrawal_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_id platform_helpers.uuid_v7 NOT NULL,
  fulfillment_item_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  order_batch_id platform_helpers.uuid_v7 NOT NULL,
  order_item_id platform_helpers.uuid_v7 NOT NULL,
  order_withdrawal_id platform_helpers.uuid_v7 NOT NULL,
  withdrawn_quantity integer NOT NULL CHECK (withdrawn_quantity BETWEEN 1 AND 999),
  actor_type text NOT NULL CHECK (actor_type = 'User'),
  actor_id platform_helpers.uuid_v7 NOT NULL,
  reason_code text NOT NULL CHECK (reason_code = 'REFUNDED_NOT_PROVIDED'),
  phase text NOT NULL CHECK (phase IN ('Pending', 'Ready')),
  audit_id platform_helpers.uuid_v7 NOT NULL,
  withdrawn_at timestamp with time zone NOT NULL
    CHECK (isfinite(withdrawn_at) AND withdrawn_at = date_trunc('milliseconds', withdrawn_at)),
  data_classification text NOT NULL CHECK (data_classification = 'IndirectIdentifier'),
  CONSTRAINT fulfillment_item_withdrawal_pkey
    PRIMARY KEY (brand_id, store_id, fulfillment_item_withdrawal_id),
  CONSTRAINT fulfillment_item_withdrawal_parent_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_id)
    REFERENCES rms_fulfillment.fulfillment (brand_id, store_id, fulfillment_id),
  CONSTRAINT fulfillment_item_withdrawal_item_fkey
    FOREIGN KEY (brand_id, store_id, fulfillment_item_id)
    REFERENCES rms_fulfillment.fulfillment_item (brand_id, store_id, fulfillment_item_id),
  -- One Ordering withdrawal (one refunded line of one refund request) is recorded once.
  CONSTRAINT fulfillment_item_withdrawal_order_withdrawal_unique
    UNIQUE (brand_id, store_id, order_withdrawal_id),
  CONSTRAINT fulfillment_item_withdrawal_distinct_check CHECK (
    fulfillment_item_withdrawal_id::uuid <> operation_id::uuid
    AND fulfillment_item_withdrawal_id::uuid <> audit_id::uuid
    AND fulfillment_item_withdrawal_id::uuid <> order_withdrawal_id::uuid
    AND operation_id::uuid <> audit_id::uuid
  )
);
CREATE INDEX fulfillment_item_withdrawal_history_idx
  ON rms_fulfillment.fulfillment_item_withdrawal (brand_id, store_id, fulfillment_id);

-- The line belongs to this pickup and Order, was not cancelled, the pickup was not closed or
-- handed over (in part or whole), and all withdrawals of the line never exceed what was ordered.
CREATE FUNCTION rms_fulfillment.check_fulfillment_item_withdrawal() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  ordered integer;
BEGIN
  SELECT i.ordered_quantity INTO ordered
  FROM rms_fulfillment.fulfillment f
  JOIN rms_fulfillment.fulfillment_item i
    ON i.brand_id = f.brand_id AND i.store_id = f.store_id AND i.fulfillment_id = f.fulfillment_id
  WHERE f.brand_id = NEW.brand_id AND f.store_id = NEW.store_id
    AND f.fulfillment_id = NEW.fulfillment_id AND f.order_id = NEW.order_id
    AND f.order_batch_id = NEW.order_batch_id
    AND i.fulfillment_item_id = NEW.fulfillment_item_id AND i.order_item_id = NEW.order_item_id;
  IF ordered IS NULL THEN
    RAISE EXCEPTION 'fulfillment item withdrawal does not match the pickup line' USING ERRCODE = '23514';
  END IF;
  IF ordered < NEW.withdrawn_quantity + COALESCE((
    SELECT sum(w.withdrawn_quantity) FROM rms_fulfillment.fulfillment_item_withdrawal w
    WHERE w.brand_id = NEW.brand_id AND w.store_id = NEW.store_id
      AND w.fulfillment_item_id = NEW.fulfillment_item_id), 0)
  THEN
    RAISE EXCEPTION 'withdrawal exceeds the pickup line' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM rms_fulfillment.fulfillment_item_cancellation c
    WHERE c.brand_id = NEW.brand_id AND c.store_id = NEW.store_id
      AND c.fulfillment_item_id = NEW.fulfillment_item_id
  ) OR EXISTS (
    SELECT 1 FROM rms_fulfillment.pickup_handoff_operation h
    WHERE h.brand_id = NEW.brand_id AND h.store_id = NEW.store_id
      AND h.fulfillment_id = NEW.fulfillment_id
  ) OR EXISTS (
    SELECT 1 FROM rms_fulfillment.pickup_not_collected_record n
    WHERE n.brand_id = NEW.brand_id AND n.store_id = NEW.store_id
      AND n.fulfillment_id = NEW.fulfillment_id
  ) THEN
    RAISE EXCEPTION 'only a pickup line not handed over can be withdrawn' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_fulfillment.check_fulfillment_item_withdrawal() FROM PUBLIC;
CREATE TRIGGER fulfillment_item_withdrawal_check_trigger
  BEFORE INSERT ON rms_fulfillment.fulfillment_item_withdrawal
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.check_fulfillment_item_withdrawal();

CREATE TRIGGER fulfillment_item_withdrawal_no_update_trigger
  BEFORE UPDATE ON rms_fulfillment.fulfillment_item_withdrawal
  FOR EACH ROW EXECUTE FUNCTION rms_fulfillment.reject_fulfillment_append_only_update();
CREATE RULE fulfillment_item_withdrawal_no_delete AS
  ON DELETE TO rms_fulfillment.fulfillment_item_withdrawal DO INSTEAD NOTHING;
ALTER TABLE rms_fulfillment.fulfillment_item_withdrawal ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_fulfillment.fulfillment_item_withdrawal FORCE ROW LEVEL SECURITY;
CREATE POLICY fulfillment_item_withdrawal_store_scope_policy
  ON rms_fulfillment.fulfillment_item_withdrawal
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_fulfillment.fulfillment_item_withdrawal FROM PUBLIC;
