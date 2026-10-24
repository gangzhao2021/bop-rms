-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_payment.payment_compensation_refund (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  refund_id platform_helpers.uuid_v7 NOT NULL,
  case_id platform_helpers.uuid_v7 NOT NULL,
  case_version bigint NOT NULL DEFAULT 1 CHECK (case_version=1),
  order_id platform_helpers.uuid_v7 NOT NULL,
  payment_attempt_id platform_helpers.uuid_v7 NOT NULL,
  event_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  fence_id platform_helpers.uuid_v7 NOT NULL,
  fence_version bigint NOT NULL CHECK (fence_version BETWEEN 1 AND 9007199254740991),
  amount_minor bigint NOT NULL CHECK (amount_minor>0),
  recorded_at timestamptz NOT NULL CHECK (recorded_at=date_trunc('milliseconds',recorded_at)),
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=65536),
  CONSTRAINT payment_compensation_refund_pk PRIMARY KEY (brand_id,store_id,refund_id),
  CONSTRAINT payment_compensation_refund_case_unique UNIQUE (brand_id,store_id,case_id),
  CONSTRAINT payment_compensation_refund_case_fk FOREIGN KEY (brand_id,store_id,case_id,case_version)
    REFERENCES rms_payment.payment_compensation_case_history (brand_id,store_id,case_id,version),
  CONSTRAINT payment_compensation_refund_lease_fk FOREIGN KEY (brand_id,store_id,payment_attempt_id,fence_version)
    REFERENCES rms_payment.payment_compensation_lease_history (brand_id,store_id,payment_attempt_id,history_sequence),
  CONSTRAINT payment_compensation_refund_json_binding CHECK (
    (record_json->'fact'->>'brandReference') IS NOT DISTINCT FROM brand_id::text AND
    (record_json->'fact'->>'storeReference') IS NOT DISTINCT FROM store_id::text AND
    (record_json->'fact'->>'refundReference') IS NOT DISTINCT FROM refund_id::text AND
    (record_json->'fact'->>'compensationCaseReference') IS NOT DISTINCT FROM case_id::text AND
    (record_json->'fact'->>'orderReference') IS NOT DISTINCT FROM order_id::text AND
    (record_json->'fact'->>'paymentAttemptReference') IS NOT DISTINCT FROM payment_attempt_id::text AND
    (record_json->'fact'->>'eventReference') IS NOT DISTINCT FROM event_id::text AND
    (record_json->'event'->>'eventId') IS NOT DISTINCT FROM event_id::text AND
    (record_json->'event'->>'tenantId') IS NOT DISTINCT FROM brand_id::text AND
    (record_json->'event'->>'storeId') IS NOT DISTINCT FROM store_id::text AND
    (record_json->'fact'->'amount'->>'amountMinor') IS NOT DISTINCT FROM amount_minor::text AND
    (record_json->'fact'->'amount'->>'currencyCode') IS NOT DISTINCT FROM 'CAD' AND
    (record_json->'event'->'payload'->>'amountMinor') IS NOT DISTINCT FROM amount_minor::text
  )
);
CREATE INDEX payment_compensation_refund_order_idx ON rms_payment.payment_compensation_refund (brand_id,store_id,order_id);
CREATE RULE payment_compensation_refund_no_update AS ON UPDATE TO rms_payment.payment_compensation_refund DO INSTEAD NOTHING;
CREATE RULE payment_compensation_refund_no_delete AS ON DELETE TO rms_payment.payment_compensation_refund DO INSTEAD NOTHING;
ALTER TABLE rms_payment.payment_compensation_refund ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.payment_compensation_refund FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_compensation_refund_scope_policy ON rms_payment.payment_compensation_refund
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.payment_compensation_refund FROM PUBLIC;
