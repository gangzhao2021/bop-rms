-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_ordering.order_batch_checkout_expiry (
 record_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 order_batch_id platform_helpers.uuid_v7 NOT NULL,
 submission_id platform_helpers.uuid_v7 NOT NULL,
 commitment_id platform_helpers.uuid_v7 NOT NULL,
 payment_operation_id platform_helpers.uuid_v7 NOT NULL,
 evidence_version integer NOT NULL CHECK (evidence_version IN (1,2)),
 previous_record_id platform_helpers.uuid_v7 REFERENCES rms_ordering.order_batch_checkout_expiry(record_id),
 payment_requested_at timestamptz NOT NULL,
 capacity_expires_at timestamptz NOT NULL,
 observed_at timestamptz NOT NULL,
 evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
 status text NOT NULL CHECK (status IN ('AwaitingPaymentResolution','PaymentFailed','PaidBeforeDeadline','LatePayment')),
 payment_intent_id platform_helpers.uuid_v7,
 payment_attempt_id platform_helpers.uuid_v7,
 payment_event_id platform_helpers.uuid_v7,
 payment_outcome text CHECK (payment_outcome IN ('Succeeded','Failed')),
 terminal_occurred_at timestamptz,
 UNIQUE (brand_id,store_id,order_batch_id,evidence_version),
 UNIQUE (brand_id,store_id,payment_operation_id,evidence_version),
 FOREIGN KEY (order_batch_id,order_id,brand_id,store_id) REFERENCES rms_ordering.order_batch(order_batch_id,order_id,brand_id,store_id),
 FOREIGN KEY (submission_id,brand_id,store_id,order_id) REFERENCES rms_ordering.order_submission_record(submission_id,brand_id,store_id,order_id),
 CHECK ((evidence_version=1)=(previous_record_id IS NULL)),
 CHECK (previous_record_id IS DISTINCT FROM record_id),
 CHECK (capacity_expires_at=payment_requested_at+interval '30 minutes'),
 CHECK (observed_at>=capacity_expires_at),
 CHECK (isfinite(payment_requested_at) AND payment_requested_at=date_trunc('milliseconds',payment_requested_at)),
 CHECK (isfinite(capacity_expires_at) AND capacity_expires_at=date_trunc('milliseconds',capacity_expires_at)),
 CHECK (isfinite(observed_at) AND observed_at=date_trunc('milliseconds',observed_at)),
 CHECK (
  (status='AwaitingPaymentResolution' AND evidence_version=1 AND payment_intent_id IS NULL AND payment_attempt_id IS NULL
   AND payment_event_id IS NULL AND payment_outcome IS NULL AND terminal_occurred_at IS NULL)
  OR
  (status<>'AwaitingPaymentResolution' AND payment_intent_id IS NOT NULL AND payment_attempt_id IS NOT NULL
   AND payment_event_id IS NOT NULL AND payment_outcome IS NOT NULL AND terminal_occurred_at IS NOT NULL
   AND isfinite(terminal_occurred_at) AND terminal_occurred_at=date_trunc('milliseconds',terminal_occurred_at)
   AND terminal_occurred_at>=payment_requested_at AND terminal_occurred_at<=observed_at
   AND ((status='PaymentFailed' AND payment_outcome='Failed')
     OR (status='PaidBeforeDeadline' AND payment_outcome='Succeeded' AND terminal_occurred_at<capacity_expires_at)
     OR (status='LatePayment' AND payment_outcome='Succeeded' AND terminal_occurred_at>=capacity_expires_at)))
 )
);
CREATE FUNCTION rms_ordering.validate_order_batch_checkout_expiry() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE previous rms_ordering.order_batch_checkout_expiry%ROWTYPE;
BEGIN
 PERFORM order_id FROM rms_ordering.order_header WHERE order_id=NEW.order_id
  AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND order_type='DineIn' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'invalid expiry order' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_batch b
  JOIN rms_ordering.order_capacity_link l ON l.brand_id=b.brand_id AND l.store_id=b.store_id
   AND l.order_id=b.order_id AND l.order_batch_id=b.order_batch_id AND l.submission_id=b.submission_id
  WHERE b.brand_id=NEW.brand_id AND b.store_id=NEW.store_id AND b.order_id=NEW.order_id
   AND b.order_batch_id=NEW.order_batch_id AND b.submission_id=NEW.submission_id
   AND b.submitted_at<=NEW.payment_requested_at AND l.created_at<=NEW.payment_requested_at
   AND l.commitment_id=NEW.commitment_id AND l.payment_operation_id=NEW.payment_operation_id
   AND l.link_json->>'owner'='Dining')
 THEN RAISE EXCEPTION 'invalid expiry batch linkage' USING ERRCODE='23514'; END IF;
 SELECT * INTO previous FROM rms_ordering.order_batch_checkout_expiry WHERE brand_id=NEW.brand_id
  AND store_id=NEW.store_id AND order_batch_id=NEW.order_batch_id ORDER BY evidence_version DESC LIMIT 1;
 IF previous.record_id IS NULL THEN
  IF NEW.evidence_version<>1 THEN RAISE EXCEPTION 'missing expiry history' USING ERRCODE='23514'; END IF;
 ELSE
  IF previous.status<>'AwaitingPaymentResolution' OR NEW.evidence_version<>2
   OR NEW.previous_record_id IS DISTINCT FROM previous.record_id OR NEW.tenant_id<>previous.tenant_id
   OR NEW.order_id<>previous.order_id OR NEW.submission_id<>previous.submission_id
   OR NEW.commitment_id<>previous.commitment_id OR NEW.payment_operation_id<>previous.payment_operation_id
   OR NEW.payment_requested_at<>previous.payment_requested_at OR NEW.capacity_expires_at<>previous.capacity_expires_at
   OR NEW.observed_at<previous.observed_at
  THEN RAISE EXCEPTION 'invalid expiry evidence transition' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.validate_order_batch_checkout_expiry() FROM PUBLIC;
CREATE TRIGGER order_batch_checkout_expiry_validate BEFORE INSERT ON rms_ordering.order_batch_checkout_expiry
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_order_batch_checkout_expiry();
CREATE FUNCTION rms_ordering.reject_order_batch_checkout_expiry_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only batch expiry evidence' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.reject_order_batch_checkout_expiry_mutation() FROM PUBLIC;
CREATE TRIGGER order_batch_checkout_expiry_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.order_batch_checkout_expiry
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_order_batch_checkout_expiry_mutation();
CREATE TRIGGER order_batch_checkout_expiry_no_truncate BEFORE TRUNCATE ON rms_ordering.order_batch_checkout_expiry
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_order_batch_checkout_expiry_mutation();
ALTER TABLE rms_ordering.order_batch_checkout_expiry ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_batch_checkout_expiry FORCE ROW LEVEL SECURITY;
CREATE POLICY order_batch_checkout_expiry_scope ON rms_ordering.order_batch_checkout_expiry
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_batch_checkout_expiry FROM PUBLIC;
