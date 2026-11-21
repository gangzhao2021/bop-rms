-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-DINE-IN-PAY-LATER (Owner 2026-10-26, rule 2; coordinator 2026-10-27): at a table that
-- pays at the end, staff take dishes (or a whole round) off the bill before the table pays — the
-- same append-only item cancellation (revision, kitchen evidence, actor, reason), on the basis
-- 'PayLater': the round was sent to the kitchen unpaid, so there is no payment to name and nothing
-- to refund; the bill drops the dishes. Paid cancellations are unchanged ('Paid', the default).
-- No new grants (the table's existing api SELECT/INSERT).
ALTER TABLE rms_ordering.order_item_staff_cancellation
 ADD COLUMN basis text NOT NULL DEFAULT 'Paid' CHECK (basis IN ('Paid','PayLater'));
ALTER TABLE rms_ordering.order_item_staff_cancellation
 ALTER COLUMN payment_disposition_id DROP NOT NULL,
 ALTER COLUMN payment_transaction_id DROP NOT NULL,
 ALTER COLUMN payment_intent_id DROP NOT NULL,
 ALTER COLUMN payment_attempt_id DROP NOT NULL,
 ALTER COLUMN payment_event_id DROP NOT NULL,
 ALTER COLUMN refund_request_id DROP NOT NULL,
 ALTER COLUMN refund_operation_id DROP NOT NULL,
 ALTER COLUMN refund_amount_minor DROP NOT NULL;
ALTER TABLE rms_ordering.order_item_staff_cancellation
 ADD CONSTRAINT order_item_staff_cancellation_basis_shape CHECK (
  (basis='Paid' AND payment_disposition_id IS NOT NULL AND payment_transaction_id IS NOT NULL
   AND payment_intent_id IS NOT NULL AND payment_attempt_id IS NOT NULL AND payment_event_id IS NOT NULL
   AND refund_request_id IS NOT NULL AND refund_operation_id IS NOT NULL AND refund_amount_minor IS NOT NULL)
  OR (basis='PayLater' AND payment_disposition_id IS NULL AND payment_transaction_id IS NULL
   AND payment_intent_id IS NULL AND payment_attempt_id IS NULL AND payment_event_id IS NULL
   AND refund_request_id IS NULL AND refund_operation_id IS NULL AND refund_amount_minor IS NULL)
 );

-- Same checks as 2000_026, with the pay-later basis.
CREATE OR REPLACE FUNCTION rms_ordering.validate_order_item_staff_cancellation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE latest rms_ordering.order_revision%ROWTYPE;
DECLARE header_type text;
DECLARE batch_items uuid[];
DECLARE prior_items uuid[];
BEGIN
 SELECT order_type INTO header_type FROM rms_ordering.order_header WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id
  AND order_id=NEW.order_id FOR UPDATE;
 IF NOT FOUND OR header_type IS DISTINCT FROM NEW.order_type
 THEN RAISE EXCEPTION 'invalid item cancellation order' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_batch WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id
  AND order_id=NEW.order_id AND order_batch_id=NEW.order_batch_id AND submission_id=NEW.submission_id
  AND submitted_at<=NEW.cancelled_at)
 THEN RAISE EXCEPTION 'invalid item cancellation batch' USING ERRCODE='23514'; END IF;
 SELECT * INTO latest FROM rms_ordering.order_revision WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id
  AND order_id=NEW.order_id ORDER BY version DESC LIMIT 1;
 IF latest.revision_id IS NULL OR latest.revision_id<>NEW.cancellation_id OR latest.kind<>'StaffItemCancellation'
  OR latest.version<>NEW.cancelled_order_version OR latest.expected_version<>NEW.expected_order_version
  OR latest.previous_revision_id IS DISTINCT FROM NEW.expected_source_checkpoint OR latest.occurred_at<>NEW.cancelled_at
 THEN RAISE EXCEPTION 'stale item cancellation revision' USING ERRCODE='23514'; END IF;
 IF EXISTS (SELECT 1 FROM rms_ordering.order_termination_record WHERE brand_id=NEW.brand_id
  AND store_id=NEW.store_id AND order_id=NEW.order_id)
  OR (SELECT status FROM rms_ordering.order_closure_version WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id
  AND order_id=NEW.order_id ORDER BY closure_version DESC LIMIT 1)='Closed'
  OR EXISTS (SELECT 1 FROM rms_ordering.order_fulfillment_completion_record WHERE brand_id=NEW.brand_id
   AND store_id=NEW.store_id AND order_id=NEW.order_id)
  OR EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_cancellation WHERE brand_id=NEW.brand_id
   AND store_id=NEW.store_id AND order_id=NEW.order_id AND order_batch_id=NEW.order_batch_id)
  OR EXISTS (SELECT 1 FROM rms_ordering.order_staff_cancellation WHERE brand_id=NEW.brand_id
   AND store_id=NEW.store_id AND order_id=NEW.order_id AND order_batch_id=NEW.order_batch_id)
 THEN RAISE EXCEPTION 'item cancellation state conflict' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record WHERE brand_id=NEW.brand_id
  AND store_id=NEW.store_id AND order_id=NEW.order_id AND order_batch_id=NEW.order_batch_id
  AND accepted_order_version<=NEW.expected_order_version AND accepted_at<=NEW.cancelled_at)
 THEN RAISE EXCEPTION 'item cancellation batch not accepted' USING ERRCODE='23514'; END IF;
 IF NEW.basis='PayLater' THEN
  -- A round of a table that pays at the end: sent to the kitchen with its pay-later confirmation,
  -- never paid on its own (nothing to refund).
  IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_pay_later_confirmation p WHERE p.brand_id=NEW.brand_id
   AND p.store_id=NEW.store_id AND p.order_id=NEW.order_id AND p.order_batch_id=NEW.order_batch_id
   AND p.submission_id=NEW.submission_id AND p.confirmed_at<=NEW.cancelled_at)
  OR EXISTS (SELECT 1 FROM rms_ordering.order_payment_disposition_record d WHERE d.brand_id=NEW.brand_id
   AND d.store_id=NEW.store_id AND d.order_id=NEW.order_id AND d.order_batch_id=NEW.order_batch_id)
  OR NEW.order_type<>'DineIn'
  THEN RAISE EXCEPTION 'pay-later item cancellation source mismatch' USING ERRCODE='23514'; END IF;
 ELSIF NOT EXISTS (SELECT 1 FROM rms_ordering.order_payment_disposition_record d
  WHERE d.disposition_id=NEW.payment_disposition_id AND d.brand_id=NEW.brand_id AND d.store_id=NEW.store_id
   AND d.order_id=NEW.order_id AND d.order_batch_id=NEW.order_batch_id AND d.submission_id=NEW.submission_id
   AND d.payment_transaction_id=NEW.payment_transaction_id AND d.payment_intent_id=NEW.payment_intent_id
   AND d.payment_attempt_id=NEW.payment_attempt_id AND d.payment_event_id=NEW.payment_event_id
   AND d.disposition='Confirmed' AND d.confirmed_at<=NEW.cancelled_at)
 THEN RAISE EXCEPTION 'item cancellation payment not confirmed' USING ERRCODE='23514'; END IF;
 IF NEW.order_item_ids IS DISTINCT FROM (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(NEW.order_item_ids) x)
 THEN RAISE EXCEPTION 'item cancellation lines not canonical' USING ERRCODE='23514'; END IF;
 SELECT array_agg(order_item_id::uuid ORDER BY order_item_id) INTO batch_items FROM rms_ordering.order_item
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND order_id=NEW.order_id AND order_batch_id=NEW.order_batch_id;
 SELECT array_agg(x) INTO prior_items FROM rms_ordering.order_item_staff_cancellation c, unnest(c.order_item_ids) x
  WHERE c.brand_id=NEW.brand_id AND c.store_id=NEW.store_id AND c.order_id=NEW.order_id
   AND c.order_batch_id=NEW.order_batch_id AND c.cancellation_id<>NEW.cancellation_id;
 IF batch_items IS NULL OR NOT (NEW.order_item_ids <@ batch_items)
  OR (prior_items IS NOT NULL AND NEW.order_item_ids && prior_items)
  -- A paid Batch keeps a line (its last lines end through the whole cancellation and its refund);
  -- an unpaid pay-later round may lose every line (nothing was charged).
  OR (NEW.basis='Paid' AND batch_items <@ (NEW.order_item_ids || COALESCE(prior_items,'{}'::uuid[])))
 THEN RAISE EXCEPTION 'invalid item cancellation lines' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
