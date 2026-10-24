-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_payment.reconciliation_follow_up_history (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 reconciliation_exception_id platform_helpers.uuid_v7 NOT NULL,
 candidate_id platform_helpers.uuid_v7 NOT NULL,
 version bigint NOT NULL CHECK (version>=2 AND version<9007199254740991),
 operation_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 action text NOT NULL CHECK (action IN ('Acknowledge','Assign')),
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 transition_json jsonb NOT NULL CHECK (jsonb_typeof(transition_json)='object' AND octet_length(transition_json::text)<=65536 AND jsonb_typeof(transition_json->'command')='object' AND jsonb_typeof(transition_json->'before')='object' AND jsonb_typeof(transition_json->'after')='object' AND transition_json ?& ARRAY['command','before','after']),
 PRIMARY KEY (tenant_id,brand_id,store_id,operation_id),
 UNIQUE (brand_id,store_id,reconciliation_exception_id,version),
 FOREIGN KEY (reconciliation_exception_id,brand_id,store_id,candidate_id)
 REFERENCES rms_payment.payment_reconciliation_exception (reconciliation_exception_id,brand_id,store_id,candidate_id)
);
CREATE FUNCTION rms_payment.reject_reconciliation_follow_up_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only reconciliation follow-up history' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_payment.reject_reconciliation_follow_up_mutation() FROM PUBLIC;
CREATE TRIGGER reconciliation_follow_up_no_mutation BEFORE UPDATE OR DELETE ON rms_payment.reconciliation_follow_up_history
 FOR EACH ROW EXECUTE FUNCTION rms_payment.reject_reconciliation_follow_up_mutation();
CREATE TRIGGER reconciliation_follow_up_no_truncate BEFORE TRUNCATE ON rms_payment.reconciliation_follow_up_history
 FOR EACH STATEMENT EXECUTE FUNCTION rms_payment.reject_reconciliation_follow_up_mutation();
ALTER TABLE rms_payment.reconciliation_follow_up_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.reconciliation_follow_up_history FORCE ROW LEVEL SECURITY;
CREATE POLICY reconciliation_follow_up_scope ON rms_payment.reconciliation_follow_up_history
 USING (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (tenant_id=NULLIF(current_setting('bop.tenant_id',true),'')::uuid AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.reconciliation_follow_up_history FROM PUBLIC;
