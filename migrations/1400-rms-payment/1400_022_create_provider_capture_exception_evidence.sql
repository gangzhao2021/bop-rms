-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_payment.provider_capture_exception_evidence (
 candidate_id platform_helpers.uuid_v7 PRIMARY KEY,
 reconciliation_exception_id platform_helpers.uuid_v7 NOT NULL,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 provider_account_id platform_helpers.uuid_v7 NOT NULL,
 environment text NOT NULL CHECK (environment IN ('Test','Live')),
 provider_intent_reference text NOT NULL CHECK (provider_intent_reference ~ '^[A-Za-z0-9][A-Za-z0-9_-]{6,126}[A-Za-z0-9]$'),
 provider_transaction_reference text NOT NULL CHECK (provider_transaction_reference ~ '^[A-Za-z0-9][A-Za-z0-9_-]{6,126}[A-Za-z0-9]$'),
 original_operation_id platform_helpers.uuid_v7 NOT NULL,
 original_attempt_id platform_helpers.uuid_v7 NOT NULL,
 amount_minor bigint NOT NULL CHECK (amount_minor>0),
 currency_code text NOT NULL CHECK (currency_code='CAD'),
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 observed_at timestamptz NOT NULL CHECK (isfinite(observed_at) AND observed_at=date_trunc('milliseconds',observed_at)),
 evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
 CHECK (occurred_at<=observed_at),
 UNIQUE (brand_id,store_id,provider_account_id,environment,provider_transaction_reference),
 FOREIGN KEY (reconciliation_exception_id,brand_id,store_id,candidate_id)
 REFERENCES rms_payment.payment_reconciliation_exception (reconciliation_exception_id,brand_id,store_id,candidate_id)
);
CREATE FUNCTION rms_payment.reject_provider_capture_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only Provider capture evidence' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.reject_provider_capture_evidence_mutation() FROM PUBLIC;
CREATE TRIGGER provider_capture_evidence_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.provider_capture_exception_evidence
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_provider_capture_evidence_mutation();
CREATE TRIGGER provider_capture_evidence_no_truncate BEFORE TRUNCATE ON rms_payment.provider_capture_exception_evidence
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_provider_capture_evidence_mutation();
ALTER TABLE rms_payment.provider_capture_exception_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.provider_capture_exception_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_capture_evidence_scope ON rms_payment.provider_capture_exception_evidence
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.provider_capture_exception_evidence FROM PUBLIC;
