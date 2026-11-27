-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-DINE-IN-PAY-LATER (Owner 2026-10-26): at a table opened "pay later", a round goes
-- straight to the kitchen when it is sent; the table pays once at the end. This record is that
-- confirmation: the round, the automatic acceptance it went with (the kitchen's checkpoint) and the
-- OrderConfirmed event. It is not a payment and says nothing was paid; the round stays owed until
-- the table is settled. One per round; never for a round already paid, waiting for acceptance,
-- cancelled or terminated, or for anything but a dine-in Order. Append-only.
-- Grants: api SELECT/INSERT (Owner standing approval 2026-10-14, WP-2423).
CREATE TABLE rms_ordering.order_pay_later_confirmation (
 confirmation_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 order_batch_id platform_helpers.uuid_v7 NOT NULL,
 submission_id platform_helpers.uuid_v7 NOT NULL,
 dining_session_id platform_helpers.uuid_v7 NOT NULL,
 acceptance_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 accepted_order_version integer NOT NULL CHECK (accepted_order_version > 1),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 source_snapshot_digest text NOT NULL CHECK (source_snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
 order_confirmed_event_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 confirmed_at timestamptz NOT NULL CHECK (isfinite(confirmed_at) AND confirmed_at=date_trunc('milliseconds',confirmed_at)),
 CONSTRAINT order_pay_later_confirmation_batch UNIQUE (brand_id,store_id,order_id,order_batch_id),
 CONSTRAINT order_pay_later_confirmation_operation UNIQUE (brand_id,store_id,operation_id),
 FOREIGN KEY (order_batch_id,order_id,brand_id,store_id)
  REFERENCES rms_ordering.order_batch(order_batch_id,order_id,brand_id,store_id),
 FOREIGN KEY (submission_id,brand_id,store_id,order_id)
  REFERENCES rms_ordering.order_submission_record(submission_id,brand_id,store_id,order_id),
 FOREIGN KEY (acceptance_id) REFERENCES rms_ordering.order_acceptance_record(acceptance_id)
);
CREATE INDEX order_pay_later_confirmation_session_idx
 ON rms_ordering.order_pay_later_confirmation (brand_id,store_id,dining_session_id);

CREATE FUNCTION rms_ordering.validate_order_pay_later_confirmation_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
 accepted rms_ordering.order_acceptance_record%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('OrderingOrderDisposition:'||NEW.brand_id||':'||NEW.store_id||':'||NEW.order_id,0));
 SELECT * INTO accepted FROM rms_ordering.order_acceptance_record WHERE acceptance_id=NEW.acceptance_id;
 IF NOT FOUND OR accepted.brand_id<>NEW.brand_id OR accepted.store_id<>NEW.store_id
 OR accepted.order_id<>NEW.order_id OR accepted.order_batch_id<>NEW.order_batch_id
 OR accepted.accepted_order_version<>NEW.accepted_order_version OR accepted.actor_type<>'System'
 OR NEW.confirmed_at<accepted.accepted_at THEN
  RAISE EXCEPTION 'pay-later confirmation acceptance mismatch' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_header h WHERE h.brand_id=NEW.brand_id AND h.store_id=NEW.store_id
   AND h.order_id=NEW.order_id AND h.order_type='DineIn' AND h.dining_session_id=NEW.dining_session_id)
 OR NOT EXISTS (SELECT 1 FROM rms_ordering.order_batch b WHERE b.brand_id=NEW.brand_id AND b.store_id=NEW.store_id
   AND b.order_id=NEW.order_id AND b.order_batch_id=NEW.order_batch_id AND b.submission_id=NEW.submission_id
   AND b.submitted_at<=NEW.confirmed_at) THEN
  RAISE EXCEPTION 'pay-later confirmation source mismatch' USING ERRCODE='23514';
 END IF;
 IF EXISTS (SELECT 1 FROM rms_ordering.order_payment_disposition_record d WHERE d.brand_id=NEW.brand_id
   AND d.store_id=NEW.store_id AND d.order_id=NEW.order_id AND d.order_batch_id=NEW.order_batch_id)
 OR EXISTS (SELECT 1 FROM rms_ordering.order_payment_acceptance_wait w WHERE w.brand_id=NEW.brand_id
   AND w.store_id=NEW.store_id AND w.order_id=NEW.order_id AND w.order_batch_id=NEW.order_batch_id)
 OR EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_cancellation c WHERE c.brand_id=NEW.brand_id
   AND c.store_id=NEW.store_id AND c.order_batch_id=NEW.order_batch_id)
 OR EXISTS (SELECT 1 FROM rms_ordering.order_staff_cancellation s WHERE s.brand_id=NEW.brand_id
   AND s.store_id=NEW.store_id AND s.order_id=NEW.order_id AND s.order_batch_id=NEW.order_batch_id)
 OR EXISTS (SELECT 1 FROM rms_ordering.order_termination_record t WHERE t.brand_id=NEW.brand_id
   AND t.store_id=NEW.store_id AND t.order_id=NEW.order_id) THEN
  RAISE EXCEPTION 'pay-later confirmation conflicts with payment or cancellation' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.validate_order_pay_later_confirmation_insert() FROM PUBLIC;
CREATE TRIGGER order_pay_later_confirmation_source BEFORE INSERT ON rms_ordering.order_pay_later_confirmation
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_order_pay_later_confirmation_insert();

-- A round sent to the kitchen without payment is never closed as "not paid in time".
CREATE FUNCTION rms_ordering.reject_pay_later_checkout_cancellation() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM rms_ordering.order_pay_later_confirmation p WHERE p.brand_id=NEW.brand_id
   AND p.store_id=NEW.store_id AND p.order_batch_id=NEW.order_batch_id) THEN
  RAISE EXCEPTION 'pay-later round cannot expire unpaid' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.reject_pay_later_checkout_cancellation() FROM PUBLIC;
CREATE TRIGGER order_batch_checkout_cancellation_not_pay_later BEFORE INSERT ON rms_ordering.order_batch_checkout_cancellation
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_pay_later_checkout_cancellation();

CREATE FUNCTION rms_ordering.reject_order_pay_later_confirmation_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only pay-later confirmation' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.reject_order_pay_later_confirmation_mutation() FROM PUBLIC;
CREATE TRIGGER order_pay_later_confirmation_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.order_pay_later_confirmation
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_order_pay_later_confirmation_mutation();
CREATE TRIGGER order_pay_later_confirmation_no_truncate BEFORE TRUNCATE ON rms_ordering.order_pay_later_confirmation
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_order_pay_later_confirmation_mutation();

ALTER TABLE rms_ordering.order_pay_later_confirmation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_pay_later_confirmation FORCE ROW LEVEL SECURITY;
CREATE POLICY order_pay_later_confirmation_scope ON rms_ordering.order_pay_later_confirmation
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_pay_later_confirmation FROM PUBLIC;
