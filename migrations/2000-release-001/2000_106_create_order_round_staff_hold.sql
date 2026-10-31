-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 item 8 ⑤ DEC-DINING-QR-JOIN decisions 5–7 (Owner 2026-10-28, decisions 1 and 17): at a
-- table that pays at the end, a guest's round can wait for staff before it goes to the kitchen —
-- a new phone's first round when the Store asks for that, a phone's 4th round or the table's 7th
-- within 10 minutes. The hold records that the round waits and why; the release records which
-- staff member sent it to the kitchen (Confirmed) or cancelled it (Cancelled, with the existing
-- unpaid round cancellation, so it is never owed and never sales). A held round is never sent to
-- the kitchen or cancelled without its release, and nothing releases it automatically.
-- Append-only, Store RLS.
-- Grants: api SELECT/INSERT on both tables (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_ordering.order_round_staff_hold (
 hold_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 order_batch_id platform_helpers.uuid_v7 NOT NULL,
 submission_id platform_helpers.uuid_v7 NOT NULL,
 guest_session_id platform_helpers.uuid_v7 NOT NULL,
 reason text NOT NULL CHECK (reason IN ('FirstOrder','PhoneRapid','TableRapid')),
 held_at timestamptz NOT NULL CHECK (isfinite(held_at) AND held_at=date_trunc('milliseconds',held_at)),
 CONSTRAINT order_round_staff_hold_batch UNIQUE (brand_id,store_id,order_batch_id),
 FOREIGN KEY (order_batch_id,order_id,brand_id,store_id)
  REFERENCES rms_ordering.order_batch(order_batch_id,order_id,brand_id,store_id)
);
CREATE INDEX order_round_staff_hold_order_idx
 ON rms_ordering.order_round_staff_hold (brand_id,store_id,order_id);

CREATE TABLE rms_ordering.order_round_staff_hold_release (
 operation_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 order_batch_id platform_helpers.uuid_v7 NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('Confirmed','Cancelled')),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 released_at timestamptz NOT NULL CHECK (isfinite(released_at) AND released_at=date_trunc('milliseconds',released_at)),
 PRIMARY KEY (brand_id,store_id,operation_id),
 CONSTRAINT order_round_staff_hold_release_batch UNIQUE (brand_id,store_id,order_batch_id),
 FOREIGN KEY (brand_id,store_id,order_batch_id)
  REFERENCES rms_ordering.order_round_staff_hold(brand_id,store_id,order_batch_id)
);

-- A hold only for a dine-in round of this submission that is still only submitted: not accepted,
-- not sent to the kitchen, not paid, not cancelled.
CREATE FUNCTION rms_ordering.validate_order_round_staff_hold() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('OrderingOrderDisposition:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.order_id,0));
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_header h WHERE h.brand_id=NEW.brand_id AND h.store_id=NEW.store_id
   AND h.order_id=NEW.order_id AND h.order_type='DineIn')
  OR NOT EXISTS (SELECT 1 FROM rms_ordering.order_batch b WHERE b.brand_id=NEW.brand_id AND b.store_id=NEW.store_id
   AND b.order_id=NEW.order_id AND b.order_batch_id=NEW.order_batch_id AND b.submission_id=NEW.submission_id
   AND b.submitted_at<=NEW.held_at) THEN
  RAISE EXCEPTION 'invalid held round' USING ERRCODE='23514';
 END IF;
 IF EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record a WHERE a.brand_id=NEW.brand_id AND a.store_id=NEW.store_id
   AND a.order_id=NEW.order_id AND a.order_batch_id=NEW.order_batch_id)
  OR EXISTS (SELECT 1 FROM rms_ordering.order_pay_later_confirmation p WHERE p.brand_id=NEW.brand_id AND p.store_id=NEW.store_id
   AND p.order_batch_id=NEW.order_batch_id)
  OR EXISTS (SELECT 1 FROM rms_ordering.order_payment_disposition_record d WHERE d.brand_id=NEW.brand_id AND d.store_id=NEW.store_id
   AND d.order_id=NEW.order_id AND d.order_batch_id=NEW.order_batch_id)
  OR EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_cancellation c WHERE c.brand_id=NEW.brand_id AND c.store_id=NEW.store_id
   AND c.order_batch_id=NEW.order_batch_id)
  OR EXISTS (SELECT 1 FROM rms_ordering.order_termination_record t WHERE t.brand_id=NEW.brand_id AND t.store_id=NEW.store_id
   AND t.order_id=NEW.order_id) THEN
  RAISE EXCEPTION 'round already decided' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER order_round_staff_hold_source BEFORE INSERT ON rms_ordering.order_round_staff_hold
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_order_round_staff_hold();

-- A release names its own round; Confirmed goes with the round's pay-later confirmation and
-- Cancelled with its staff unpaid round cancellation, both in the same transaction.
CREATE FUNCTION rms_ordering.validate_order_round_staff_hold_release() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_round_staff_hold h WHERE h.brand_id=NEW.brand_id AND h.store_id=NEW.store_id
   AND h.order_id=NEW.order_id AND h.order_batch_id=NEW.order_batch_id AND h.held_at<=NEW.released_at) THEN
  RAISE EXCEPTION 'invalid hold release' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER order_round_staff_hold_release_source BEFORE INSERT ON rms_ordering.order_round_staff_hold_release
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_order_round_staff_hold_release();

CREATE FUNCTION rms_ordering.check_order_round_staff_hold_release() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF (NEW.outcome='Confirmed' AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_pay_later_confirmation p
   WHERE p.brand_id=NEW.brand_id AND p.store_id=NEW.store_id AND p.order_id=NEW.order_id AND p.order_batch_id=NEW.order_batch_id))
  OR (NEW.outcome='Cancelled' AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_cancellation c
   WHERE c.brand_id=NEW.brand_id AND c.store_id=NEW.store_id AND c.order_id=NEW.order_id AND c.order_batch_id=NEW.order_batch_id
    AND c.reason_code='STAFF_CANCELLED_UNPAID')) THEN
  RAISE EXCEPTION 'hold release without its outcome' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER order_round_staff_hold_release_outcome AFTER INSERT ON rms_ordering.order_round_staff_hold_release
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_ordering.check_order_round_staff_hold_release();

-- A held round reaches the kitchen only through a Confirmed release, and is cancelled only through
-- a Cancelled one (never by the payment window's automatic cancellation).
CREATE FUNCTION rms_ordering.require_order_round_staff_release() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM rms_ordering.order_round_staff_hold h WHERE h.brand_id=NEW.brand_id AND h.store_id=NEW.store_id
   AND h.order_batch_id=NEW.order_batch_id)
  AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_round_staff_hold_release r WHERE r.brand_id=NEW.brand_id
   AND r.store_id=NEW.store_id AND r.order_batch_id=NEW.order_batch_id
   AND r.outcome=CASE WHEN TG_TABLE_NAME='order_pay_later_confirmation' THEN 'Confirmed' ELSE 'Cancelled' END) THEN
  RAISE EXCEPTION 'round is waiting for staff' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER order_pay_later_confirmation_staff_hold BEFORE INSERT ON rms_ordering.order_pay_later_confirmation
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.require_order_round_staff_release();
CREATE TRIGGER order_batch_checkout_cancellation_staff_hold BEFORE INSERT ON rms_ordering.order_batch_checkout_cancellation
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.require_order_round_staff_release();

CREATE FUNCTION rms_ordering.reject_order_round_staff_hold_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only round hold' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER order_round_staff_hold_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.order_round_staff_hold
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_order_round_staff_hold_mutation();
CREATE TRIGGER order_round_staff_hold_no_truncate BEFORE TRUNCATE ON rms_ordering.order_round_staff_hold
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_order_round_staff_hold_mutation();
CREATE TRIGGER order_round_staff_hold_release_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.order_round_staff_hold_release
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_order_round_staff_hold_mutation();
CREATE TRIGGER order_round_staff_hold_release_no_truncate BEFORE TRUNCATE ON rms_ordering.order_round_staff_hold_release
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_order_round_staff_hold_mutation();

ALTER TABLE rms_ordering.order_round_staff_hold ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_round_staff_hold FORCE ROW LEVEL SECURITY;
CREATE POLICY order_round_staff_hold_scope ON rms_ordering.order_round_staff_hold
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
ALTER TABLE rms_ordering.order_round_staff_hold_release ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_round_staff_hold_release FORCE ROW LEVEL SECURITY;
CREATE POLICY order_round_staff_hold_release_scope ON rms_ordering.order_round_staff_hold_release
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_round_staff_hold FROM PUBLIC;
REVOKE ALL ON TABLE rms_ordering.order_round_staff_hold_release FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.validate_order_round_staff_hold() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.validate_order_round_staff_hold_release() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.check_order_round_staff_hold_release() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.require_order_round_staff_release() FROM PUBLIC;
REVOKE ALL ON FUNCTION rms_ordering.reject_order_round_staff_hold_mutation() FROM PUBLIC;
