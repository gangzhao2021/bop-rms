-- bop-rms-migration: 1
-- owner: @bop/permission
-- schema: bop_permission
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 / DEC-PERM-BRAND-ROLES: Brand-level template System roles (no Store) for facts every Store
-- of the Brand shares. Opened once per Brand under a signed plan, upgraded strictly forward, with the
-- plan digest, catalog version, Platform operator and independent Platform approver recorded.
CREATE TABLE bop_permission.brand_role_provisioning (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  catalog_version integer NOT NULL REFERENCES bop_permission.permission_catalog_revision(catalog_version),
  previous_catalog_version integer,
  plan_digest text NOT NULL CHECK (plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  role_count integer NOT NULL CHECK (role_count BETWEEN 1 AND 16),
  grant_count integer NOT NULL CHECK (grant_count > 0),
  operator_id platform_helpers.uuid_v7 NOT NULL,
  approved_by platform_helpers.uuid_v7 NOT NULL,
  approval_evidence_id platform_helpers.uuid_v7 NOT NULL,
  approval_key_id platform_helpers.uuid_v7 NOT NULL,
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  owner_assignment_id platform_helpers.uuid_v7,
  applied_at timestamp with time zone NOT NULL CHECK (applied_at = date_trunc('milliseconds', applied_at)),
  data_classification text NOT NULL CHECK (data_classification = 'ConfigurationMetadata'),
  CONSTRAINT brand_role_provisioning_version_unique UNIQUE (brand_id, catalog_version),
  CONSTRAINT brand_role_provisioning_forward CHECK (
    previous_catalog_version IS NULL OR previous_catalog_version < catalog_version
  ),
  CONSTRAINT brand_role_provisioning_separation CHECK (approved_by <> operator_id)
);
CREATE UNIQUE INDEX brand_role_provisioning_opening_unique
  ON bop_permission.brand_role_provisioning (brand_id)
  WHERE previous_catalog_version IS NULL;
CREATE FUNCTION bop_permission.reject_brand_role_provisioning_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Brand role provisioning records are append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_permission.reject_brand_role_provisioning_change() FROM PUBLIC;
CREATE TRIGGER brand_role_provisioning_append_only
  BEFORE UPDATE OR DELETE ON bop_permission.brand_role_provisioning
  FOR EACH ROW EXECUTE FUNCTION bop_permission.reject_brand_role_provisioning_change();
ALTER TABLE bop_permission.brand_role_provisioning ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.brand_role_provisioning FORCE ROW LEVEL SECURITY;
CREATE POLICY brand_role_provisioning_scope ON bop_permission.brand_role_provisioning
  USING (brand_id = platform_helpers.current_brand_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id());
REVOKE ALL ON TABLE bop_permission.brand_role_provisioning FROM PUBLIC;

-- Brand role assignment changes carry no Store: the subject needs an Active Brand Membership only.
ALTER TABLE bop_permission.role_assignment_change
  ALTER COLUMN store_id DROP NOT NULL,
  ALTER COLUMN store_assignment_id DROP NOT NULL,
  ADD CONSTRAINT role_assignment_change_scope_shape CHECK ((store_id IS NULL) = (store_assignment_id IS NULL));
ALTER TABLE bop_permission.role_assignment_change_decision
  ALTER COLUMN store_id DROP NOT NULL;
DROP POLICY role_assignment_change_scope ON bop_permission.role_assignment_change;
DROP POLICY role_assignment_change_decision_scope ON bop_permission.role_assignment_change_decision;
CREATE POLICY role_assignment_change_scope ON bop_permission.role_assignment_change
  USING (brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id()))
  WITH CHECK (brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id()));
CREATE POLICY role_assignment_change_decision_scope ON bop_permission.role_assignment_change_decision
  USING (brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id()))
  WITH CHECK (brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id()));
CREATE OR REPLACE FUNCTION bop_permission.enforce_role_assignment_change_decision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  change bop_permission.role_assignment_change%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Role assignment change history is append-only' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO change FROM bop_permission.role_assignment_change WHERE change_id = NEW.change_id;
  IF change.brand_id <> NEW.brand_id OR change.store_id IS DISTINCT FROM NEW.store_id THEN
    RAISE EXCEPTION 'Role assignment decision scope mismatch' USING ERRCODE = '23514';
  END IF;
  -- An assignment is decided by someone other than its requester and its subject; a revocation applies at once.
  IF change.kind = 'Assign' AND (NEW.decision = 'Applied'
      OR (NEW.decision IN ('Approved', 'Rejected')
        AND (NEW.decided_by = change.requested_by OR NEW.decided_by = change.actor_id))
      OR (NEW.decision = 'Withdrawn' AND NEW.decided_by <> change.requested_by)) THEN
    RAISE EXCEPTION 'Role assignment needs an independent decision' USING ERRCODE = '23514';
  END IF;
  IF change.kind = 'Revoke' AND (NEW.decision <> 'Applied' OR NEW.decided_by <> change.requested_by) THEN
    RAISE EXCEPTION 'Role assignment revocation is applied by its requester' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
