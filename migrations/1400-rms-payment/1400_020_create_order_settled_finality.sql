-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_payment.order_settled_finality (
 finality_id platform_helpers.uuid_v7 PRIMARY KEY,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 provider_account_id platform_helpers.uuid_v7 NOT NULL,
 environment text NOT NULL CHECK (environment IN ('Test','Live')),
 order_id platform_helpers.uuid_v7 NOT NULL,
 order_version integer NOT NULL CHECK (order_version>0),
 order_checkpoint platform_helpers.uuid_v7 NOT NULL,
 classification text NOT NULL CHECK (classification='Settled'),
 currency_code text NOT NULL CHECK (currency_code='CAD'),
 priced_order_total_minor bigint NOT NULL CHECK (priced_order_total_minor>=0),
 captured_minor bigint NOT NULL CHECK (captured_minor>=0),
 captured_order_allocation_minor bigint NOT NULL CHECK (captured_order_allocation_minor>=0),
 captured_tip_minor bigint NOT NULL CHECK (captured_tip_minor>=0),
 order_evidence_digest text NOT NULL CHECK (order_evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
 payment_evidence_digest text NOT NULL CHECK (payment_evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
 decided_at timestamptz NOT NULL CHECK (isfinite(decided_at) AND decided_at=date_trunc('milliseconds',decided_at)),
 UNIQUE (brand_id,store_id,provider_account_id,environment,operation_id),
 CHECK (priced_order_total_minor=captured_order_allocation_minor),
 CHECK (captured_minor::numeric=captured_order_allocation_minor::numeric+captured_tip_minor::numeric)
);
CREATE INDEX order_settled_finality_order_idx ON rms_payment.order_settled_finality
 (brand_id,store_id,provider_account_id,environment,order_id,decided_at);
CREATE FUNCTION rms_payment.reject_order_settled_finality_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only financial finality' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.reject_order_settled_finality_mutation() FROM PUBLIC;
CREATE TRIGGER order_settled_finality_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.order_settled_finality
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_order_settled_finality_mutation();
CREATE TRIGGER order_settled_finality_no_truncate BEFORE TRUNCATE ON rms_payment.order_settled_finality
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_order_settled_finality_mutation();
ALTER TABLE rms_payment.order_settled_finality ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.order_settled_finality FORCE ROW LEVEL SECURITY;
CREATE POLICY order_settled_finality_scope ON rms_payment.order_settled_finality
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.order_settled_finality FROM PUBLIC;
