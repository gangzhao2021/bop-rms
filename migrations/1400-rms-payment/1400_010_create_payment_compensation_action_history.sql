-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_payment.payment_compensation_action_history (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  action_id platform_helpers.uuid_v7 NOT NULL,
  history_version bigint NOT NULL CHECK (history_version BETWEEN 1 AND 9007199254740991),
  case_id platform_helpers.uuid_v7 NOT NULL,
  case_version bigint NOT NULL DEFAULT 1 CHECK (case_version=1),
  order_id platform_helpers.uuid_v7 NOT NULL,
  payment_attempt_id platform_helpers.uuid_v7 NOT NULL,
  fence_id platform_helpers.uuid_v7 NOT NULL,
  fence_version bigint NOT NULL CHECK (fence_version BETWEEN 1 AND 9007199254740991),
  phase text NOT NULL CHECK (phase IN ('Claimed','InvocationUnknown','ProviderPending','ProviderConfirmed')),
  amount_minor bigint NOT NULL CHECK (amount_minor>0),
  provider_idempotency_key text NOT NULL,
  audit_id platform_helpers.uuid_v7,
  observed_at timestamptz NOT NULL CHECK (observed_at=date_trunc('milliseconds',observed_at)),
  recorded_at timestamptz NOT NULL CHECK (recorded_at=date_trunc('milliseconds',recorded_at) AND recorded_at>=observed_at),
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=65536),
  CONSTRAINT payment_compensation_action_history_pk PRIMARY KEY (brand_id,store_id,action_id,history_version),
  CONSTRAINT payment_compensation_action_history_case_fk FOREIGN KEY (brand_id,store_id,case_id,case_version)
    REFERENCES rms_payment.payment_compensation_case_history (brand_id,store_id,case_id,version),
  CONSTRAINT payment_compensation_action_history_lease_fk FOREIGN KEY (brand_id,store_id,payment_attempt_id,fence_version)
    REFERENCES rms_payment.payment_compensation_lease_history (brand_id,store_id,payment_attempt_id,history_sequence),
  CONSTRAINT payment_compensation_action_history_claim_audit CHECK (
    (history_version=1 AND phase='Claimed' AND audit_id IS NOT NULL) OR (history_version>1 AND phase<>'Claimed' AND audit_id IS NULL)),
  CONSTRAINT payment_compensation_action_history_json_binding CHECK (
    (record_json->>'brandReference') IS NOT DISTINCT FROM brand_id::text AND
    (record_json->>'storeReference') IS NOT DISTINCT FROM store_id::text AND
    (record_json->>'actionReference') IS NOT DISTINCT FROM action_id::text AND
    (record_json->>'compensationCaseReference') IS NOT DISTINCT FROM case_id::text AND
    (record_json->>'paymentAttemptReference') IS NOT DISTINCT FROM payment_attempt_id::text AND
    (record_json->>'phase') IS NOT DISTINCT FROM phase AND
    (record_json->>'providerIdempotencyKey') IS NOT DISTINCT FROM provider_idempotency_key AND
    (record_json->'amount'->>'amountMinor') IS NOT DISTINCT FROM amount_minor::text AND
    (record_json->'amount'->>'currencyCode') IS NOT DISTINCT FROM 'CAD' AND
    (record_json->>'claimDisposition') IS NOT DISTINCT FROM 'Claimed'
  )
);
CREATE UNIQUE INDEX payment_compensation_action_history_case_idx
  ON rms_payment.payment_compensation_action_history (brand_id,store_id,case_id) WHERE history_version=1;
CREATE UNIQUE INDEX payment_compensation_action_history_key_idx
  ON rms_payment.payment_compensation_action_history (brand_id,store_id,provider_idempotency_key) WHERE history_version=1;
CREATE UNIQUE INDEX payment_compensation_action_history_audit_idx
  ON rms_payment.payment_compensation_action_history (audit_id) WHERE audit_id IS NOT NULL;
CREATE INDEX payment_compensation_action_history_order_idx
  ON rms_payment.payment_compensation_action_history (brand_id,store_id,order_id);
CREATE RULE payment_compensation_action_history_no_update AS ON UPDATE TO rms_payment.payment_compensation_action_history DO INSTEAD NOTHING;
CREATE RULE payment_compensation_action_history_no_delete AS ON DELETE TO rms_payment.payment_compensation_action_history DO INSTEAD NOTHING;
ALTER TABLE rms_payment.payment_compensation_action_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.payment_compensation_action_history FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_compensation_action_history_scope_policy ON rms_payment.payment_compensation_action_history
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.payment_compensation_action_history FROM PUBLIC;
