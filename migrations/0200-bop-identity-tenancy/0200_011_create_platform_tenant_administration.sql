-- bop-rms-migration: 1
-- owner: @bop/tenant
-- schema: bop_tenant
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE FUNCTION bop_tenant.reject_platform_tenant_history_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Platform Tenant administration history is append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_tenant.reject_platform_tenant_history_change() FROM PUBLIC;

CREATE TABLE bop_tenant.tenant_administration_version (
  version_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('Draft','PendingApproval','Approved','Active','SuspensionPending','Suspended','RestorePending')),
  region_code text NOT NULL CHECK (region_code ~ '^[A-Z]{2}(-[A-Z0-9]{2,12}){1,3}$'),
  environment text NOT NULL CHECK (environment IN ('NonProduction','Production')),
  plan_metadata_reference platform_helpers.uuid_v7 NOT NULL,
  data_policy_reference platform_helpers.uuid_v7 NOT NULL,
  retention_policy_reference platform_helpers.uuid_v7 NOT NULL,
  authored_by_reference platform_helpers.uuid_v7 NOT NULL,
  approved_by_reference platform_helpers.uuid_v7,
  approval_evidence_reference platform_helpers.uuid_v7,
  onboarding_evidence_reference platform_helpers.uuid_v7,
  impact_assessment_reference platform_helpers.uuid_v7,
  supersedes_version_reference platform_helpers.uuid_v7,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  data_classification text NOT NULL CHECK (data_classification='ConfigurationMetadata'),
  CONSTRAINT tenant_administration_version_pkey PRIMARY KEY (tenant_id,version_id),
  CONSTRAINT tenant_administration_version_unique UNIQUE (tenant_id,version),
  CONSTRAINT tenant_administration_supersedes_fkey FOREIGN KEY (tenant_id,supersedes_version_reference)
    REFERENCES bop_tenant.tenant_administration_version(tenant_id,version_id),
  CONSTRAINT tenant_administration_time CHECK (updated_at >= created_at),
  CONSTRAINT tenant_administration_supersession CHECK ((version=1)=(supersedes_version_reference IS NULL)),
  CONSTRAINT tenant_administration_approval_shape CHECK (
    (approved_by_reference IS NULL)=(approval_evidence_reference IS NULL)
    AND (approved_by_reference IS NULL OR approved_by_reference<>authored_by_reference)
    AND ((status IN ('Approved','Active','Suspended','RestorePending'))=(approved_by_reference IS NOT NULL))
  )
);

CREATE TABLE bop_tenant.tenant_capability_metadata_reference (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  version_id platform_helpers.uuid_v7 NOT NULL,
  capability_reference platform_helpers.uuid_v7 NOT NULL,
  data_classification text NOT NULL CHECK (data_classification='ConfigurationMetadata'),
  CONSTRAINT tenant_capability_metadata_reference_pkey PRIMARY KEY (tenant_id,version_id,capability_reference),
  CONSTRAINT tenant_capability_version_fkey FOREIGN KEY (tenant_id,version_id)
    REFERENCES bop_tenant.tenant_administration_version(tenant_id,version_id)
);

CREATE TABLE bop_tenant.tenant_administration_operation (
  operation_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  version_id platform_helpers.uuid_v7 NOT NULL,
  command_type text NOT NULL CHECK (command_type IN ('CreateDraft','SubmitOnboarding','ApproveOnboarding','ActivateTenant','ProposeConfiguration','ApproveConfiguration','RequestSuspension','ApproveSuspension','RequestRestore')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  actor_reference platform_helpers.uuid_v7 NOT NULL,
  purpose_code text NOT NULL CHECK (purpose_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  support_case_reference platform_helpers.uuid_v7 NOT NULL,
  audit_reference platform_helpers.uuid_v7 NOT NULL,
  occurred_at timestamptz NOT NULL,
  data_classification text NOT NULL CHECK (data_classification='ConfigurationMetadata'),
  CONSTRAINT tenant_administration_operation_pkey PRIMARY KEY (tenant_id,operation_id),
  CONSTRAINT tenant_administration_operation_reference_unique UNIQUE (operation_id),
  CONSTRAINT tenant_administration_operation_version_fkey FOREIGN KEY (tenant_id,version_id)
    REFERENCES bop_tenant.tenant_administration_version(tenant_id,version_id)
);

CREATE INDEX tenant_administration_list_idx ON bop_tenant.tenant_administration_version
  (region_code,status,environment,tenant_id,version DESC);
CREATE INDEX tenant_administration_operation_idx ON bop_tenant.tenant_administration_operation
  (tenant_id,occurred_at DESC,operation_id DESC);

CREATE TRIGGER tenant_administration_version_no_update BEFORE UPDATE ON bop_tenant.tenant_administration_version
  FOR EACH ROW EXECUTE FUNCTION bop_tenant.reject_platform_tenant_history_change();
CREATE RULE tenant_administration_version_no_delete AS ON DELETE TO bop_tenant.tenant_administration_version DO INSTEAD NOTHING;
CREATE TRIGGER tenant_capability_metadata_no_update BEFORE UPDATE ON bop_tenant.tenant_capability_metadata_reference
  FOR EACH ROW EXECUTE FUNCTION bop_tenant.reject_platform_tenant_history_change();
CREATE RULE tenant_capability_metadata_no_delete AS ON DELETE TO bop_tenant.tenant_capability_metadata_reference DO INSTEAD NOTHING;
CREATE TRIGGER tenant_administration_operation_no_update BEFORE UPDATE ON bop_tenant.tenant_administration_operation
  FOR EACH ROW EXECUTE FUNCTION bop_tenant.reject_platform_tenant_history_change();
CREATE RULE tenant_administration_operation_no_delete AS ON DELETE TO bop_tenant.tenant_administration_operation DO INSTEAD NOTHING;

ALTER TABLE bop_tenant.tenant_administration_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.tenant_administration_version FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.tenant_capability_metadata_reference ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.tenant_capability_metadata_reference FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.tenant_administration_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.tenant_administration_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_administration_platform_scope ON bop_tenant.tenant_administration_version
  USING (NULLIF(current_setting('bop.platform_actor_id',true),'') IS NOT NULL AND NULLIF(current_setting('bop.platform_purpose',true),'') IS NOT NULL AND NULLIF(current_setting('bop.platform_support_case_id',true),'') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('bop.platform_actor_id',true),'') IS NOT NULL AND NULLIF(current_setting('bop.platform_purpose',true),'') IS NOT NULL AND NULLIF(current_setting('bop.platform_support_case_id',true),'') IS NOT NULL);
CREATE POLICY tenant_capability_platform_scope ON bop_tenant.tenant_capability_metadata_reference
  USING (NULLIF(current_setting('bop.platform_actor_id',true),'') IS NOT NULL AND NULLIF(current_setting('bop.platform_purpose',true),'') IS NOT NULL AND NULLIF(current_setting('bop.platform_support_case_id',true),'') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('bop.platform_actor_id',true),'') IS NOT NULL AND NULLIF(current_setting('bop.platform_purpose',true),'') IS NOT NULL AND NULLIF(current_setting('bop.platform_support_case_id',true),'') IS NOT NULL);
CREATE POLICY tenant_operation_platform_scope ON bop_tenant.tenant_administration_operation
  USING (NULLIF(current_setting('bop.platform_actor_id',true),'') IS NOT NULL AND NULLIF(current_setting('bop.platform_purpose',true),'') IS NOT NULL AND NULLIF(current_setting('bop.platform_support_case_id',true),'') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('bop.platform_actor_id',true),'') IS NOT NULL AND NULLIF(current_setting('bop.platform_purpose',true),'') IS NOT NULL AND NULLIF(current_setting('bop.platform_support_case_id',true),'') IS NOT NULL);
REVOKE ALL ON TABLE bop_tenant.tenant_administration_version FROM PUBLIC;
REVOKE ALL ON TABLE bop_tenant.tenant_capability_metadata_reference FROM PUBLIC;
REVOKE ALL ON TABLE bop_tenant.tenant_administration_operation FROM PUBLIC;
