-- bop-rms-migration: 1
-- owner: @bop/permission
-- schema: bop_permission
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 role presets, DEC-SOLE-OPERATOR-APPROVAL (role changes; coordinator decision, the Owner
-- may overrule it; Owner standing approval 2026-10-14): a store run by one owner could never get a
-- role change approved, because it needed a second person who did not exist. While the Brand runs
-- alone (sole operator On and the submitter is the only person who approves roles at that scope)
-- the submitter may approve their own role change, with a second factor at most 15 minutes old and
-- never widening the role past what they hold themselves (checked by the application). The
-- decision is the existing append-only Approved version and decision row; this append-only record
-- marks it (approval_mode SoleOperator). Every other role change still needs a second person.
CREATE FUNCTION bop_permission.reject_role_administration_sole_operator_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'append-only role administration sole operator approval' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_permission.reject_role_administration_sole_operator_mutation() FROM PUBLIC;

CREATE TABLE bop_permission.role_administration_sole_operator_approval (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  -- Null for a Brand role.
  store_id platform_helpers.uuid_v7,
  administration_reference platform_helpers.uuid_v7 NOT NULL,
  approved_version bigint NOT NULL CHECK (approved_version > 0),
  approval_mode text NOT NULL CHECK (approval_mode = 'SoleOperator'),
  actor_id platform_helpers.uuid_v7 NOT NULL,
  actor_mfa_at timestamp with time zone NOT NULL CHECK (isfinite(actor_mfa_at)),
  approved_at timestamp with time zone NOT NULL CHECK (isfinite(approved_at)),
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  data_classification text NOT NULL CHECK (data_classification = 'ConfigurationMetadata'),
  CONSTRAINT role_administration_sole_operator_approval_pkey
    PRIMARY KEY (brand_id, administration_reference, approved_version),
  CONSTRAINT role_administration_sole_operator_approval_version_fkey
    FOREIGN KEY (brand_id, administration_reference, approved_version)
    REFERENCES bop_permission.role_administration_version (brand_id, administration_reference, version),
  CONSTRAINT role_administration_sole_operator_approval_recent_mfa CHECK (
    actor_mfa_at BETWEEN approved_at - interval '15 minutes' AND approved_at
  )
);

-- The checks read the exact rows they name as the migration owner (SECURITY DEFINER,
-- row_security off). A mark names an Approved version of the same scope approved by its own
-- submitter, the actor, at the mark's instant, while sole operator is On (held until the approval
-- commits).
CREATE FUNCTION bop_permission.check_role_administration_sole_operator_approval() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM bop_permission.role_administration_version v
    WHERE v.brand_id = NEW.brand_id AND v.administration_reference = NEW.administration_reference
      AND v.version = NEW.approved_version AND v.store_id IS NOT DISTINCT FROM NEW.store_id
      AND v.lifecycle = 'Approved' AND v.submitted_by_reference = NEW.actor_id
      AND v.approved_by_reference = NEW.actor_id AND v.changed_at = NEW.approved_at
  ) THEN
    RAISE EXCEPTION 'role administration sole operator approval must mark its submitter''s own approval' USING ERRCODE = '23514';
  END IF;
  IF bop_tenant.hold_brand_sole_operator_on(NEW.brand_id, NEW.approved_at) IS NOT TRUE THEN
    RAISE EXCEPTION 'role administration sole operator approval needs sole operator on' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_permission.check_role_administration_sole_operator_approval() FROM PUBLIC;
CREATE TRIGGER role_administration_sole_operator_approval_request
  BEFORE INSERT ON bop_permission.role_administration_sole_operator_approval
  FOR EACH ROW EXECUTE FUNCTION bop_permission.check_role_administration_sole_operator_approval();

-- At commit a mark stands only with its decision: Approved by the same person at the same instant.
CREATE FUNCTION bop_permission.check_role_administration_sole_operator_decided() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM bop_permission.role_administration_decision d
    WHERE d.brand_id = NEW.brand_id AND d.administration_reference = NEW.administration_reference
      AND d.administration_version = NEW.approved_version AND d.decision = 'Approved'
      AND d.actor_reference = NEW.actor_id AND d.occurred_at = NEW.approved_at
  ) THEN
    RAISE EXCEPTION 'role administration sole operator approval needs its approval' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION bop_permission.check_role_administration_sole_operator_decided() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER role_administration_sole_operator_approval_decided
  AFTER INSERT ON bop_permission.role_administration_sole_operator_approval
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bop_permission.check_role_administration_sole_operator_decided();

-- The version-side rule of 2000_320, now that the mark table exists.
CREATE CONSTRAINT TRIGGER role_administration_version_sole_operator
  AFTER INSERT ON bop_permission.role_administration_version
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bop_permission.check_role_administration_version_sole_operator();

CREATE TRIGGER role_administration_sole_operator_approval_no_mutation
  BEFORE UPDATE OR DELETE ON bop_permission.role_administration_sole_operator_approval
  FOR EACH ROW EXECUTE FUNCTION bop_permission.reject_role_administration_sole_operator_mutation();
CREATE TRIGGER role_administration_sole_operator_approval_no_truncate
  BEFORE TRUNCATE ON bop_permission.role_administration_sole_operator_approval
  FOR EACH STATEMENT EXECUTE FUNCTION bop_permission.reject_role_administration_sole_operator_mutation();
ALTER TABLE bop_permission.role_administration_sole_operator_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.role_administration_sole_operator_approval FORCE ROW LEVEL SECURITY;
CREATE POLICY role_administration_sole_operator_approval_scope ON bop_permission.role_administration_sole_operator_approval
  USING (brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id()))
  WITH CHECK (brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id()));
REVOKE ALL ON TABLE bop_permission.role_administration_sole_operator_approval FROM PUBLIC;
