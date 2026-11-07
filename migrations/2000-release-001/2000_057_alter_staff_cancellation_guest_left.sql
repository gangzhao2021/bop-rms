-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 table closure (DEC-TABLE-CLOSE-GUESTS-LEFT, Owner 2026-10-15: only Owner and Store
-- Manager close table sessions): a manager closes a table whose guests have left. Each round still
-- open is resolved with the existing staff cancellations, with the reason GUEST_LEFT:
-- * a dine-in round the guest paid for that was never accepted (it never reached the kitchen) can
--   now be cancelled by staff too (previous_phase 'Submitted'). Its payment is the one Ordering
--   recorded as waiting for acceptance (order_payment_acceptance_wait, whose wait_id is the waiting
--   disposition reference), so the payment link is checked here instead of by a foreign key to the
--   Confirmed disposition, which such a round never has.
-- * refund_disposition 'AlreadyRefunded': the round's payment was already refunded in full by an
--   ordinary refund before the cancellation, so Payment owes nothing more and no compensation is
--   opened for it (only for a never-accepted round; the application proves it from Payment under
--   the Order fence). Every earlier record keeps 'Refund'.
-- Append-only: existing rows are unchanged; no new table or grant.
ALTER TABLE rms_ordering.order_staff_cancellation
 DROP CONSTRAINT order_staff_cancellation_reason_code_check;
ALTER TABLE rms_ordering.order_staff_cancellation
 ADD CONSTRAINT order_staff_cancellation_reason_code_check
 CHECK (reason_code IN ('CUSTOMER_REQUEST','SOLD_OUT','STORE_ERROR','DUPLICATE_ORDER','GUEST_LEFT'));
ALTER TABLE rms_ordering.order_staff_cancellation
 DROP CONSTRAINT order_staff_cancellation_previous_phase_check;
ALTER TABLE rms_ordering.order_staff_cancellation
 ADD CONSTRAINT order_staff_cancellation_previous_phase_check
 CHECK (previous_phase IN ('Accepted','Submitted'));
-- A never-accepted first round of a table may be the Order's only revision (version 1).
ALTER TABLE rms_ordering.order_staff_cancellation
 DROP CONSTRAINT order_staff_cancellation_expected_order_version_check;
ALTER TABLE rms_ordering.order_staff_cancellation
 ADD CONSTRAINT order_staff_cancellation_expected_order_version_check
 CHECK (expected_order_version>=1 AND expected_order_version<2147483647
  AND (expected_order_version>1 OR previous_phase='Submitted'));
ALTER TABLE rms_ordering.order_staff_cancellation
 DROP CONSTRAINT order_staff_cancellation_payment_disposition_id_fkey;
ALTER TABLE rms_ordering.order_staff_cancellation
 ADD COLUMN refund_disposition text NOT NULL DEFAULT 'Refund'
 CHECK (refund_disposition IN ('Refund','AlreadyRefunded'));
ALTER TABLE rms_ordering.order_staff_cancellation
 ADD CONSTRAINT order_staff_cancellation_refund_disposition_phase
 CHECK (refund_disposition='Refund' OR (previous_phase='Submitted' AND order_type='DineIn'));
ALTER TABLE rms_ordering.order_staff_cancellation
 ADD CONSTRAINT order_staff_cancellation_submitted_dine_in
 CHECK (previous_phase='Accepted' OR order_type='DineIn');

ALTER TABLE rms_ordering.order_item_staff_cancellation
 DROP CONSTRAINT order_item_staff_cancellation_reason_code_check;
ALTER TABLE rms_ordering.order_item_staff_cancellation
 ADD CONSTRAINT order_item_staff_cancellation_reason_code_check
 CHECK (reason_code IN ('CUSTOMER_REQUEST','SOLD_OUT','STORE_ERROR','DUPLICATE_ORDER','GUEST_LEFT'));

-- Same checks as 2000_025; the acceptance and payment checks now depend on the previous phase.
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
   AND t.expected_source_checkpoint=NEW.expected_source_checkpoint AND t.previous_phase='Accepted'
   AND t.phase='Cancelled' AND t.actor_type='User' AND t.actor_id=NEW.actor_id
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
REVOKE ALL ON FUNCTION rms_ordering.validate_order_staff_cancellation() FROM PUBLIC;
