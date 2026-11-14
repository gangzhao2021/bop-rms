-- bop-rms-migration: 1
-- owner: @bop/permission
-- schema: bop_permission
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 role presets (Owner request 2026-11-06 "预设一些角色与权限，另外允许店家自定义；店家也可以对
-- 预设进行增删改"; coordinator decision supplementing DEC-PERM-CATALOG and
-- DEC-SOLE-OPERATOR-APPROVAL, the Owner may overrule it; Owner standing approval 2026-10-14):
-- a Store edits a BOP preset or its own role as a new version of the same role, in the same
-- append-only history. A change waiting for approval may be withdrawn (Withdrawn, never deleted).
-- A sole owner may approve their own role change alone; such a version stands only with its
-- append-only mark (2000_321). A BOP upgrade never writes the preset over a Store's own version.
-- Every row already recorded satisfies the new rules.
ALTER TABLE bop_permission.role_administration_version
  DROP CONSTRAINT role_administration_version_lifecycle_check,
  ADD CONSTRAINT role_administration_version_lifecycle_check
    CHECK (lifecycle IN ('Draft','InReview','Approved','Active','Rejected','Deactivated','Withdrawn')),
  DROP CONSTRAINT role_administration_approval_shape,
  ADD CONSTRAINT role_administration_approval_shape CHECK (
    (lifecycle = 'Withdrawn'
      OR (lifecycle IN ('InReview','Approved','Active','Rejected','Deactivated')) = (submitted_by_reference IS NOT NULL))
    AND ((lifecycle IN ('Approved','Active','Deactivated')) = (approved_by_reference IS NOT NULL))
    AND ((lifecycle IN ('Approved','Active','Rejected','Deactivated','Withdrawn')) = (decision_evidence_reference IS NOT NULL))),
  -- Replaced by role_administration_version_sole_operator below: approved by the submitter only
  -- with a sole-operator mark.
  DROP CONSTRAINT role_administration_approval_separation;
ALTER TABLE bop_permission.role_administration_decision
  DROP CONSTRAINT role_administration_decision_decision_check,
  ADD CONSTRAINT role_administration_decision_decision_check
    CHECK (decision IN ('Submitted','Approved','Rejected','Activated','Deactivated','Withdrawn'));
ALTER TABLE bop_permission.role_administration_operation
  DROP CONSTRAINT role_administration_operation_command_type_check,
  ADD CONSTRAINT role_administration_operation_command_type_check
    CHECK (command_type IN ('SaveDraft','Duplicate','Submit','Approve','Reject','Activate','Deactivate',
      'Create','Revise','RestoreDefault','Withdraw','ApproveAlone'));

-- A BOP preset version (System) follows a Store's own version (Custom) only when the Store turns
-- on its approved restore of the preset, or when the platform has just withdrawn a change that was
-- waiting on top of a preset version. Otherwise a Store's version is never overwritten.
CREATE FUNCTION bop_permission.guard_role_administration_system_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE
  previous bop_permission.role_administration_version%ROWTYPE;
  effective_type text;
BEGIN
  IF NEW.role_type <> 'System' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO previous FROM bop_permission.role_administration_version v
  WHERE v.brand_id = NEW.brand_id AND v.administration_reference = NEW.administration_reference
    AND v.version = NEW.version - 1;
  IF NOT FOUND OR previous.role_type = 'System' THEN
    RETURN NEW;
  END IF;
  IF previous.lifecycle = 'Approved' AND NEW.lifecycle = 'Active' THEN
    RETURN NEW;
  END IF;
  IF previous.lifecycle IN ('Withdrawn','Rejected') THEN
    SELECT v.role_type INTO effective_type FROM bop_permission.role_administration_version v
    WHERE v.brand_id = NEW.brand_id AND v.administration_reference = NEW.administration_reference
      AND v.version < NEW.version AND v.lifecycle IN ('Active','Deactivated')
    ORDER BY v.version DESC LIMIT 1;
    IF effective_type = 'System' THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'a preset version never replaces a Store''s own role version' USING ERRCODE = '23514';
END;
$$;
REVOKE ALL ON FUNCTION bop_permission.guard_role_administration_system_version() FROM PUBLIC;
CREATE TRIGGER role_administration_version_system_guard
  BEFORE INSERT ON bop_permission.role_administration_version
  FOR EACH ROW EXECUTE FUNCTION bop_permission.guard_role_administration_system_version();

-- A version approved by its own submitter (and the Active/Deactivated versions that carry that
-- approval on, including a removal or bring-back after a later change was withdrawn) stands only
-- with the sole-operator mark of the approval it carries: the latest Approved version of the same
-- chain at or below it approved and submitted by that same person, marked for them. Checked at
-- commit, so the mark may be written after its version in the same transaction. Readers may
-- therefore take "approved by the submitter" as "approved alone as sole operator".
CREATE FUNCTION bop_permission.check_role_administration_version_sole_operator() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE
  cycle bigint;
BEGIN
  IF NEW.approved_by_reference IS NULL OR NEW.approved_by_reference <> NEW.submitted_by_reference THEN
    RETURN NULL;
  END IF;
  SELECT max(v.version) INTO cycle FROM bop_permission.role_administration_version v
  WHERE v.brand_id = NEW.brand_id AND v.administration_reference = NEW.administration_reference
    AND v.version <= NEW.version AND v.lifecycle = 'Approved'
    AND v.approved_by_reference = NEW.approved_by_reference
    AND v.submitted_by_reference = NEW.submitted_by_reference;
  IF cycle IS NULL OR NOT EXISTS (
    SELECT 1 FROM bop_permission.role_administration_sole_operator_approval m
    WHERE m.brand_id = NEW.brand_id AND m.administration_reference = NEW.administration_reference
      AND m.approved_version = cycle AND m.actor_id = NEW.approved_by_reference
  ) THEN
    RAISE EXCEPTION 'a role change approved by its submitter needs a sole operator approval' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION bop_permission.check_role_administration_version_sole_operator() FROM PUBLIC;
