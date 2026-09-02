-- bop-rms-migration: 1
-- owner: @bop/task
-- schema: bop_task
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA bop_task;
REVOKE ALL ON SCHEMA bop_task FROM PUBLIC;

CREATE FUNCTION bop_task.reject_support_case_history_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Support Case history is append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_task.reject_support_case_history_change() FROM PUBLIC;

CREATE TABLE bop_task.support_case_version (
  case_id platform_helpers.uuid_v7 NOT NULL,
  version_id platform_helpers.uuid_v7 NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('Open','Assigned','AccessPendingApproval','AccessGranted','Revoked','Closed')),
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  case_type text NOT NULL CHECK (case_type ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  purpose_code text NOT NULL CHECK (purpose_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  requester_actor_reference platform_helpers.uuid_v7 NOT NULL,
  requester_verification_evidence_reference platform_helpers.uuid_v7 NOT NULL,
  assigned_role_reference platform_helpers.uuid_v7,
  due_at timestamptz NOT NULL,
  supersedes_version_id platform_helpers.uuid_v7,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  data_classification text NOT NULL CHECK (data_classification='ConfidentialMetadata'),
  CONSTRAINT support_case_version_pkey PRIMARY KEY (case_id,version_id),
  CONSTRAINT support_case_version_unique UNIQUE (case_id,version),
  CONSTRAINT support_case_supersedes_fkey FOREIGN KEY (case_id,supersedes_version_id)
    REFERENCES bop_task.support_case_version(case_id,version_id),
  CONSTRAINT support_case_time CHECK (updated_at >= created_at AND due_at >= created_at),
  CONSTRAINT support_case_supersession CHECK ((version=1)=(supersedes_version_id IS NULL)),
  CONSTRAINT support_case_assignment CHECK ((status IN ('Assigned','AccessPendingApproval','AccessGranted','Revoked'))=(assigned_role_reference IS NOT NULL))
);

CREATE TABLE bop_task.diagnostic_access_grant (
  case_id platform_helpers.uuid_v7 NOT NULL,
  grant_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  support_actor_reference platform_helpers.uuid_v7 NOT NULL,
  requested_by_reference platform_helpers.uuid_v7 NOT NULL,
  approved_by_reference platform_helpers.uuid_v7 NOT NULL,
  approval_evidence_reference platform_helpers.uuid_v7 NOT NULL,
  recent_mfa_evidence_reference platform_helpers.uuid_v7 NOT NULL,
  purpose_code text NOT NULL CHECK (purpose_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  delegated_permissions text[] NOT NULL CHECK (cardinality(delegated_permissions) BETWEEN 1 AND 32),
  masking_policy_reference platform_helpers.uuid_v7 NOT NULL,
  granted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  data_classification text NOT NULL CHECK (data_classification='RestrictedAccessMetadata'),
  CONSTRAINT diagnostic_access_grant_pkey PRIMARY KEY (case_id,grant_id),
  CONSTRAINT diagnostic_access_grant_unique UNIQUE (grant_id),
  CONSTRAINT diagnostic_access_independent_approval CHECK (requested_by_reference<>approved_by_reference),
  CONSTRAINT diagnostic_access_expiry CHECK (expires_at>granted_at AND expires_at<=granted_at+interval '15 minutes'),
  CONSTRAINT diagnostic_access_permission_shape CHECK (array_to_string(delegated_permissions,',') ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){1,7}(,[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){1,7})*$')
);

CREATE TABLE bop_task.diagnostic_access_revocation (
  case_id platform_helpers.uuid_v7 NOT NULL,
  revocation_id platform_helpers.uuid_v7 NOT NULL,
  grant_id platform_helpers.uuid_v7 NOT NULL,
  revoked_by_reference platform_helpers.uuid_v7 NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  revoked_at timestamptz NOT NULL,
  data_classification text NOT NULL CHECK (data_classification='RestrictedAccessMetadata'),
  CONSTRAINT diagnostic_access_revocation_pkey PRIMARY KEY (case_id,revocation_id),
  CONSTRAINT diagnostic_access_revocation_grant_unique UNIQUE (grant_id),
  CONSTRAINT diagnostic_access_revocation_grant_fkey FOREIGN KEY (case_id,grant_id)
    REFERENCES bop_task.diagnostic_access_grant(case_id,grant_id)
);

CREATE TABLE bop_task.support_action_record (
  case_id platform_helpers.uuid_v7 NOT NULL,
  action_id platform_helpers.uuid_v7 NOT NULL,
  grant_id platform_helpers.uuid_v7 NOT NULL,
  support_actor_reference platform_helpers.uuid_v7 NOT NULL,
  delegated_permission text NOT NULL CHECK (delegated_permission ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){1,7}$'),
  target_type text NOT NULL CHECK (target_type ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  target_reference platform_helpers.uuid_v7 NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  evidence_reference platform_helpers.uuid_v7 NOT NULL,
  occurred_at timestamptz NOT NULL,
  data_classification text NOT NULL CHECK (data_classification='RestrictedAccessMetadata'),
  CONSTRAINT support_action_record_pkey PRIMARY KEY (case_id,action_id),
  CONSTRAINT support_action_grant_fkey FOREIGN KEY (case_id,grant_id)
    REFERENCES bop_task.diagnostic_access_grant(case_id,grant_id)
);

CREATE TABLE bop_task.support_case_operation (
  case_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  version_id platform_helpers.uuid_v7 NOT NULL,
  command_type text NOT NULL CHECK (command_type IN ('Create','Assign','RequestAccess','GrantAccess','RecordAction','RevokeAccess','Close')),
  expected_version bigint NOT NULL CHECK (expected_version >= 0),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  actor_reference platform_helpers.uuid_v7 NOT NULL,
  purpose_code text NOT NULL CHECK (purpose_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  audit_reference platform_helpers.uuid_v7 NOT NULL,
  occurred_at timestamptz NOT NULL,
  data_classification text NOT NULL CHECK (data_classification='RestrictedAccessMetadata'),
  CONSTRAINT support_case_operation_pkey PRIMARY KEY (case_id,operation_id),
  CONSTRAINT support_case_operation_unique UNIQUE (operation_id),
  CONSTRAINT support_case_operation_version_fkey FOREIGN KEY (case_id,version_id)
    REFERENCES bop_task.support_case_version(case_id,version_id)
);

CREATE INDEX support_case_list_idx ON bop_task.support_case_version (status,case_type,due_at,tenant_id,store_id,case_id,version DESC);
CREATE INDEX support_action_time_idx ON bop_task.support_action_record (case_id,occurred_at DESC,action_id DESC);

CREATE TRIGGER support_case_version_no_update BEFORE UPDATE ON bop_task.support_case_version FOR EACH ROW EXECUTE FUNCTION bop_task.reject_support_case_history_change();
CREATE RULE support_case_version_no_delete AS ON DELETE TO bop_task.support_case_version DO INSTEAD NOTHING;
CREATE TRIGGER diagnostic_access_grant_no_update BEFORE UPDATE ON bop_task.diagnostic_access_grant FOR EACH ROW EXECUTE FUNCTION bop_task.reject_support_case_history_change();
CREATE RULE diagnostic_access_grant_no_delete AS ON DELETE TO bop_task.diagnostic_access_grant DO INSTEAD NOTHING;
CREATE TRIGGER diagnostic_access_revocation_no_update BEFORE UPDATE ON bop_task.diagnostic_access_revocation FOR EACH ROW EXECUTE FUNCTION bop_task.reject_support_case_history_change();
CREATE RULE diagnostic_access_revocation_no_delete AS ON DELETE TO bop_task.diagnostic_access_revocation DO INSTEAD NOTHING;
CREATE TRIGGER support_action_record_no_update BEFORE UPDATE ON bop_task.support_action_record FOR EACH ROW EXECUTE FUNCTION bop_task.reject_support_case_history_change();
CREATE RULE support_action_record_no_delete AS ON DELETE TO bop_task.support_action_record DO INSTEAD NOTHING;
CREATE TRIGGER support_case_operation_no_update BEFORE UPDATE ON bop_task.support_case_operation FOR EACH ROW EXECUTE FUNCTION bop_task.reject_support_case_history_change();
CREATE RULE support_case_operation_no_delete AS ON DELETE TO bop_task.support_case_operation DO INSTEAD NOTHING;

ALTER TABLE bop_task.support_case_version ENABLE ROW LEVEL SECURITY; ALTER TABLE bop_task.support_case_version FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_task.diagnostic_access_grant ENABLE ROW LEVEL SECURITY; ALTER TABLE bop_task.diagnostic_access_grant FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_task.diagnostic_access_revocation ENABLE ROW LEVEL SECURITY; ALTER TABLE bop_task.diagnostic_access_revocation FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_task.support_action_record ENABLE ROW LEVEL SECURITY; ALTER TABLE bop_task.support_action_record FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_task.support_case_operation ENABLE ROW LEVEL SECURITY; ALTER TABLE bop_task.support_case_operation FORCE ROW LEVEL SECURITY;

CREATE POLICY support_case_exact_platform_context ON bop_task.support_case_version USING (NULLIF(current_setting('bop.platform_actor_id',true),'') IS NOT NULL AND NULLIF(current_setting('bop.platform_purpose',true),'') IS NOT NULL AND case_id::text=NULLIF(current_setting('bop.platform_support_case_id',true),'')) WITH CHECK (NULLIF(current_setting('bop.platform_actor_id',true),'') IS NOT NULL AND NULLIF(current_setting('bop.platform_purpose',true),'') IS NOT NULL AND case_id::text=NULLIF(current_setting('bop.platform_support_case_id',true),''));
CREATE POLICY diagnostic_grant_exact_platform_context ON bop_task.diagnostic_access_grant USING (NULLIF(current_setting('bop.platform_actor_id',true),'') IS NOT NULL AND NULLIF(current_setting('bop.platform_purpose',true),'') IS NOT NULL AND case_id::text=NULLIF(current_setting('bop.platform_support_case_id',true),'')) WITH CHECK (NULLIF(current_setting('bop.platform_actor_id',true),'') IS NOT NULL AND NULLIF(current_setting('bop.platform_purpose',true),'') IS NOT NULL AND case_id::text=NULLIF(current_setting('bop.platform_support_case_id',true),''));
CREATE POLICY diagnostic_revocation_exact_platform_context ON bop_task.diagnostic_access_revocation USING (NULLIF(current_setting('bop.platform_actor_id',true),'') IS NOT NULL AND NULLIF(current_setting('bop.platform_purpose',true),'') IS NOT NULL AND case_id::text=NULLIF(current_setting('bop.platform_support_case_id',true),'')) WITH CHECK (NULLIF(current_setting('bop.platform_actor_id',true),'') IS NOT NULL AND NULLIF(current_setting('bop.platform_purpose',true),'') IS NOT NULL AND case_id::text=NULLIF(current_setting('bop.platform_support_case_id',true),''));
CREATE POLICY support_action_exact_platform_context ON bop_task.support_action_record USING (NULLIF(current_setting('bop.platform_actor_id',true),'') IS NOT NULL AND NULLIF(current_setting('bop.platform_purpose',true),'') IS NOT NULL AND case_id::text=NULLIF(current_setting('bop.platform_support_case_id',true),'')) WITH CHECK (NULLIF(current_setting('bop.platform_actor_id',true),'') IS NOT NULL AND NULLIF(current_setting('bop.platform_purpose',true),'') IS NOT NULL AND case_id::text=NULLIF(current_setting('bop.platform_support_case_id',true),''));
CREATE POLICY support_operation_exact_platform_context ON bop_task.support_case_operation USING (NULLIF(current_setting('bop.platform_actor_id',true),'') IS NOT NULL AND NULLIF(current_setting('bop.platform_purpose',true),'') IS NOT NULL AND case_id::text=NULLIF(current_setting('bop.platform_support_case_id',true),'')) WITH CHECK (NULLIF(current_setting('bop.platform_actor_id',true),'') IS NOT NULL AND NULLIF(current_setting('bop.platform_purpose',true),'') IS NOT NULL AND case_id::text=NULLIF(current_setting('bop.platform_support_case_id',true),''));

REVOKE ALL ON TABLE bop_task.support_case_version,bop_task.diagnostic_access_grant,bop_task.diagnostic_access_revocation,bop_task.support_action_record,bop_task.support_case_operation FROM PUBLIC;
