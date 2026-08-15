-- bop-rms-migration: 1
-- owner: @bop/permission
-- schema: bop_permission
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE FUNCTION bop_permission.reject_role_administration_history_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Role administration history is append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_permission.reject_role_administration_history_update() FROM PUBLIC;

CREATE TABLE bop_permission.role_administration_version (
  administration_reference platform_helpers.uuid_v7 NOT NULL,
  role_id platform_helpers.uuid_v7 NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  role_code text COLLATE "C" NOT NULL CHECK (role_code ~ '^[a-z][a-z0-9_]{1,62}[a-z0-9]$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 180),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 180),
  role_type text NOT NULL CHECK (role_type IN ('System','Custom')),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft','InReview','Approved','Active','Rejected','Deactivated')),
  source_policy_version bigint NOT NULL CHECK (source_policy_version > 0),
  authored_by_reference platform_helpers.uuid_v7 NOT NULL,
  submitted_by_reference platform_helpers.uuid_v7,
  approved_by_reference platform_helpers.uuid_v7,
  decision_evidence_reference platform_helpers.uuid_v7,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  changed_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification='ConfigurationMetadata'),
  CONSTRAINT role_administration_version_pkey PRIMARY KEY (brand_id,administration_reference,version),
  CONSTRAINT role_administration_role_fkey FOREIGN KEY (role_id,brand_id) REFERENCES bop_permission.role(role_id,brand_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT role_administration_approval_separation CHECK (approved_by_reference IS NULL OR approved_by_reference<>submitted_by_reference),
  CONSTRAINT role_administration_approval_shape CHECK (((lifecycle IN ('InReview','Approved','Active','Rejected','Deactivated'))=(submitted_by_reference IS NOT NULL)) AND ((lifecycle IN ('Approved','Active','Deactivated'))=(approved_by_reference IS NOT NULL)) AND ((lifecycle IN ('Approved','Active','Rejected','Deactivated'))=(decision_evidence_reference IS NOT NULL))),
  CONSTRAINT role_administration_system_protection CHECK (role_type='Custom' OR lifecycle IN ('Active','Deactivated'))
);
CREATE UNIQUE INDEX role_administration_code_version_unique ON bop_permission.role_administration_version (brand_id,COALESCE(store_id,'00000000-0000-0000-0000-000000000000'::uuid),role_code,version);

CREATE TABLE bop_permission.role_administration_permission (
  selection_reference platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  administration_reference platform_helpers.uuid_v7 NOT NULL,
  administration_version bigint NOT NULL,
  permission_id platform_helpers.uuid_v7 NOT NULL,
  action_code text COLLATE "C" NOT NULL CHECK (action_code ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){1,7}$'),
  group_code text COLLATE "C" NOT NULL CHECK (group_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  high_risk boolean NOT NULL,
  dependency_actions jsonb NOT NULL CHECK (jsonb_typeof(dependency_actions)='array'),
  data_classification text NOT NULL CHECK (data_classification='ConfigurationMetadata'),
  CONSTRAINT role_administration_permission_pkey PRIMARY KEY (brand_id,selection_reference),
  CONSTRAINT role_administration_permission_version_fkey FOREIGN KEY (brand_id,administration_reference,administration_version) REFERENCES bop_permission.role_administration_version(brand_id,administration_reference,version),
  CONSTRAINT role_administration_permission_definition_fkey FOREIGN KEY (permission_id) REFERENCES bop_permission.permission_definition(permission_id),
  CONSTRAINT role_administration_permission_unique UNIQUE (brand_id,administration_reference,administration_version,permission_id),
  CONSTRAINT role_administration_action_unique UNIQUE (brand_id,administration_reference,administration_version,action_code)
);

CREATE TABLE bop_permission.role_administration_decision (
  decision_reference platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  administration_reference platform_helpers.uuid_v7 NOT NULL,
  administration_version bigint NOT NULL,
  decision text NOT NULL CHECK (decision IN ('Submitted','Approved','Rejected','Activated','Deactivated')),
  actor_reference platform_helpers.uuid_v7 NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  evidence_reference platform_helpers.uuid_v7 NOT NULL,
  occurred_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification='ConfigurationMetadata'),
  CONSTRAINT role_administration_decision_pkey PRIMARY KEY (brand_id,decision_reference),
  CONSTRAINT role_administration_decision_version_fkey FOREIGN KEY (brand_id,administration_reference,administration_version) REFERENCES bop_permission.role_administration_version(brand_id,administration_reference,version)
);

CREATE TABLE bop_permission.role_administration_operation (
  operation_reference platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  administration_reference platform_helpers.uuid_v7 NOT NULL,
  command_type text NOT NULL CHECK (command_type IN ('SaveDraft','Duplicate','Submit','Approve','Reject','Activate','Deactivate')),
  expected_version bigint NOT NULL CHECK (expected_version > 0),
  resulting_version bigint NOT NULL CHECK (resulting_version > 0),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  actor_reference platform_helpers.uuid_v7 NOT NULL,
  audit_reference platform_helpers.uuid_v7 NOT NULL,
  occurred_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification='ConfigurationMetadata'),
  CONSTRAINT role_administration_operation_pkey PRIMARY KEY (brand_id,operation_reference)
);

CREATE TRIGGER role_administration_version_no_update BEFORE UPDATE ON bop_permission.role_administration_version FOR EACH ROW EXECUTE FUNCTION bop_permission.reject_role_administration_history_update();
CREATE RULE role_administration_version_no_delete AS ON DELETE TO bop_permission.role_administration_version DO INSTEAD NOTHING;
CREATE TRIGGER role_administration_permission_no_update BEFORE UPDATE ON bop_permission.role_administration_permission FOR EACH ROW EXECUTE FUNCTION bop_permission.reject_role_administration_history_update();
CREATE RULE role_administration_permission_no_delete AS ON DELETE TO bop_permission.role_administration_permission DO INSTEAD NOTHING;
CREATE TRIGGER role_administration_decision_no_update BEFORE UPDATE ON bop_permission.role_administration_decision FOR EACH ROW EXECUTE FUNCTION bop_permission.reject_role_administration_history_update();
CREATE RULE role_administration_decision_no_delete AS ON DELETE TO bop_permission.role_administration_decision DO INSTEAD NOTHING;
CREATE TRIGGER role_administration_operation_no_update BEFORE UPDATE ON bop_permission.role_administration_operation FOR EACH ROW EXECUTE FUNCTION bop_permission.reject_role_administration_history_update();
CREATE RULE role_administration_operation_no_delete AS ON DELETE TO bop_permission.role_administration_operation DO INSTEAD NOTHING;

ALTER TABLE bop_permission.role_administration_version ENABLE ROW LEVEL SECURITY; ALTER TABLE bop_permission.role_administration_version FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.role_administration_permission ENABLE ROW LEVEL SECURITY; ALTER TABLE bop_permission.role_administration_permission FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.role_administration_decision ENABLE ROW LEVEL SECURITY; ALTER TABLE bop_permission.role_administration_decision FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.role_administration_operation ENABLE ROW LEVEL SECURITY; ALTER TABLE bop_permission.role_administration_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY role_administration_version_scope ON bop_permission.role_administration_version USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY role_administration_permission_scope ON bop_permission.role_administration_permission USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY role_administration_decision_scope ON bop_permission.role_administration_decision USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY role_administration_operation_scope ON bop_permission.role_administration_operation USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
REVOKE ALL ON TABLE bop_permission.role_administration_version,bop_permission.role_administration_permission,bop_permission.role_administration_decision,bop_permission.role_administration_operation FROM PUBLIC;
