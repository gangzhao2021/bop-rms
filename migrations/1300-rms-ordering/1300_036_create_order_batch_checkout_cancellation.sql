-- bop-rms-migration: 1
-- owner: @rms/ordering
-- schema: rms_ordering
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE rms_ordering.order_revision DROP CONSTRAINT order_revision_kind_check;
ALTER TABLE rms_ordering.order_revision ADD CONSTRAINT order_revision_kind_check
 CHECK (kind IN ('Initial','AdditionalBatch','Acceptance','Termination','Fulfillment','BatchCancellation'));
CREATE TABLE rms_ordering.order_batch_checkout_cancellation (
 cancellation_id platform_helpers.uuid_v7 PRIMARY KEY,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 order_batch_id platform_helpers.uuid_v7 NOT NULL,
 submission_id platform_helpers.uuid_v7 NOT NULL,
 payment_operation_id platform_helpers.uuid_v7 NOT NULL,
 expiry_record_id platform_helpers.uuid_v7 NOT NULL REFERENCES rms_ordering.order_batch_checkout_expiry(record_id),
 expiry_evidence_digest text NOT NULL CHECK (expiry_evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
 expected_order_version integer NOT NULL CHECK (expected_order_version>0 AND expected_order_version<2147483647),
 cancelled_order_version integer NOT NULL,
 expected_source_checkpoint platform_helpers.uuid_v7 NOT NULL,
 workflow_version_id platform_helpers.uuid_v7 NOT NULL,
 transition_id platform_helpers.uuid_v7 NOT NULL,
 order_item_ids uuid[] NOT NULL CHECK (cardinality(order_item_ids)>0 AND array_ndims(order_item_ids)=1),
 cancelled_at timestamptz NOT NULL CHECK (isfinite(cancelled_at) AND cancelled_at=date_trunc('milliseconds',cancelled_at)),
 phase text NOT NULL CHECK (phase='Cancelled'),
 reason_code text NOT NULL CHECK (reason_code='CHECKOUT_DEADLINE_REACHED'),
 CHECK (cancelled_order_version::bigint=expected_order_version::bigint+1),
 UNIQUE (brand_id,store_id,operation_id),
 UNIQUE (brand_id,store_id,order_batch_id),
 FOREIGN KEY (order_batch_id,order_id,brand_id,store_id) REFERENCES rms_ordering.order_batch(order_batch_id,order_id,brand_id,store_id),
 FOREIGN KEY (cancellation_id,order_id,brand_id,store_id,cancelled_order_version)
  REFERENCES rms_ordering.order_revision(revision_id,order_id,brand_id,store_id,version) DEFERRABLE INITIALLY DEFERRED
);
CREATE FUNCTION rms_ordering.validate_order_batch_checkout_cancellation() RETURNS trigger
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
 THEN RAISE EXCEPTION 'cancellation state conflict' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_expiry e
  JOIN rms_ordering.order_batch b ON b.brand_id=e.brand_id AND b.store_id=e.store_id AND b.order_id=e.order_id AND b.order_batch_id=e.order_batch_id AND b.submission_id=e.submission_id
  WHERE e.record_id=NEW.expiry_record_id AND e.tenant_id=NEW.tenant_id AND e.brand_id=NEW.brand_id AND e.store_id=NEW.store_id
   AND e.order_id=NEW.order_id AND e.order_batch_id=NEW.order_batch_id AND e.submission_id=NEW.submission_id
   AND e.payment_operation_id=NEW.payment_operation_id AND e.status='PaymentFailed'
   AND e.evidence_digest=NEW.expiry_evidence_digest AND e.observed_at<=NEW.cancelled_at)
 THEN RAISE EXCEPTION 'invalid cancellation expiry evidence' USING ERRCODE='23514'; END IF;
 SELECT array_agg(order_item_id::uuid ORDER BY order_item_id) INTO members FROM rms_ordering.order_item
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND order_id=NEW.order_id AND order_batch_id=NEW.order_batch_id;
 IF members IS NULL OR members IS DISTINCT FROM NEW.order_item_ids
 THEN RAISE EXCEPTION 'invalid cancellation item membership' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.validate_order_batch_checkout_cancellation() FROM PUBLIC;
CREATE TRIGGER order_batch_checkout_cancellation_validate BEFORE INSERT ON rms_ordering.order_batch_checkout_cancellation
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_order_batch_checkout_cancellation();
CREATE FUNCTION rms_ordering.validate_batch_cancellation_revision_binding() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE reference uuid;
BEGIN
 IF TG_TABLE_NAME='order_revision' THEN
  IF NEW.kind<>'BatchCancellation' THEN RETURN NEW; END IF;
  reference:=NEW.revision_id;
 ELSE reference:=NEW.cancellation_id;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_cancellation c
  JOIN rms_ordering.order_revision r ON r.revision_id=c.cancellation_id AND r.brand_id=c.brand_id AND r.store_id=c.store_id
   AND r.order_id=c.order_id AND r.kind='BatchCancellation' AND r.version=c.cancelled_order_version
   AND r.expected_version=c.expected_order_version AND r.previous_revision_id=c.expected_source_checkpoint AND r.occurred_at=c.cancelled_at
  WHERE c.cancellation_id=reference)
 THEN RAISE EXCEPTION 'unbound batch cancellation revision' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.validate_batch_cancellation_revision_binding() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER batch_cancellation_revision_bound AFTER INSERT ON rms_ordering.order_revision
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_batch_cancellation_revision_binding();
CREATE CONSTRAINT TRIGGER batch_cancellation_record_bound AFTER INSERT ON rms_ordering.order_batch_checkout_cancellation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_ordering.validate_batch_cancellation_revision_binding();
CREATE FUNCTION rms_ordering.reject_order_batch_checkout_cancellation_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN RAISE EXCEPTION 'append-only batch cancellation' USING ERRCODE='55000'; END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.reject_order_batch_checkout_cancellation_mutation() FROM PUBLIC;
CREATE TRIGGER order_batch_checkout_cancellation_no_mutation BEFORE UPDATE OR DELETE ON rms_ordering.order_batch_checkout_cancellation
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.reject_order_batch_checkout_cancellation_mutation();
CREATE TRIGGER order_batch_checkout_cancellation_no_truncate BEFORE TRUNCATE ON rms_ordering.order_batch_checkout_cancellation
 FOR EACH STATEMENT EXECUTE FUNCTION rms_ordering.reject_order_batch_checkout_cancellation_mutation();
ALTER TABLE rms_ordering.order_batch_checkout_cancellation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_ordering.order_batch_checkout_cancellation FORCE ROW LEVEL SECURITY;
CREATE POLICY order_batch_checkout_cancellation_scope ON rms_ordering.order_batch_checkout_cancellation
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_ordering.order_batch_checkout_cancellation FROM PUBLIC;

-- Both acceptance and cancellation serialize on the owning Order row.
CREATE FUNCTION rms_ordering.guard_acceptance_after_batch_cancellation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 PERFORM order_id FROM rms_ordering.order_header WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id
  AND order_id=NEW.order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'acceptance order unavailable' USING ERRCODE='23514'; END IF;
 IF EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_cancellation WHERE brand_id=NEW.brand_id
  AND store_id=NEW.store_id AND order_id=NEW.order_id AND order_batch_id=NEW.order_batch_id)
 THEN RAISE EXCEPTION 'cancelled batch cannot be accepted' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_ordering.guard_acceptance_after_batch_cancellation() FROM PUBLIC;
CREATE TRIGGER order_acceptance_checkout_cancellation_guard BEFORE INSERT ON rms_ordering.order_acceptance_record
 FOR EACH ROW EXECUTE FUNCTION rms_ordering.guard_acceptance_after_batch_cancellation();
