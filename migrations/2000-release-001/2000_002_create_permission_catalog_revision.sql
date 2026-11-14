-- bop-rms-migration: 1
-- owner: @bop/permission
-- schema: bop_permission
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 / DEC-PERM-CATALOG: every release installs the versioned Store permission catalog into
-- permission_definition through one audited synchronizer. A revision records which catalog version
-- and digest was installed, by which release operator, under which independent release approval.
CREATE TABLE bop_permission.permission_catalog_revision (
  catalog_version integer PRIMARY KEY CHECK (catalog_version > 0),
  catalog_digest text NOT NULL CHECK (catalog_digest ~ '^sha256:[0-9a-f]{64}$'),
  operation_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  operator_id platform_helpers.uuid_v7 NOT NULL,
  approved_by platform_helpers.uuid_v7 NOT NULL,
  approval_evidence_id platform_helpers.uuid_v7 NOT NULL,
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  definition_count integer NOT NULL CHECK (definition_count > 0),
  added_count integer NOT NULL CHECK (added_count BETWEEN 0 AND definition_count),
  applied_at timestamp with time zone NOT NULL CHECK (applied_at = date_trunc('milliseconds', applied_at)),
  data_classification text NOT NULL CHECK (data_classification = 'ConfigurationMetadata'),
  CONSTRAINT permission_catalog_revision_separation CHECK (approved_by <> operator_id)
);
CREATE FUNCTION bop_permission.reject_permission_catalog_revision_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Permission catalog revisions are append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_permission.reject_permission_catalog_revision_change() FROM PUBLIC;
CREATE TRIGGER permission_catalog_revision_append_only
  BEFORE UPDATE OR DELETE ON bop_permission.permission_catalog_revision
  FOR EACH ROW EXECUTE FUNCTION bop_permission.reject_permission_catalog_revision_change();
