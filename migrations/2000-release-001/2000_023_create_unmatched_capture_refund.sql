-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 P6: a charge the payment Provider captured that matches no payment or Order of this Store
-- is refunded in full to the customer: requested by staff with refund-request authority, approved
-- by a different person with refund-approve authority (which dispatches it with a fixed Provider
-- idempotency key), and closed by the Provider-confirmed refund. Every step is append-only.
CREATE FUNCTION rms_payment.reject_unmatched_capture_refund_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only unmatched capture refund' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.reject_unmatched_capture_refund_mutation() FROM PUBLIC;

CREATE TABLE rms_payment.unmatched_capture_refund_request (
 refund_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 candidate_id platform_helpers.uuid_v7 NOT NULL,
 reconciliation_exception_id platform_helpers.uuid_v7 NOT NULL,
 provider_account_id platform_helpers.uuid_v7 NOT NULL,
 environment text NOT NULL CHECK (environment IN ('Test','Live')),
 provider_intent_reference text NOT NULL,
 provider_transaction_reference text NOT NULL,
 amount_minor bigint NOT NULL CHECK (amount_minor > 0),
 currency_code text NOT NULL CHECK (currency_code = 'CAD'),
 reason text NOT NULL CHECK (reason = 'NoMatchingOrder'),
 requested_by_actor_id platform_helpers.uuid_v7 NOT NULL,
 requested_at timestamptz NOT NULL CHECK (isfinite(requested_at) AND requested_at=date_trunc('milliseconds',requested_at)),
 idempotency_id platform_helpers.uuid_v7 NOT NULL,
 audit_id platform_helpers.uuid_v7 NOT NULL,
 PRIMARY KEY (brand_id,store_id,refund_id),
 UNIQUE (brand_id,store_id,candidate_id),
 UNIQUE (brand_id,store_id,idempotency_id),
 FOREIGN KEY (brand_id,store_id,provider_account_id,environment,provider_transaction_reference)
  REFERENCES rms_payment.provider_capture_exception_evidence (brand_id,store_id,provider_account_id,environment,provider_transaction_reference)
);
CREATE TABLE rms_payment.unmatched_capture_refund_approval (
 refund_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 approved_by_actor_id platform_helpers.uuid_v7 NOT NULL,
 approved_at timestamptz NOT NULL CHECK (isfinite(approved_at) AND approved_at=date_trunc('milliseconds',approved_at)),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 provider_idempotency_key text NOT NULL CHECK (provider_idempotency_key = 'unmatched-capture-refund:' || operation_id::text),
 idempotency_id platform_helpers.uuid_v7 NOT NULL,
 audit_id platform_helpers.uuid_v7 NOT NULL,
 PRIMARY KEY (brand_id,store_id,refund_id),
 UNIQUE (brand_id,store_id,idempotency_id),
 FOREIGN KEY (brand_id,store_id,refund_id) REFERENCES rms_payment.unmatched_capture_refund_request (brand_id,store_id,refund_id)
);
CREATE TABLE rms_payment.unmatched_capture_refund_outcome (
 refund_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 provider_refund_reference text NOT NULL CHECK (provider_refund_reference ~ '^[A-Za-z0-9][A-Za-z0-9_-]{6,126}[A-Za-z0-9]$'),
 status text NOT NULL CHECK (status = 'Succeeded'),
 amount_minor bigint NOT NULL CHECK (amount_minor > 0),
 provider_observed_at timestamptz NOT NULL,
 evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL,
 PRIMARY KEY (brand_id,store_id,refund_id),
 FOREIGN KEY (brand_id,store_id,refund_id) REFERENCES rms_payment.unmatched_capture_refund_approval (brand_id,store_id,refund_id)
);

-- Separation of duties and amounts are held by the database as well as by the owner writer.
CREATE FUNCTION rms_payment.check_unmatched_capture_refund_step() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE requested rms_payment.unmatched_capture_refund_request%ROWTYPE;
BEGIN
 SELECT * INTO requested FROM rms_payment.unmatched_capture_refund_request
  WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND refund_id=NEW.refund_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'unmatched capture refund request missing' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME = 'unmatched_capture_refund_approval' THEN
  IF NEW.approved_by_actor_id = requested.requested_by_actor_id OR NEW.approved_at < requested.requested_at THEN
   RAISE EXCEPTION 'unmatched capture refund needs a different approver after the request' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.amount_minor <> requested.amount_minor OR NEW.recorded_at < requested.requested_at THEN
  RAISE EXCEPTION 'unmatched capture refund outcome does not match its request' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.check_unmatched_capture_refund_step() FROM PUBLIC;
CREATE TRIGGER unmatched_capture_refund_approval_check BEFORE INSERT ON rms_payment.unmatched_capture_refund_approval
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_unmatched_capture_refund_step();
CREATE TRIGGER unmatched_capture_refund_outcome_check BEFORE INSERT ON rms_payment.unmatched_capture_refund_outcome
 FOR EACH ROW EXECUTE FUNCTION rms_payment.check_unmatched_capture_refund_step();

CREATE TRIGGER unmatched_capture_refund_request_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.unmatched_capture_refund_request
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_unmatched_capture_refund_mutation();
CREATE TRIGGER unmatched_capture_refund_request_no_truncate BEFORE TRUNCATE ON rms_payment.unmatched_capture_refund_request
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_unmatched_capture_refund_mutation();
ALTER TABLE rms_payment.unmatched_capture_refund_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.unmatched_capture_refund_request FORCE ROW LEVEL SECURITY;
CREATE POLICY unmatched_capture_refund_request_scope ON rms_payment.unmatched_capture_refund_request
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.unmatched_capture_refund_request FROM PUBLIC;

CREATE TRIGGER unmatched_capture_refund_approval_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.unmatched_capture_refund_approval
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_unmatched_capture_refund_mutation();
CREATE TRIGGER unmatched_capture_refund_approval_no_truncate BEFORE TRUNCATE ON rms_payment.unmatched_capture_refund_approval
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_unmatched_capture_refund_mutation();
ALTER TABLE rms_payment.unmatched_capture_refund_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.unmatched_capture_refund_approval FORCE ROW LEVEL SECURITY;
CREATE POLICY unmatched_capture_refund_approval_scope ON rms_payment.unmatched_capture_refund_approval
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.unmatched_capture_refund_approval FROM PUBLIC;

CREATE TRIGGER unmatched_capture_refund_outcome_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.unmatched_capture_refund_outcome
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_unmatched_capture_refund_mutation();
CREATE TRIGGER unmatched_capture_refund_outcome_no_truncate BEFORE TRUNCATE ON rms_payment.unmatched_capture_refund_outcome
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_unmatched_capture_refund_mutation();
ALTER TABLE rms_payment.unmatched_capture_refund_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.unmatched_capture_refund_outcome FORCE ROW LEVEL SECURITY;
CREATE POLICY unmatched_capture_refund_outcome_scope ON rms_payment.unmatched_capture_refund_outcome
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.unmatched_capture_refund_outcome FROM PUBLIC;
