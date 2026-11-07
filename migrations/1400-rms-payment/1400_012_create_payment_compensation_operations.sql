-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_payment.payment_compensation_operations (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  receipt_id platform_helpers.uuid_v7 NOT NULL,
  case_id platform_helpers.uuid_v7 NOT NULL,
  case_version bigint NOT NULL CHECK (case_version BETWEEN 1 AND 9007199254740991),
  order_id platform_helpers.uuid_v7 NOT NULL,
  refund_id platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  recorded_at timestamptz NOT NULL CHECK (recorded_at=date_trunc('milliseconds',recorded_at)),
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=65536),
  CONSTRAINT payment_compensation_operations_pk PRIMARY KEY (brand_id,store_id,receipt_id),
  CONSTRAINT payment_compensation_operations_case_unique UNIQUE (brand_id,store_id,case_id),
  CONSTRAINT payment_compensation_operations_case_fk FOREIGN KEY (brand_id,store_id,case_id,case_version)
    REFERENCES rms_payment.payment_compensation_case_history (brand_id,store_id,case_id,version),
  CONSTRAINT payment_compensation_operations_json_binding CHECK (
    (record_json->>'brandReference') IS NOT DISTINCT FROM brand_id::text AND
    (record_json->>'storeReference') IS NOT DISTINCT FROM store_id::text AND
    (record_json->>'receiptReference') IS NOT DISTINCT FROM receipt_id::text AND
    (record_json->>'compensationCaseReference') IS NOT DISTINCT FROM case_id::text AND
    (record_json->>'refundReference') IS NOT DISTINCT FROM refund_id::text AND
    (record_json->>'actorReference') IS NOT DISTINCT FROM actor_id::text AND
    (record_json->'audit'->>'auditId') IS NOT DISTINCT FROM audit_id::text AND
    (record_json->>'purpose') IS NOT DISTINCT FROM 'ReconcilePaidWithoutFulfillableOrder'
  )
);
CREATE INDEX payment_compensation_operations_order_idx ON rms_payment.payment_compensation_operations (brand_id,store_id,order_id);
CREATE RULE payment_compensation_operations_no_update AS ON UPDATE TO rms_payment.payment_compensation_operations DO INSTEAD NOTHING;
CREATE RULE payment_compensation_operations_no_delete AS ON DELETE TO rms_payment.payment_compensation_operations DO INSTEAD NOTHING;
ALTER TABLE rms_payment.payment_compensation_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.payment_compensation_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_compensation_operations_scope_policy ON rms_payment.payment_compensation_operations
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.payment_compensation_operations FROM PUBLIC;
