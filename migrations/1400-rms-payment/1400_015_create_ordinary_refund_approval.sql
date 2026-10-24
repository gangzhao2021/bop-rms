-- bop-rms-migration: 1
-- owner: @rms/payment
-- schema: rms_payment
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_payment.ordinary_refund_approval (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  order_id platform_helpers.uuid_v7 NOT NULL,
  request_id platform_helpers.uuid_v7 NOT NULL,
  approval_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  requester_id platform_helpers.uuid_v7 NOT NULL,
  approver_id platform_helpers.uuid_v7 NOT NULL,
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  claim_version bigint NOT NULL CHECK (claim_version BETWEEN 1 AND 9007199254740991),
  approved_at timestamptz NOT NULL CHECK (isfinite(approved_at) AND approved_at=date_trunc('milliseconds',approved_at)),
  requester_mfa_at timestamptz NOT NULL CHECK (isfinite(requester_mfa_at)),
  approver_mfa_at timestamptz NOT NULL CHECK (isfinite(approver_mfa_at)),
  claims_digest text NOT NULL CHECK (claims_digest ~ '^sha256:[a-f0-9]{64}$'),
  allocation_digest text NOT NULL CHECK (allocation_digest ~ '^sha256:[a-f0-9]{64}$'),
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=8192),
  CONSTRAINT ordinary_refund_approval_pk PRIMARY KEY (brand_id,store_id,approval_id),
  CONSTRAINT ordinary_refund_approval_operation_unique UNIQUE (brand_id,store_id,operation_id),
  CONSTRAINT ordinary_refund_approval_request_fk FOREIGN KEY (brand_id,store_id,request_id)
    REFERENCES rms_payment.ordinary_refund_request (brand_id,store_id,request_id),
  CONSTRAINT ordinary_refund_approval_independent CHECK (requester_id<>approver_id),
  CONSTRAINT ordinary_refund_approval_recent_mfa CHECK (
    requester_mfa_at BETWEEN approved_at-interval '15 minutes' AND approved_at AND
    approver_mfa_at BETWEEN approved_at-interval '15 minutes' AND approved_at
  ),
  CONSTRAINT ordinary_refund_approval_json_binding CHECK (
    (record_json->>'approvalReference') IS NOT DISTINCT FROM approval_id::text AND
    (record_json->>'requesterReference') IS NOT DISTINCT FROM requester_id::text AND
    (record_json->>'approverReference') IS NOT DISTINCT FROM approver_id::text AND
    (record_json->>'approvedAt') IS NOT DISTINCT FROM to_char(approved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AND
    (record_json->>'requesterMfaAt') IS NOT DISTINCT FROM to_char(requester_mfa_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AND
    (record_json->>'approverMfaAt') IS NOT DISTINCT FROM to_char(approver_mfa_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AND
    (record_json->'subject'->>'tenantReference') IS NOT DISTINCT FROM tenant_id::text AND
    (record_json->'subject'->>'brandReference') IS NOT DISTINCT FROM brand_id::text AND
    (record_json->'subject'->>'storeReference') IS NOT DISTINCT FROM store_id::text AND
    (record_json->'subject'->>'orderReference') IS NOT DISTINCT FROM order_id::text AND
    (record_json->'subject'->>'requestReference') IS NOT DISTINCT FROM request_id::text AND
    (record_json->'subject'->>'policyVersion') IS NOT DISTINCT FROM 'PILOT_ORDINARY_REFUND_V1' AND
    (record_json->'subject'->>'claimsDigest') IS NOT DISTINCT FROM claims_digest AND
    (record_json->'subject'->>'allocationDigest') IS NOT DISTINCT FROM allocation_digest
  )
);
CREATE RULE ordinary_refund_approval_no_update AS ON UPDATE TO rms_payment.ordinary_refund_approval DO INSTEAD NOTHING;
CREATE RULE ordinary_refund_approval_no_delete AS ON DELETE TO rms_payment.ordinary_refund_approval DO INSTEAD NOTHING;
ALTER TABLE rms_payment.ordinary_refund_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_payment.ordinary_refund_approval FORCE ROW LEVEL SECURITY;
CREATE POLICY ordinary_refund_approval_scope_policy ON rms_payment.ordinary_refund_approval
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_payment.ordinary_refund_approval FROM PUBLIC;
