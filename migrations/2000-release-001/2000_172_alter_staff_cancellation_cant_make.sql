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
-- back an automatically accepted one the kitchen has not marked started: what is left of the payment
-- goes to the card that paid, with a reason, in their name (nothing, when ordinary refunds already
-- returned it all). The record names the permission actually used, so it may now
-- be ordering.order.accept, and only for an automatically accepted batch. A pickup the kitchen never
-- touched closes by itself: its termination then says System, with no person, only for such a batch
-- (the cancellation row's actor column requires one: the reserved System actor). Other cancellations
-- and history are unchanged.
ALTER TABLE rms_ordering.order_staff_cancellation
 DROP CONSTRAINT order_staff_cancellation_permission_code_check;
ALTER TABLE rms_ordering.order_staff_cancellation
 ADD CONSTRAINT order_staff_cancellation_permission_code_check
 CHECK (permission_code IN ('ordering.order.cancel','ordering.order.accept'));

CREATE OR REPLACE FUNCTION rms_ordering.validate_order_staff_cancellation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE latest rms_ordering.order_revision%ROWTYPE;
DECLARE members uuid[];
DECLARE header_type text;
BEGIN
 SELECT order_type INTO header_type FROM rms_ordering.order_header WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id
  AND order_id=NEW.order_id FOR UPDATE;
 IF NOT FOUND OR header_type IS DISTINCT FROM NEW.order_type
 THEN RAISE EXCEPTION 'invalid staff cancellation order' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_batch WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id
  AND order_id=NEW.order_id AND order_batch_id=NEW.order_batch_id AND submission_id=NEW.submission_id
  AND submitted_at<=NEW.cancelled_at)
 THEN RAISE EXCEPTION 'invalid staff cancellation batch' USING ERRCODE='23514'; END IF;
 SELECT * INTO latest FROM rms_ordering.order_revision WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id
  AND order_id=NEW.order_id ORDER BY version DESC LIMIT 1;
 IF latest.revision_id IS NULL OR latest.revision_id<>NEW.cancellation_id
  OR latest.kind<>(CASE NEW.order_type WHEN 'Pickup' THEN 'Termination' ELSE 'StaffBatchCancellation' END)
  OR latest.version<>NEW.cancelled_order_version OR latest.expected_version<>NEW.expected_order_version
  OR latest.previous_revision_id IS DISTINCT FROM NEW.expected_source_checkpoint OR latest.occurred_at<>NEW.cancelled_at
 THEN RAISE EXCEPTION 'stale staff cancellation revision' USING ERRCODE='23514'; END IF;
 IF NEW.order_type='Pickup' THEN
  IF (SELECT count(*) FROM rms_ordering.order_batch WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id
   AND order_id=NEW.order_id)<>1
  OR NOT EXISTS (SELECT 1 FROM rms_ordering.order_termination_record t WHERE t.termination_id=NEW.cancellation_id
   AND t.operation_id=NEW.operation_id AND t.brand_id=NEW.brand_id AND t.store_id=NEW.store_id
   AND t.order_id=NEW.order_id AND t.order_batch_id=NEW.order_batch_id
   AND t.expected_order_version=NEW.expected_order_version AND t.terminated_order_version=NEW.cancelled_order_version
   AND t.expected_source_checkpoint=NEW.expected_source_checkpoint AND t.previous_phase=NEW.previous_phase
   AND t.phase=(CASE NEW.previous_phase WHEN 'Submitted' THEN 'Rejected' ELSE 'Cancelled' END)
   AND ((t.actor_type='User' AND t.actor_id=NEW.actor_id)
    OR (t.actor_type='System' AND t.actor_id IS NULL AND NEW.previous_phase='Accepted'
     AND EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record a WHERE a.brand_id=NEW.brand_id
      AND a.store_id=NEW.store_id AND a.order_id=NEW.order_id AND a.order_batch_id=NEW.order_batch_id
      AND a.actor_type='System' AND a.reason_code='STORE_AUTO_ACCEPT_PAID')))
   AND t.purpose_code='StaffOrderCancellation' AND t.permission_code=NEW.permission_code
   AND t.reason_code=NEW.reason_code AND t.terminated_at=NEW.cancelled_at)
  THEN RAISE EXCEPTION 'invalid staff cancellation termination' USING ERRCODE='23514'; END IF;
 ELSIF EXISTS (SELECT 1 FROM rms_ordering.order_termination_record WHERE brand_id=NEW.brand_id
  AND store_id=NEW.store_id AND order_id=NEW.order_id)
 THEN RAISE EXCEPTION 'staff cancellation state conflict' USING ERRCODE='23514'; END IF;
 IF (SELECT status FROM rms_ordering.order_closure_version WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id
  AND order_id=NEW.order_id ORDER BY closure_version DESC LIMIT 1)='Closed'
  OR EXISTS (SELECT 1 FROM rms_ordering.order_fulfillment_completion_record WHERE brand_id=NEW.brand_id
   AND store_id=NEW.store_id AND order_id=NEW.order_id)
  OR EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_cancellation WHERE brand_id=NEW.brand_id
   AND store_id=NEW.store_id AND order_id=NEW.order_id AND order_batch_id=NEW.order_batch_id)
 THEN RAISE EXCEPTION 'staff cancellation state conflict' USING ERRCODE='23514'; END IF;
 IF NEW.previous_phase='Accepted' THEN
  IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record WHERE brand_id=NEW.brand_id
   AND store_id=NEW.store_id AND order_id=NEW.order_id AND order_batch_id=NEW.order_batch_id
   AND accepted_order_version<=NEW.expected_order_version AND accepted_at<=NEW.cancelled_at)
  THEN RAISE EXCEPTION 'staff cancellation batch not accepted' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_payment_disposition_record d
   WHERE d.disposition_id=NEW.payment_disposition_id AND d.brand_id=NEW.brand_id AND d.store_id=NEW.store_id
    AND d.order_id=NEW.order_id AND d.order_batch_id=NEW.order_batch_id AND d.submission_id=NEW.submission_id
    AND d.payment_transaction_id=NEW.payment_transaction_id AND d.payment_intent_id=NEW.payment_intent_id
    AND d.payment_attempt_id=NEW.payment_attempt_id AND d.payment_event_id=NEW.payment_event_id
    AND d.disposition='Confirmed' AND d.confirmed_at<=NEW.cancelled_at)
  THEN RAISE EXCEPTION 'staff cancellation payment not confirmed' USING ERRCODE='23514'; END IF;
 ELSE
  -- Paid but never accepted: no acceptance, no disposition yet, exactly the recorded payment wait.
  IF EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record WHERE brand_id=NEW.brand_id
   AND store_id=NEW.store_id AND order_id=NEW.order_id AND order_batch_id=NEW.order_batch_id)
  OR EXISTS (SELECT 1 FROM rms_ordering.order_payment_disposition_record d WHERE d.brand_id=NEW.brand_id
   AND d.store_id=NEW.store_id AND d.order_id=NEW.order_id AND d.order_batch_id=NEW.order_batch_id)
  THEN RAISE EXCEPTION 'staff cancellation batch already accepted or disposed' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_payment_acceptance_wait w
   WHERE w.wait_id=NEW.payment_disposition_id AND w.brand_id=NEW.brand_id AND w.store_id=NEW.store_id
    AND w.order_id=NEW.order_id AND w.order_batch_id=NEW.order_batch_id AND w.submission_id=NEW.submission_id
    AND w.payment_event_id=NEW.payment_event_id
    AND w.record_json->>'paymentTransactionReference'=NEW.payment_transaction_id::text
    AND w.record_json->>'paymentIntentReference'=NEW.payment_intent_id::text
    AND w.record_json->>'paymentAttemptReference'=NEW.payment_attempt_id::text
    AND w.evaluated_at<=NEW.cancelled_at)
  THEN RAISE EXCEPTION 'staff cancellation payment wait missing' USING ERRCODE='23514'; END IF;
 END IF;
 SELECT array_agg(order_item_id::uuid ORDER BY order_item_id) INTO members FROM rms_ordering.order_item
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND order_id=NEW.order_id AND order_batch_id=NEW.order_batch_id;
 IF members IS NULL OR members IS DISTINCT FROM NEW.order_item_ids
 THEN RAISE EXCEPTION 'invalid staff cancellation item membership' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE FUNCTION rms_ordering.validate_order_staff_cancellation_cant_make() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NEW.previous_phase<>'Accepted'
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
