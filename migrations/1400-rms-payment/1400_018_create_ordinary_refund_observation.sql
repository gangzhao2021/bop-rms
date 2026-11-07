-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_payment.ordinary_refund_observation (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  request_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  provider_operation_id platform_helpers.uuid_v7 NOT NULL,
  payment_attempt_id platform_helpers.uuid_v7 NOT NULL,
  dispatch_id platform_helpers.uuid_v7 NOT NULL,
  observation_id platform_helpers.uuid_v7 NOT NULL,
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  provider_request_digest text NOT NULL CHECK (provider_request_digest ~ '^sha256:[a-f0-9]{64}$'),
  provider_environment text NOT NULL CHECK (provider_environment IN ('Test','Live')),
  outcome_kind text NOT NULL CHECK (outcome_kind IN ('Snapshot','Failure')),
  recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=32768),
  CONSTRAINT ordinary_refund_observation_pk PRIMARY KEY (brand_id,store_id,observation_id),
  CONSTRAINT ordinary_refund_observation_dispatch_fk FOREIGN KEY (brand_id,store_id,dispatch_id)
    REFERENCES rms_payment.ordinary_refund_dispatch (brand_id,store_id,dispatch_id),
  CONSTRAINT ordinary_refund_observation_operation_fk FOREIGN KEY (brand_id,store_id,operation_id)
    REFERENCES rms_payment.ordinary_refund_operation (brand_id,store_id,operation_id),
  CONSTRAINT ordinary_refund_observation_json_binding CHECK (
    (record_json->>'tenantReference') IS NOT DISTINCT FROM tenant_id::text AND
    (record_json->>'brandReference') IS NOT DISTINCT FROM brand_id::text AND
    (record_json->>'storeReference') IS NOT DISTINCT FROM store_id::text AND
    (record_json->>'orderReference') IS NOT DISTINCT FROM order_id::text AND
    (record_json->>'requestReference') IS NOT DISTINCT FROM request_id::text AND
    (record_json->>'operationReference') IS NOT DISTINCT FROM operation_id::text AND
    (record_json->>'providerOperationReference') IS NOT DISTINCT FROM provider_operation_id::text AND
    (record_json->>'paymentAttemptReference') IS NOT DISTINCT FROM payment_attempt_id::text AND
    (record_json->>'dispatchReference') IS NOT DISTINCT FROM dispatch_id::text AND
    (record_json->>'observationReference') IS NOT DISTINCT FROM observation_id::text AND
    (record_json->>'auditReference') IS NOT DISTINCT FROM audit_id::text AND
    (record_json->>'providerRequestDigest') IS NOT DISTINCT FROM provider_request_digest AND
    (record_json->>'recordedAt') IS NOT DISTINCT FROM to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AND
    (record_json->>'state') IS NOT DISTINCT FROM 'NeedsReconciliation' AND
    (jsonb_typeof(record_json->'outcome')) IS NOT DISTINCT FROM 'object' AND
    (record_json#>>'{outcome,kind}') IS NOT DISTINCT FROM outcome_kind AND
    (record_json#>>'{outcome,context,provider}') IS NOT DISTINCT FROM 'Stripe' AND
    (record_json#>>'{outcome,context,environment}') IS NOT DISTINCT FROM provider_environment AND
    (record_json#>>'{outcome,context,brandReference}') IS NOT DISTINCT FROM brand_id::text AND
    (record_json#>>'{outcome,context,storeReference}') IS NOT DISTINCT FROM store_id::text AND
    (record_json#>>'{outcome,context,paymentAttemptReference}') IS NOT DISTINCT FROM payment_attempt_id::text AND
    (record_json#>>'{outcome,context,operationReference}') IS NOT DISTINCT FROM provider_operation_id::text
  )
);
CREATE RULE ordinary_refund_observation_no_update AS ON UPDATE TO rms_payment.ordinary_refund_observation DO INSTEAD NOTHING;
CREATE RULE ordinary_refund_observation_no_delete AS ON DELETE TO rms_payment.ordinary_refund_observation DO INSTEAD NOTHING;
ALTER TABLE rms_payment.ordinary_refund_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.ordinary_refund_observation FORCE ROW LEVEL SECURITY;
CREATE POLICY ordinary_refund_observation_scope_policy ON rms_payment.ordinary_refund_observation
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.ordinary_refund_observation FROM PUBLIC;
