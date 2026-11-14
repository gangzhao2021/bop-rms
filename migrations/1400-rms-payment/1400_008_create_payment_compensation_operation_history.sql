-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_payment.payment_compensation_operation_history (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  history_version bigint NOT NULL CHECK (history_version BETWEEN 1 AND 9007199254740991),
  payment_attempt_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  case_id platform_helpers.uuid_v7 NOT NULL,
  fence_id platform_helpers.uuid_v7 NOT NULL,
  fence_version bigint NOT NULL CHECK (fence_version BETWEEN 1 AND 9007199254740991),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  result_digest text NOT NULL CHECK (result_digest ~ '^sha256:[a-f0-9]{64}$'),
  evaluated_at timestamptz NOT NULL CHECK (evaluated_at = date_trunc('milliseconds',evaluated_at)),
  recorded_at timestamptz NOT NULL CHECK (recorded_at = date_trunc('milliseconds',recorded_at) AND recorded_at >= evaluated_at),
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=65536),
  CONSTRAINT payment_compensation_operation_history_pk PRIMARY KEY (brand_id,store_id,operation_id,history_version),
  CONSTRAINT payment_compensation_operation_history_lease_fk FOREIGN KEY (brand_id,store_id,payment_attempt_id,fence_version)
    REFERENCES rms_payment.payment_compensation_lease_history (brand_id,store_id,payment_attempt_id,history_sequence),
  CONSTRAINT payment_compensation_operation_history_json_binding CHECK (
    (record_json->>'requestDigest') IS NOT DISTINCT FROM request_digest AND
    (record_json->>'resultDigest') IS NOT DISTINCT FROM result_digest AND
    (record_json->'disposition'->>'brandReference') IS NOT DISTINCT FROM brand_id::text AND
    (record_json->'disposition'->>'storeReference') IS NOT DISTINCT FROM store_id::text AND
    (record_json->'disposition'->>'orderReference') IS NOT DISTINCT FROM order_id::text AND
    (record_json->'disposition'->>'paymentAttemptReference') IS NOT DISTINCT FROM payment_attempt_id::text AND
    (record_json->'result'->>'operationReference') IS NOT DISTINCT FROM operation_id::text AND
    (record_json->'result'->>'caseReference') IS NOT DISTINCT FROM case_id::text
  )
);
CREATE INDEX payment_compensation_operation_history_order_idx
  ON rms_payment.payment_compensation_operation_history (brand_id,store_id,order_id);
CREATE RULE payment_compensation_operation_history_no_update AS
  ON UPDATE TO rms_payment.payment_compensation_operation_history DO INSTEAD NOTHING;
CREATE RULE payment_compensation_operation_history_no_delete AS
  ON DELETE TO rms_payment.payment_compensation_operation_history DO INSTEAD NOTHING;
ALTER TABLE rms_payment.payment_compensation_operation_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.payment_compensation_operation_history FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_compensation_operation_history_scope_policy ON rms_payment.payment_compensation_operation_history
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.payment_compensation_operation_history FROM PUBLIC;
