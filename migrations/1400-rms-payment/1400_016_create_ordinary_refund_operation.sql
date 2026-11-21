-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_payment.ordinary_refund_operation (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  request_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  provider_operation_id platform_helpers.uuid_v7 NOT NULL,
  payment_transaction_id platform_helpers.uuid_v7 NOT NULL,
  payment_intent_id platform_helpers.uuid_v7 NOT NULL,
  payment_attempt_id platform_helpers.uuid_v7 NOT NULL,
  first_capture_id platform_helpers.uuid_v7 NOT NULL,
  provider_account_id platform_helpers.uuid_v7 NOT NULL,
  executor_id platform_helpers.uuid_v7 NOT NULL,
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  approval_id platform_helpers.uuid_v7,
  claim_version bigint NOT NULL CHECK (claim_version BETWEEN 1 AND 9007199254740991),
  claims_digest text NOT NULL CHECK (claims_digest ~ '^sha256:[a-f0-9]{64}$'),
  allocation_digest text NOT NULL CHECK (allocation_digest ~ '^sha256:[a-f0-9]{64}$'),
  prepared_at timestamptz NOT NULL CHECK (isfinite(prepared_at) AND prepared_at=date_trunc('milliseconds',prepared_at)),
  environment text NOT NULL CHECK (environment IN ('Test','Live')),
  amount_minor bigint NOT NULL CHECK (amount_minor>0),
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=8192),
  CONSTRAINT ordinary_refund_operation_pk PRIMARY KEY (brand_id,store_id,operation_id),
  CONSTRAINT ordinary_refund_operation_leg_unique UNIQUE (brand_id,store_id,request_id,payment_attempt_id),
  CONSTRAINT ordinary_refund_operation_provider_unique UNIQUE (provider_account_id,environment,provider_operation_id),
  CONSTRAINT ordinary_refund_operation_request_fk FOREIGN KEY (brand_id,store_id,request_id)
    REFERENCES rms_payment.ordinary_refund_request (brand_id,store_id,request_id),
  CONSTRAINT ordinary_refund_operation_approval_fk FOREIGN KEY (brand_id,store_id,approval_id)
    REFERENCES rms_payment.ordinary_refund_approval (brand_id,store_id,approval_id),
  CONSTRAINT ordinary_refund_operation_json_binding CHECK (
    (record_json->>'tenantReference') IS NOT DISTINCT FROM tenant_id::text AND
    (record_json->>'brandReference') IS NOT DISTINCT FROM brand_id::text AND
    (record_json->>'storeReference') IS NOT DISTINCT FROM store_id::text AND
    (record_json->>'orderReference') IS NOT DISTINCT FROM order_id::text AND
    (record_json->>'requestReference') IS NOT DISTINCT FROM request_id::text AND
    (record_json->>'operationReference') IS NOT DISTINCT FROM operation_id::text AND
    (record_json->>'providerOperationReference') IS NOT DISTINCT FROM provider_operation_id::text AND
    (record_json->>'paymentTransactionReference') IS NOT DISTINCT FROM payment_transaction_id::text AND
    (record_json->>'paymentIntentReference') IS NOT DISTINCT FROM payment_intent_id::text AND
    (record_json->>'paymentAttemptReference') IS NOT DISTINCT FROM payment_attempt_id::text AND
    (record_json->>'firstCaptureReference') IS NOT DISTINCT FROM first_capture_id::text AND
    (record_json->>'providerAccountReference') IS NOT DISTINCT FROM provider_account_id::text AND
    (record_json->>'executorReference') IS NOT DISTINCT FROM executor_id::text AND
    (record_json->>'auditReference') IS NOT DISTINCT FROM audit_id::text AND
    (record_json->>'approvalReference') IS NOT DISTINCT FROM approval_id::text AND
    (record_json->>'claimVersion') IS NOT DISTINCT FROM claim_version::text AND
    (record_json->>'claimsDigest') IS NOT DISTINCT FROM claims_digest AND
    (record_json->>'allocationDigest') IS NOT DISTINCT FROM allocation_digest AND
    (record_json->>'preparedAt') IS NOT DISTINCT FROM to_char(prepared_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AND
    (record_json->>'environment') IS NOT DISTINCT FROM environment AND
    (record_json->>'amountMinor') IS NOT DISTINCT FROM amount_minor::text AND
    (record_json->>'currencyCode') IS NOT DISTINCT FROM 'CAD' AND
    (record_json->>'policyVersion') IS NOT DISTINCT FROM 'PILOT_ORDINARY_REFUND_V1' AND
    (record_json->>'status') IS NOT DISTINCT FROM 'Prepared'
  )
);
CREATE RULE ordinary_refund_operation_no_update AS ON UPDATE TO rms_payment.ordinary_refund_operation DO INSTEAD NOTHING;
CREATE RULE ordinary_refund_operation_no_delete AS ON DELETE TO rms_payment.ordinary_refund_operation DO INSTEAD NOTHING;
ALTER TABLE rms_payment.ordinary_refund_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.ordinary_refund_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY ordinary_refund_operation_scope_policy ON rms_payment.ordinary_refund_operation
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.ordinary_refund_operation FROM PUBLIC;
