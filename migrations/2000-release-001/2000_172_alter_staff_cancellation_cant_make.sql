-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT: "Can't make it · refund". Whoever can accept an order may give
-- back an automatically accepted one the kitchen has not started: a full refund to the card that
-- paid, with a reason, in their name. The record names the permission actually used, so it may now
-- be ordering.order.accept, and only for an automatically accepted batch. Other cancellations and
-- history are unchanged.
ALTER TABLE rms_ordering.order_staff_cancellation
 DROP CONSTRAINT order_staff_cancellation_permission_code_check;
ALTER TABLE rms_ordering.order_staff_cancellation
 ADD CONSTRAINT order_staff_cancellation_permission_code_check
 CHECK (permission_code IN ('ordering.order.cancel','ordering.order.accept'));

CREATE FUNCTION rms_ordering.validate_order_staff_cancellation_cant_make() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NEW.previous_phase<>'Accepted' OR NEW.refund_disposition<>'Refund'
  OR NOT EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record a WHERE a.brand_id=NEW.brand_id
   AND a.store_id=NEW.store_id AND a.order_id=NEW.order_id AND a.order_batch_id=NEW.order_batch_id
   AND a.actor_type='System' AND a.reason_code='STORE_AUTO_ACCEPT_PAID')
 THEN RAISE EXCEPTION 'only an automatically accepted batch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER order_staff_cancellation_cant_make BEFORE INSERT ON rms_ordering.order_staff_cancellation
 FOR EACH ROW WHEN (NEW.permission_code='ordering.order.accept')
 EXECUTE FUNCTION rms_ordering.validate_order_staff_cancellation_cant_make();
REVOKE ALL ON FUNCTION rms_ordering.validate_order_staff_cancellation_cant_make() FROM PUBLIC;
