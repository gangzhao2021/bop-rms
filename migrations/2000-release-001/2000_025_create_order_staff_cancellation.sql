-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q6: store staff cancel a paid, accepted Order Batch before the kitchen starts it. A pickup
-- Order (one Batch) is cancelled as a whole through a User termination; a dine-in Batch is
-- cancelled through its own revision and the Order stays open for further Batches. The record is
-- the compensation source Payment refunds from. Append-only.
ALTER TABLE rms_ordering.order_revision DROP CONSTRAINT order_revision_kind_check;
ALTER TABLE rms_ordering.order_revision ADD CONSTRAINT order_revision_kind_check
 CHECK (kind IN ('Initial','AdditionalBatch','Acceptance','Termination','Fulfillment','BatchCancellation','StaffBatchCancellation'));
CREATE TABLE rms_ordering.order_staff_cancellation (
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
 order_item_ids uuid[] NOT NULL CHECK (cardinality(order_item_ids)>0 AND array_ndims(order_item_ids)=1),
 kitchen_evidence_digest text NOT NULL CHECK (kitchen_evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
 source_digest text NOT NULL CHECK (source_digest ~ '^sha256:[0-9a-f]{64}$'),
 audit_id platform_helpers.uuid_v7 NOT NULL,
 cancelled_at timestamptz NOT NULL CHECK (isfinite(cancelled_at) AND cancelled_at=date_trunc('milliseconds',cancelled_at)),
 CHECK (cancelled_order_version::bigint=expected_order_version::bigint+1),
 UNIQUE (brand_id,store_id,operation_id),
 UNIQUE (brand_id,store_id,order_batch_id),
 UNIQUE (brand_id,store_id,payment_transaction_id),
 FOREIGN KEY (order_batch_id,order_id,brand_id,store_id) REFERENCES rms_ordering.order_batch(order_batch_id,order_id,brand_id,store_id),
 FOREIGN KEY (submission_id,brand_id,store_id,order_id)
  REFERENCES rms_ordering.order_submission_record(submission_id,brand_id,store_id,order_id),
 FOREIGN KEY (cancellation_id,order_id,brand_id,store_id,cancelled_order_version)
  REFERENCES rms_ordering.order_revision(revision_id,order_id,brand_id,store_id,version) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX order_staff_cancellation_order_idx ON rms_ordering.order_staff_cancellation (brand_id,store_id,order_id);
CREATE INDEX order_staff_cancellation_payment_event_idx ON rms_ordering.order_staff_cancellation (brand_id,store_id,payment_event_id);

-- The revision (and, for pickup, the User termination) is written first; the record must then
-- describe exactly that latest revision and the current paid, accepted, unfinished Batch.
CREATE FUNCTION rms_ordering.validate_order_staff_cancellation() RETURNS trigger
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
 SELECT array_agg(order_item_id::uuid ORDER BY order_item_id) INTO members FROM rms_ordering.order_item
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND order_id=NEW.order_id AND order_batch_id=NEW.order_batch_id;
 IF members IS NULL OR members IS DISTINCT FROM NEW.order_item_ids
 THEN RAISE EXCEPTION 'invalid staff cancellation item membership' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.validate_order_staff_cancellation() FROM PUBLIC;
CREATE TRIGGER order_staff_cancellation_validate BEFORE INSERT ON rms_ordering.order_staff_cancellation
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_order_staff_cancellation();

-- A StaffBatchCancellation revision exists only with its dine-in record, and every record is bound
-- to its revision (Termination for pickup), checked at commit in either insert order.
CREATE FUNCTION rms_ordering.validate_staff_cancellation_revision_binding() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE reference uuid;
BEGIN
 IF TG_TABLE_NAME='order_revision' THEN
  IF NEW.kind<>'StaffBatchCancellation' THEN RETURN NEW; END IF;
  reference:=NEW.revision_id;
  IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_staff_cancellation c WHERE c.cancellation_id=reference
   AND c.order_type='DineIn')
  THEN RAISE EXCEPTION 'unbound staff batch cancellation revision' USING ERRCODE='23514'; END IF;
 ELSE reference:=NEW.cancellation_id;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_staff_cancellation c
  JOIN rms_ordering.order_revision r ON r.revision_id=c.cancellation_id AND r.brand_id=c.brand_id AND r.store_id=c.store_id
   AND r.order_id=c.order_id AND r.version=c.cancelled_order_version AND r.expected_version=c.expected_order_version
   AND r.previous_revision_id=c.expected_source_checkpoint AND r.occurred_at=c.cancelled_at
   AND r.kind=(CASE c.order_type WHEN 'Pickup' THEN 'Termination' ELSE 'StaffBatchCancellation' END)
  WHERE c.cancellation_id=reference)
 THEN RAISE EXCEPTION 'unbound staff cancellation revision' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.validate_staff_cancellation_revision_binding() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER staff_cancellation_revision_bound AFTER INSERT ON rms_ordering.order_revision
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_staff_cancellation_revision_binding();
CREATE CONSTRAINT TRIGGER staff_cancellation_record_bound AFTER INSERT ON rms_ordering.order_staff_cancellation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_staff_cancellation_revision_binding();

CREATE FUNCTION rms_ordering.reject_order_staff_cancellation_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN RAISE EXCEPTION 'append-only staff cancellation' USING ERRCODE='55000'; END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.reject_order_staff_cancellation_mutation() FROM PUBLIC;
CREATE TRIGGER order_staff_cancellation_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.order_staff_cancellation
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_order_staff_cancellation_mutation();
CREATE TRIGGER order_staff_cancellation_no_truncate BEFORE TRUNCATE ON rms_ordering.order_staff_cancellation
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_order_staff_cancellation_mutation();
ALTER TABLE rms_ordering.order_staff_cancellation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_staff_cancellation FORCE ROW LEVEL SECURITY;
CREATE POLICY order_staff_cancellation_scope ON rms_ordering.order_staff_cancellation
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_staff_cancellation FROM PUBLIC;

-- Acceptance and staff cancellation serialize on the owning Order row; a staff-cancelled Batch is
-- never accepted again.
CREATE FUNCTION rms_ordering.guard_acceptance_after_staff_cancellation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 PERFORM order_id FROM rms_ordering.order_header WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id
  AND order_id=NEW.order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'acceptance order unavailable' USING ERRCODE='23514'; END IF;
 IF EXISTS (SELECT 1 FROM rms_ordering.order_staff_cancellation WHERE brand_id=NEW.brand_id
  AND store_id=NEW.store_id AND order_id=NEW.order_id AND order_batch_id=NEW.order_batch_id)
 THEN RAISE EXCEPTION 'staff-cancelled batch cannot be accepted' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.guard_acceptance_after_staff_cancellation() FROM PUBLIC;
CREATE TRIGGER order_acceptance_staff_cancellation_guard BEFORE INSERT ON rms_ordering.order_acceptance_record
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.guard_acceptance_after_staff_cancellation();
