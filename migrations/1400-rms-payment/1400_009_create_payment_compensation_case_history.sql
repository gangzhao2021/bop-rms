-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_payment.payment_compensation_case_history (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  case_id platform_helpers.uuid_v7 NOT NULL,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  operation_id platform_helpers.uuid_v7 NOT NULL,
  payment_attempt_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  fence_id platform_helpers.uuid_v7 NOT NULL,
  fence_version bigint NOT NULL CHECK (fence_version BETWEEN 1 AND 9007199254740991),
  audit_id platform_helpers.uuid_v7,
  updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at)),
  recorded_at timestamptz NOT NULL CHECK (recorded_at=date_trunc('milliseconds',recorded_at) AND recorded_at>=updated_at),
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=65536),
  CONSTRAINT payment_compensation_case_history_pk PRIMARY KEY (brand_id,store_id,case_id,version),
  CONSTRAINT payment_compensation_case_history_lease_fk FOREIGN KEY (brand_id,store_id,payment_attempt_id,fence_version)
    REFERENCES rms_payment.payment_compensation_lease_history (brand_id,store_id,payment_attempt_id,history_sequence),
  CONSTRAINT payment_compensation_case_history_open_audit CHECK ((version=1 AND audit_id IS NOT NULL) OR (version>1 AND audit_id IS NULL)),
  CONSTRAINT payment_compensation_case_history_json_binding CHECK (
    (record_json->>'brandReference') IS NOT DISTINCT FROM brand_id::text AND
    (record_json->>'storeReference') IS NOT DISTINCT FROM store_id::text AND
    (record_json->>'caseReference') IS NOT DISTINCT FROM case_id::text AND
    (record_json->>'version') IS NOT DISTINCT FROM version::text AND
    (record_json->>'operationReference') IS NOT DISTINCT FROM operation_id::text AND
    (record_json->>'paymentAttemptReference') IS NOT DISTINCT FROM payment_attempt_id::text AND
    (record_json->>'orderReference') IS NOT DISTINCT FROM order_id::text
  )
);
CREATE UNIQUE INDEX payment_compensation_case_history_attempt_idx
  ON rms_payment.payment_compensation_case_history (brand_id,store_id,payment_attempt_id) WHERE version=1;
CREATE UNIQUE INDEX payment_compensation_case_history_operation_idx
  ON rms_payment.payment_compensation_case_history (brand_id,store_id,operation_id) WHERE version=1;
CREATE UNIQUE INDEX payment_compensation_case_history_audit_idx
  ON rms_payment.payment_compensation_case_history (audit_id) WHERE audit_id IS NOT NULL;
CREATE INDEX payment_compensation_case_history_order_idx
  ON rms_payment.payment_compensation_case_history (brand_id,store_id,order_id,case_id,version DESC);
CREATE RULE payment_compensation_case_history_no_update AS ON UPDATE TO rms_payment.payment_compensation_case_history DO INSTEAD NOTHING;
CREATE RULE payment_compensation_case_history_no_delete AS ON DELETE TO rms_payment.payment_compensation_case_history DO INSTEAD NOTHING;
ALTER TABLE rms_payment.payment_compensation_case_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.payment_compensation_case_history FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_compensation_case_history_scope_policy ON rms_payment.payment_compensation_case_history
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.payment_compensation_case_history FROM PUBLIC;
