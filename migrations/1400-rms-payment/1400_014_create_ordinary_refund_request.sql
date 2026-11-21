-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_payment.ordinary_refund_request (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  request_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  claim_version bigint NOT NULL CHECK (claim_version BETWEEN 1 AND 9007199254740991),
  amount_minor bigint NOT NULL CHECK (amount_minor>0),
  requested_at timestamptz NOT NULL CHECK (isfinite(requested_at) AND requested_at=date_trunc('milliseconds',requested_at)),
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=65536),
  CONSTRAINT ordinary_refund_request_pk PRIMARY KEY (brand_id,store_id,request_id),
  CONSTRAINT ordinary_refund_request_operation_unique UNIQUE (brand_id,store_id,operation_id),
  CONSTRAINT ordinary_refund_request_version_unique UNIQUE (brand_id,store_id,order_id,claim_version),
  CONSTRAINT ordinary_refund_request_json_binding CHECK (
    (record_json->>'tenantReference') IS NOT DISTINCT FROM tenant_id::text AND
    (record_json->>'brandReference') IS NOT DISTINCT FROM brand_id::text AND
    (record_json->>'storeReference') IS NOT DISTINCT FROM store_id::text AND
    (record_json->>'orderReference') IS NOT DISTINCT FROM order_id::text AND
    (record_json->>'requestReference') IS NOT DISTINCT FROM request_id::text AND
    (record_json->>'operationReference') IS NOT DISTINCT FROM operation_id::text AND
    (record_json->>'actorReference') IS NOT DISTINCT FROM actor_id::text AND
    (record_json->>'auditReference') IS NOT DISTINCT FROM audit_id::text AND
    (record_json->>'expectedClaimVersion') IS NOT DISTINCT FROM (claim_version-1)::text AND
    (record_json->>'amountMinor') IS NOT DISTINCT FROM amount_minor::text AND
    (record_json->>'currencyCode') IS NOT DISTINCT FROM 'CAD' AND
    (record_json->>'policyVersion') IS NOT DISTINCT FROM 'PILOT_ORDINARY_REFUND_V1' AND
    (record_json->>'allocationVersion') IS NOT DISTINCT FROM 'ORDINARY_REFUND_ALLOCATION_V1' AND
    (record_json->>'requestedAt') IS NOT DISTINCT FROM to_char(requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
);
CREATE RULE ordinary_refund_request_no_update AS ON UPDATE TO rms_payment.ordinary_refund_request DO INSTEAD NOTHING;
CREATE RULE ordinary_refund_request_no_delete AS ON DELETE TO rms_payment.ordinary_refund_request DO INSTEAD NOTHING;
ALTER TABLE rms_payment.ordinary_refund_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.ordinary_refund_request FORCE ROW LEVEL SECURITY;
CREATE POLICY ordinary_refund_request_scope_policy ON rms_payment.ordinary_refund_request
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.ordinary_refund_request FROM PUBLIC;
