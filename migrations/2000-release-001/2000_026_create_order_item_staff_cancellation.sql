-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q6 step 2a: store staff cancel some whole item lines of a paid, accepted Order Batch
-- before the kitchen starts them. The Order and Batch stay active with the remaining items; the
-- last remaining items are cancelled through the whole-batch staff cancellation instead. The record
-- binds the ordinary refund request (claim kind Cancellation) that refunds exactly those items.
-- Append-only.
ALTER TABLE rms_ordering.order_revision DROP CONSTRAINT order_revision_kind_check;
ALTER TABLE rms_ordering.order_revision ADD CONSTRAINT order_revision_kind_check
 CHECK (kind IN ('Initial','AdditionalBatch','Acceptance','Termination','Fulfillment','BatchCancellation',
  'StaffBatchCancellation','StaffItemCancellation'));
CREATE TABLE rms_ordering.order_item_staff_cancellation (
 cancellation_id platform_helpers.uuid_v7 PRIMARY KEY,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 order_batch_id platform_helpers.uuid_v7 NOT NULL,
 submission_id platform_helpers.uuid_v7 NOT NULL,
 order_type text NOT NULL CHECK (order_type IN ('Pickup','DineIn')),
 expected_order_version integer NOT NULL CHECK (expected_order_version>1 AND expected_order_version<2147483647),
 cancelled_order_version integer NOT NULL,
 expected_source_checkpoint platform_helpers.uuid_v7 NOT NULL,
 previous_phase text NOT NULL CHECK (previous_phase='Accepted'),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 permission_code text NOT NULL CHECK (permission_code='ordering.order.cancel'),
 reason_code text NOT NULL CHECK (reason_code IN ('CUSTOMER_REQUEST','SOLD_OUT','STORE_ERROR','DUPLICATE_ORDER')),
 payment_disposition_id platform_helpers.uuid_v7 NOT NULL
  REFERENCES rms_ordering.order_payment_disposition_record(disposition_id),
 payment_transaction_id platform_helpers.uuid_v7 NOT NULL,
 payment_intent_id platform_helpers.uuid_v7 NOT NULL,
 payment_attempt_id platform_helpers.uuid_v7 NOT NULL,
 payment_event_id platform_helpers.uuid_v7 NOT NULL,
 order_item_ids uuid[] NOT NULL CHECK (cardinality(order_item_ids) BETWEEN 1 AND 100 AND array_ndims(order_item_ids)=1),
 kitchen_evidence_digest text NOT NULL CHECK (kitchen_evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
 refund_request_id platform_helpers.uuid_v7 NOT NULL,
 refund_operation_id platform_helpers.uuid_v7 NOT NULL,
 refund_amount_minor bigint NOT NULL CHECK (refund_amount_minor>0),
 currency_code text NOT NULL CHECK (currency_code='CAD'),
 source_digest text NOT NULL CHECK (source_digest ~ '^sha256:[0-9a-f]{64}$'),
 audit_id platform_helpers.uuid_v7 NOT NULL,
 cancelled_at timestamptz NOT NULL CHECK (isfinite(cancelled_at) AND cancelled_at=date_trunc('milliseconds',cancelled_at)),
 CHECK (cancelled_order_version::bigint=expected_order_version::bigint+1),
 CHECK (cancellation_id<>operation_id AND cancellation_id<>refund_request_id AND cancellation_id<>refund_operation_id
  AND cancellation_id<>audit_id AND refund_request_id<>refund_operation_id AND operation_id<>refund_request_id
  AND operation_id<>refund_operation_id),
 UNIQUE (brand_id,store_id,operation_id),
 UNIQUE (brand_id,store_id,refund_request_id),
 UNIQUE (brand_id,store_id,refund_operation_id),
 FOREIGN KEY (order_batch_id,order_id,brand_id,store_id) REFERENCES rms_ordering.order_batch(order_batch_id,order_id,brand_id,store_id),
 FOREIGN KEY (submission_id,brand_id,store_id,order_id)
  REFERENCES rms_ordering.order_submission_record(submission_id,brand_id,store_id,order_id),
 FOREIGN KEY (cancellation_id,order_id,brand_id,store_id,cancelled_order_version)
  REFERENCES rms_ordering.order_revision(revision_id,order_id,brand_id,store_id,version) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX order_item_staff_cancellation_order_idx ON rms_ordering.order_item_staff_cancellation (brand_id,store_id,order_id);
CREATE INDEX order_item_staff_cancellation_batch_idx ON rms_ordering.order_item_staff_cancellation (brand_id,store_id,order_batch_id);

-- The revision is written first; the record must then describe exactly that latest revision and
-- the current paid, accepted, unfinished Batch. Every cancelled line belongs to the Batch, is listed
-- once in uuid order, was not cancelled before, and at least one line of the Batch stays active.
CREATE FUNCTION rms_ordering.validate_order_item_staff_cancellation() RETURNS trigger
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
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_payment_disposition_record d
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
  OR batch_items <@ (NEW.order_item_ids || COALESCE(prior_items,'{}'::uuid[]))
 THEN RAISE EXCEPTION 'invalid item cancellation lines' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.validate_order_item_staff_cancellation() FROM PUBLIC;
CREATE TRIGGER order_item_staff_cancellation_validate BEFORE INSERT ON rms_ordering.order_item_staff_cancellation
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_order_item_staff_cancellation();

-- A StaffItemCancellation revision exists only with its record, and every record is bound to its
-- revision, checked at commit in either insert order.
CREATE FUNCTION rms_ordering.validate_item_staff_cancellation_revision_binding() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE reference uuid;
BEGIN
 IF TG_TABLE_NAME='order_revision' THEN
  IF NEW.kind<>'StaffItemCancellation' THEN RETURN NEW; END IF;
  reference:=NEW.revision_id;
 ELSE reference:=NEW.cancellation_id;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_item_staff_cancellation c
  JOIN rms_ordering.order_revision r ON r.revision_id=c.cancellation_id AND r.brand_id=c.brand_id AND r.store_id=c.store_id
   AND r.order_id=c.order_id AND r.version=c.cancelled_order_version AND r.expected_version=c.expected_order_version
   AND r.previous_revision_id=c.expected_source_checkpoint AND r.occurred_at=c.cancelled_at
   AND r.kind='StaffItemCancellation'
  WHERE c.cancellation_id=reference)
 THEN RAISE EXCEPTION 'unbound item cancellation revision' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.validate_item_staff_cancellation_revision_binding() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER item_staff_cancellation_revision_bound AFTER INSERT ON rms_ordering.order_revision
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_item_staff_cancellation_revision_binding();
CREATE CONSTRAINT TRIGGER item_staff_cancellation_record_bound AFTER INSERT ON rms_ordering.order_item_staff_cancellation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_item_staff_cancellation_revision_binding();

CREATE FUNCTION rms_ordering.reject_order_item_staff_cancellation_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN RAISE EXCEPTION 'append-only item staff cancellation' USING ERRCODE='55000'; END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.reject_order_item_staff_cancellation_mutation() FROM PUBLIC;
CREATE TRIGGER order_item_staff_cancellation_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.order_item_staff_cancellation
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_order_item_staff_cancellation_mutation();
CREATE TRIGGER order_item_staff_cancellation_no_truncate BEFORE TRUNCATE ON rms_ordering.order_item_staff_cancellation
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_order_item_staff_cancellation_mutation();
ALTER TABLE rms_ordering.order_item_staff_cancellation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_item_staff_cancellation FORCE ROW LEVEL SECURITY;
CREATE POLICY order_item_staff_cancellation_scope ON rms_ordering.order_item_staff_cancellation
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_item_staff_cancellation FROM PUBLIC;
