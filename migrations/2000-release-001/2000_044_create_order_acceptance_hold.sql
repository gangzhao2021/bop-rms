-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q9-G1 (DEC-OUTAGE-ACCEPTANCE-HOLD): a paid online pickup order whose acceptance deadline
-- passed while the Store was offline is not closed and refunded automatically. Ordering records the
-- hold (which deadline passed, and when staff were last active before it). When staff are back
-- online, the deadline becomes the time the Store came back plus 15 minutes; a manager may instead
-- choose to refund at once. If that new deadline also passes while the Store is offline, the next
-- hold continues the chain. Rows are append-only and are written only while the order batch has no
-- acceptance and no payment outcome.
CREATE TABLE rms_ordering.order_acceptance_hold (
 hold_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 order_batch_id platform_helpers.uuid_v7 NOT NULL,
 payment_event_id platform_helpers.uuid_v7 NOT NULL,
 hold_sequence integer NOT NULL CHECK (hold_sequence BETWEEN 1 AND 1000),
 lapsed_deadline timestamptz NOT NULL CHECK (isfinite(lapsed_deadline) AND lapsed_deadline=date_trunc('milliseconds',lapsed_deadline)),
 store_last_seen_at timestamptz CHECK (store_last_seen_at IS NULL OR (isfinite(store_last_seen_at)
  AND store_last_seen_at=date_trunc('milliseconds',store_last_seen_at)
  AND store_last_seen_at < lapsed_deadline - interval '5 minutes')),
 held_at timestamptz NOT NULL CHECK (isfinite(held_at) AND held_at=date_trunc('milliseconds',held_at)),
 CONSTRAINT order_acceptance_hold_pk PRIMARY KEY (brand_id,store_id,hold_id),
 CONSTRAINT order_acceptance_hold_sequence UNIQUE (brand_id,store_id,order_batch_id,hold_sequence),
 CONSTRAINT order_acceptance_hold_time CHECK (held_at >= lapsed_deadline),
 CONSTRAINT order_acceptance_hold_batch_fk FOREIGN KEY (order_batch_id,order_id,brand_id,store_id)
  REFERENCES rms_ordering.order_batch(order_batch_id,order_id,brand_id,store_id)
);
CREATE INDEX order_acceptance_hold_order_idx
 ON rms_ordering.order_acceptance_hold (brand_id,store_id,order_id,hold_sequence DESC);

CREATE TABLE rms_ordering.order_acceptance_hold_resolution (
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 hold_id platform_helpers.uuid_v7 NOT NULL,
 resolution text NOT NULL CHECK (resolution IN ('StoreBackOnline','StaffRefund')),
 store_back_online_at timestamptz CHECK (store_back_online_at IS NULL OR (isfinite(store_back_online_at)
  AND store_back_online_at=date_trunc('milliseconds',store_back_online_at))),
 decide_by timestamptz NOT NULL CHECK (isfinite(decide_by) AND decide_by=date_trunc('milliseconds',decide_by)),
 actor_id platform_helpers.uuid_v7,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 CONSTRAINT order_acceptance_hold_resolution_pk PRIMARY KEY (brand_id,store_id,hold_id,resolution),
 CONSTRAINT order_acceptance_hold_resolution_hold_fk FOREIGN KEY (brand_id,store_id,hold_id)
  REFERENCES rms_ordering.order_acceptance_hold(brand_id,store_id,hold_id),
 CONSTRAINT order_acceptance_hold_resolution_shape CHECK (
  (resolution='StoreBackOnline' AND store_back_online_at IS NOT NULL AND actor_id IS NULL
   AND decide_by = store_back_online_at + interval '15 minutes' AND recorded_at >= store_back_online_at)
  OR (resolution='StaffRefund' AND store_back_online_at IS NULL AND actor_id IS NOT NULL
   AND decide_by = recorded_at))
);

-- A hold or resolution is written only while the batch is still open (no acceptance, no payment
-- outcome), and a hold continues the chain: hold N+1 starts at the deadline hold N ended with.
CREATE FUNCTION rms_ordering.check_order_acceptance_hold() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
 hold rms_ordering.order_acceptance_hold%ROWTYPE;
 previous_deadline timestamptz;
BEGIN
 IF TG_TABLE_NAME = 'order_acceptance_hold' THEN
  hold := NEW;
 ELSE
  SELECT * INTO hold FROM rms_ordering.order_acceptance_hold h
  WHERE h.brand_id=NEW.brand_id AND h.store_id=NEW.store_id AND h.hold_id=NEW.hold_id;
  IF NOT FOUND THEN
   RAISE EXCEPTION 'order acceptance hold is missing' USING ERRCODE='23503';
  END IF;
  IF NEW.recorded_at < hold.held_at
   OR (NEW.store_back_online_at IS NOT NULL AND NEW.store_back_online_at <= hold.lapsed_deadline)
   OR EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_hold later
    WHERE later.brand_id=hold.brand_id AND later.store_id=hold.store_id
     AND later.order_batch_id=hold.order_batch_id AND later.hold_sequence > hold.hold_sequence) THEN
   RAISE EXCEPTION 'order acceptance hold resolution is not current' USING ERRCODE='23514';
  END IF;
 END IF;
 IF EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record a
   WHERE a.brand_id=hold.brand_id AND a.store_id=hold.store_id AND a.order_id=hold.order_id
    AND a.order_batch_id=hold.order_batch_id)
  OR EXISTS (SELECT 1 FROM rms_ordering.order_payment_disposition_record d
   WHERE d.brand_id=hold.brand_id AND d.store_id=hold.store_id AND d.order_id=hold.order_id
    AND d.order_batch_id=hold.order_batch_id) THEN
  RAISE EXCEPTION 'order batch is no longer awaiting acceptance' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME = 'order_acceptance_hold' AND hold.hold_sequence > 1 THEN
  SELECT min(r.decide_by) INTO previous_deadline
  FROM rms_ordering.order_acceptance_hold p
  JOIN rms_ordering.order_acceptance_hold_resolution r
   ON r.brand_id=p.brand_id AND r.store_id=p.store_id AND r.hold_id=p.hold_id
  WHERE p.brand_id=hold.brand_id AND p.store_id=hold.store_id AND p.order_batch_id=hold.order_batch_id
   AND p.order_id=hold.order_id AND p.payment_event_id=hold.payment_event_id
   AND p.hold_sequence=hold.hold_sequence-1;
  IF previous_deadline IS NULL OR previous_deadline <> hold.lapsed_deadline
   OR EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_hold p
    JOIN rms_ordering.order_acceptance_hold_resolution r
     ON r.brand_id=p.brand_id AND r.store_id=p.store_id AND r.hold_id=p.hold_id
    WHERE p.brand_id=hold.brand_id AND p.store_id=hold.store_id AND p.order_batch_id=hold.order_batch_id
     AND p.hold_sequence=hold.hold_sequence-1 AND r.resolution='StaffRefund') THEN
   RAISE EXCEPTION 'order acceptance hold does not continue the previous deadline' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.check_order_acceptance_hold() FROM PUBLIC;
CREATE TRIGGER order_acceptance_hold_check BEFORE INSERT ON rms_ordering.order_acceptance_hold
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.check_order_acceptance_hold();
CREATE TRIGGER order_acceptance_hold_resolution_check BEFORE INSERT ON rms_ordering.order_acceptance_hold_resolution
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.check_order_acceptance_hold();

CREATE FUNCTION rms_ordering.reject_order_acceptance_hold_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only order acceptance hold' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.reject_order_acceptance_hold_mutation() FROM PUBLIC;
CREATE TRIGGER order_acceptance_hold_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.order_acceptance_hold
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_order_acceptance_hold_mutation();
CREATE TRIGGER order_acceptance_hold_resolution_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.order_acceptance_hold_resolution
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_order_acceptance_hold_mutation();

ALTER TABLE rms_ordering.order_acceptance_hold ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_acceptance_hold FORCE ROW LEVEL SECURITY;
CREATE POLICY order_acceptance_hold_scope ON rms_ordering.order_acceptance_hold
 USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
 WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_acceptance_hold FROM PUBLIC;
ALTER TABLE rms_ordering.order_acceptance_hold_resolution ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_acceptance_hold_resolution FORCE ROW LEVEL SECURITY;
CREATE POLICY order_acceptance_hold_resolution_scope ON rms_ordering.order_acceptance_hold_resolution
 USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
 WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_acceptance_hold_resolution FROM PUBLIC;
