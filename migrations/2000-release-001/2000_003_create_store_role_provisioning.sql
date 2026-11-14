-- bop-rms-migration: 1
-- owner: @bop/permission
-- schema: bop_permission
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 / DEC-PERM-CATALOG: one signed Store opening provisioning of the template System roles per
-- Store. Records the exact plan digest, installed catalog version, Platform operator and the
-- independent Platform approver with the approval evidence and signing key. Append-only.
CREATE TABLE bop_permission.store_role_provisioning (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  catalog_version integer NOT NULL REFERENCES bop_permission.permission_catalog_revision(catalog_version),
  plan_digest text NOT NULL CHECK (plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  role_count integer NOT NULL CHECK (role_count BETWEEN 1 AND 16),
  grant_count integer NOT NULL CHECK (grant_count > 0),
  operator_id platform_helpers.uuid_v7 NOT NULL,
  approved_by platform_helpers.uuid_v7 NOT NULL,
  approval_evidence_id platform_helpers.uuid_v7 NOT NULL,
  approval_key_id platform_helpers.uuid_v7 NOT NULL,
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  applied_at timestamp with time zone NOT NULL CHECK (applied_at = date_trunc('milliseconds', applied_at)),
  data_classification text NOT NULL CHECK (data_classification = 'ConfigurationMetadata'),
  CONSTRAINT store_role_provisioning_store_unique UNIQUE (brand_id, store_id),
  CONSTRAINT store_role_provisioning_separation CHECK (approved_by <> operator_id)
);
CREATE FUNCTION bop_permission.reject_store_role_provisioning_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Store role provisioning records are append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_permission.reject_store_role_provisioning_change() FROM PUBLIC;
CREATE TRIGGER store_role_provisioning_append_only
  BEFORE UPDATE OR DELETE ON bop_permission.store_role_provisioning
  FOR EACH ROW EXECUTE FUNCTION bop_permission.reject_store_role_provisioning_change();
ALTER TABLE bop_permission.store_role_provisioning ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.store_role_provisioning FORCE ROW LEVEL SECURITY;
CREATE POLICY store_role_provisioning_scope ON bop_permission.store_role_provisioning
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE bop_permission.store_role_provisioning FROM PUBLIC;
