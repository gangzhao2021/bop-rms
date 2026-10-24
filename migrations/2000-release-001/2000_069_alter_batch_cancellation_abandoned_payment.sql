-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 abandoned payment (DEC-DINING-ABANDONED-PAYMENT, 2026-10-16): a guest who started paying for
-- a dine-in round online and never finished left it stranded. Two more reasons for the same
-- append-only unpaid round cancellation (same Workflow transition, stock release and OrderCancelled):
-- * PAYMENT_NOT_COMPLETED — at the deadline Payment cancelled the never-confirmed Provider attempt and
--   recorded it as failed (Cancelled); bound, like CHECKOUT_DEADLINE_REACHED, to the round's latest
--   PaymentFailed expiry evidence (which reason applies is proven from Payment by the application).
-- * STAFF_CANCELLED_UNPAID — a manager cancels the unpaid round before its deadline ("Cancel this
--   unpaid round"). There is no expiry evidence yet, so none is stored; the round must be a
--   Dining-owned round of this submission and payment operation, and Ordering must not have recorded
--   a payment for it. The application proves from Payment, under the payment operation fence, that
--   nothing was charged (no card-machine payment; the online attempt, if any, failed or was
--   cancelled at the Provider first). Who asked is in the audit record (User actor).
-- Nothing was charged, so nothing is refunded. Existing rows are unchanged; no new table or grant.
ALTER TABLE rms_ordering.order_batch_checkout_cancellation
 DROP CONSTRAINT order_batch_checkout_cancellation_reason_code_check;
ALTER TABLE rms_ordering.order_batch_checkout_cancellation
 ADD CONSTRAINT order_batch_checkout_cancellation_reason_code_check
 CHECK (reason_code IN ('CHECKOUT_DEADLINE_REACHED','PAYMENT_NOT_STARTED','PAYMENT_NOT_COMPLETED','STAFF_CANCELLED_UNPAID'));
ALTER TABLE rms_ordering.order_batch_checkout_cancellation
 ALTER COLUMN expiry_record_id DROP NOT NULL,
 ALTER COLUMN expiry_evidence_digest DROP NOT NULL;
ALTER TABLE rms_ordering.order_batch_checkout_cancellation
 ADD CONSTRAINT order_batch_checkout_cancellation_expiry_evidence
 CHECK ((reason_code='STAFF_CANCELLED_UNPAID') = (expiry_record_id IS NULL)
  AND (expiry_record_id IS NULL) = (expiry_evidence_digest IS NULL));
CREATE OR REPLACE FUNCTION rms_ordering.validate_order_batch_checkout_cancellation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE latest rms_ordering.order_revision%ROWTYPE;
DECLARE members uuid[];
BEGIN
 PERFORM order_id FROM rms_ordering.order_header WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id
  AND order_id=NEW.order_id AND order_type='DineIn' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'invalid cancellation order' USING ERRCODE='23514'; END IF;
 SELECT * INTO latest FROM rms_ordering.order_revision WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id
  AND order_id=NEW.order_id ORDER BY version DESC LIMIT 1;
 IF latest.revision_id IS NULL OR latest.version<>NEW.expected_order_version
  OR latest.revision_id<>NEW.expected_source_checkpoint OR latest.occurred_at>NEW.cancelled_at
 THEN RAISE EXCEPTION 'stale cancellation revision' USING ERRCODE='23514'; END IF;
 IF (SELECT status FROM rms_ordering.order_closure_version WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id
  AND order_id=NEW.order_id ORDER BY closure_version DESC LIMIT 1)='Closed'
  OR EXISTS (SELECT 1 FROM rms_ordering.order_termination_record WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND order_id=NEW.order_id)
  OR EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND order_id=NEW.order_id AND order_batch_id=NEW.order_batch_id)
  OR EXISTS (SELECT 1 FROM rms_ordering.order_staff_cancellation WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND order_id=NEW.order_id AND order_batch_id=NEW.order_batch_id)
 THEN RAISE EXCEPTION 'cancellation state conflict' USING ERRCODE='23514'; END IF;
 IF NEW.reason_code='STAFF_CANCELLED_UNPAID' THEN
  IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_batch b
   JOIN rms_ordering.order_capacity_link l ON l.brand_id=b.brand_id AND l.store_id=b.store_id
    AND l.order_id=b.order_id AND l.order_batch_id=b.order_batch_id AND l.submission_id=b.submission_id
   WHERE b.brand_id=NEW.brand_id AND b.store_id=NEW.store_id AND b.order_id=NEW.order_id
    AND b.order_batch_id=NEW.order_batch_id AND b.submission_id=NEW.submission_id
    AND l.payment_operation_id=NEW.payment_operation_id AND l.link_json->>'owner'='Dining'
    AND b.submitted_at<=NEW.cancelled_at)
  THEN RAISE EXCEPTION 'invalid staff unpaid round' USING ERRCODE='23514'; END IF;
 ELSIF NOT EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_expiry e
  JOIN rms_ordering.order_batch b ON b.brand_id=e.brand_id AND b.store_id=e.store_id AND b.order_id=e.order_id AND b.order_batch_id=e.order_batch_id AND b.submission_id=e.submission_id
  WHERE e.record_id=NEW.expiry_record_id AND e.tenant_id=NEW.tenant_id AND e.brand_id=NEW.brand_id AND e.store_id=NEW.store_id
   AND e.order_id=NEW.order_id AND e.order_batch_id=NEW.order_batch_id AND e.submission_id=NEW.submission_id
   AND e.payment_operation_id=NEW.payment_operation_id
   AND ((NEW.reason_code IN ('CHECKOUT_DEADLINE_REACHED','PAYMENT_NOT_COMPLETED') AND e.status='PaymentFailed')
    OR (NEW.reason_code='PAYMENT_NOT_STARTED' AND e.status='AwaitingPaymentResolution'
     AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_expiry later
      WHERE later.brand_id=e.brand_id AND later.store_id=e.store_id AND later.order_batch_id=e.order_batch_id
       AND later.evidence_version>e.evidence_version)))
   AND e.evidence_digest=NEW.expiry_evidence_digest AND e.observed_at<=NEW.cancelled_at)
 THEN RAISE EXCEPTION 'invalid cancellation expiry evidence' USING ERRCODE='23514'; END IF;
 IF NEW.reason_code IN ('PAYMENT_NOT_STARTED','STAFF_CANCELLED_UNPAID') AND (
  EXISTS (SELECT 1 FROM rms_ordering.order_payment_acceptance_wait w WHERE w.brand_id=NEW.brand_id
   AND w.store_id=NEW.store_id AND w.order_id=NEW.order_id AND w.order_batch_id=NEW.order_batch_id)
  OR EXISTS (SELECT 1 FROM rms_ordering.order_payment_disposition_record d WHERE d.brand_id=NEW.brand_id
   AND d.store_id=NEW.store_id AND d.order_id=NEW.order_id AND d.order_batch_id=NEW.order_batch_id))
 THEN RAISE EXCEPTION 'cancellation payment conflict' USING ERRCODE='23514'; END IF;
 SELECT array_agg(order_item_id::uuid ORDER BY order_item_id) INTO members FROM rms_ordering.order_item
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND order_id=NEW.order_id AND order_batch_id=NEW.order_batch_id;
 IF members IS NULL OR members IS DISTINCT FROM NEW.order_item_ids
 THEN RAISE EXCEPTION 'invalid cancellation item membership' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.validate_order_batch_checkout_cancellation() FROM PUBLIC;
