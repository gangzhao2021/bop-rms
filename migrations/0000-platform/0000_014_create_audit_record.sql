-- bop-rms-migration: 1
-- owner: shared-infrastructure/audit
-- schema: platform_audit
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE platform_audit.audit_record (
  audit_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  scope_store_key text GENERATED ALWAYS AS (COALESCE(store_id::text, 'brand')) STORED,
  actor_type text NOT NULL CHECK (actor_type IN ('User', 'System', 'Service')),
  actor_reference platform_helpers.uuid_v7,
  impersonation_reference platform_helpers.uuid_v7 CHECK (impersonation_reference IS NULL),
  action_code text NOT NULL CHECK (action_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  target_type text NOT NULL CHECK (target_type ~ '^[A-Z][A-Za-z0-9]{0,127}$'),
  target_id platform_helpers.uuid_v7 NOT NULL,
  before_summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  correlation_id platform_helpers.uuid_v7 NOT NULL,
  occurred_at timestamp with time zone NOT NULL,
  recorded_at timestamp with time zone NOT NULL DEFAULT statement_timestamp(),
  source_channel text NOT NULL CHECK (source_channel ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  device_network_reference platform_helpers.uuid_v7,
  data_classification text NOT NULL CHECK (data_classification IN ('Public', 'Internal', 'Confidential', 'Restricted')),
  retention_policy_code text NOT NULL CHECK (retention_policy_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  retention_policy_version integer NOT NULL CHECK (retention_policy_version > 0),
  corrects_audit_id platform_helpers.uuid_v7,
  CONSTRAINT audit_record_actor_shape_check CHECK (
    (actor_type = 'System' AND actor_reference IS NULL)
    OR (actor_type IN ('User', 'Service') AND actor_reference IS NOT NULL)
  ),
  CONSTRAINT audit_record_before_shape_check CHECK (
    jsonb_typeof(before_summary_json) = 'object'
    AND octet_length(before_summary_json::text) <= 16384
  ),
  CONSTRAINT audit_record_after_shape_check CHECK (
    jsonb_typeof(after_summary_json) = 'object'
    AND octet_length(after_summary_json::text) <= 16384
  ),
  CONSTRAINT audit_record_summary_total_check CHECK (
    octet_length(before_summary_json::text) + octet_length(after_summary_json::text) <= 32768
  ),
  CONSTRAINT audit_record_not_self_correction_check CHECK (
    corrects_audit_id IS NULL OR corrects_audit_id <> audit_id
  ),
  CONSTRAINT audit_record_occurred_at_check CHECK (
    occurred_at <= statement_timestamp() + interval '5 minutes'
  ),
  CONSTRAINT audit_record_scoped_reference_unique
    UNIQUE (audit_id, brand_id, scope_store_key),
  CONSTRAINT audit_record_correction_scope_fkey
    FOREIGN KEY (corrects_audit_id, brand_id, scope_store_key)
    REFERENCES platform_audit.audit_record (audit_id, brand_id, scope_store_key)
);

CREATE INDEX audit_record_scope_target_idx
  ON platform_audit.audit_record (brand_id, store_id, target_type, target_id, occurred_at, audit_id);
CREATE INDEX audit_record_scope_correlation_idx
  ON platform_audit.audit_record (brand_id, store_id, correlation_id, recorded_at, audit_id);
CREATE INDEX audit_record_correction_idx
  ON platform_audit.audit_record (brand_id, store_id, corrects_audit_id)
  WHERE corrects_audit_id IS NOT NULL;

ALTER TABLE platform_audit.audit_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit.audit_record FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_record_tenant_scope ON platform_audit.audit_record
  USING (
    brand_id = platform_helpers.current_brand_id()
    AND ((store_id IS NULL AND platform_helpers.current_store_id() IS NULL)
      OR store_id = platform_helpers.current_store_id())
  )
  WITH CHECK (
    brand_id = platform_helpers.current_brand_id()
    AND ((store_id IS NULL AND platform_helpers.current_store_id() IS NULL)
      OR store_id = platform_helpers.current_store_id())
  );
REVOKE ALL ON TABLE platform_audit.audit_record FROM PUBLIC;
