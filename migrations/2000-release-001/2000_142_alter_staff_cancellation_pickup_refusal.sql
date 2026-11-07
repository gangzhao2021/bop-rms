-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- v15 2026-11-01 (coordinator): a Store that cannot make a paid pickup order refuses it directly and
-- refunds it, instead of accepting it first. Handoff 24.8: Rejected means the merchant never accepted
-- it (reason, actor and time kept); Section 88 OPS-ORDER-DETAIL "accept / reject". Extends the staff
-- cancellation record (DEC-TABLE-CLOSE-GUESTS-LEFT, dine-in only until now) to a pickup: its record
-- stays bound to its termination, now Submitted -> Rejected. History is not changed.
ALTER TABLE rms_ordering.order_staff_cancellation
 DROP CONSTRAINT order_staff_cancellation_submitted_dine_in;

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
   AND t.phase=(CASE NEW.previous_phase WHEN 'Submitted' THEN 'Rejected' ELSE 'Cancelled' END) AND t.actor_type='User' AND t.actor_id=NEW.actor_id
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
