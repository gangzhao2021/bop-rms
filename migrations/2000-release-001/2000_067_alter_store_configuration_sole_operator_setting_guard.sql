-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-SOLE-OPERATOR-APPROVAL (v15 defect 2026-10-16, Owner standing approval 2026-10-14
-- WP-2423 sole operator): an application defect read the Brand's sole-operator setting version 9
-- ("On") as the latest after version 10 turned it off, and an Owner's own hours change was marked
-- as approved alone. The database now checks the setting itself (Organization read
-- of the setting, 2000_066):
-- 1. A sole-operator mark is recorded only while the Brand's sole-operator setting was On at the
--    marked approval instant and is still On (the setting is held until the approval commits).
-- 2. An approval or publication that relies on a mark (approver = author or sender) is accepted
--    only if the setting was On at the marked approval instant: a mark recorded while it was off
--    (before this guard) cannot be published; its author withdraws the change instead.
-- Every other condition (2000_060, 2000_064) is unchanged; rows already recorded are kept.
CREATE FUNCTION rms_store.check_store_configuration_sole_operator_setting() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
  IF bop_tenant.hold_brand_sole_operator_on(NEW.brand_id, NEW.approved_at) IS NOT TRUE THEN
    RAISE EXCEPTION 'store configuration sole operator approval needs sole operator on' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_store.check_store_configuration_sole_operator_setting() FROM PUBLIC;
CREATE TRIGGER store_configuration_sole_operator_setting_on BEFORE INSERT ON rms_store.store_configuration_sole_operator_approval
  FOR EACH ROW EXECUTE FUNCTION rms_store.check_store_configuration_sole_operator_setting();

CREATE OR REPLACE FUNCTION rms_store.check_store_configuration_authoring_approver() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE
  approver text := NEW.configuration_json->>'approvedByReference';
BEGIN
  IF NEW.command_type NOT IN ('Approve','Publish') OR approver IS NULL THEN
    RETURN NEW;
  END IF;
  IF approver<>NEW.configuration_json->>'authoredByReference' AND NOT EXISTS (
    SELECT 1 FROM rms_store.store_configuration_authoring_operation s
    WHERE s.brand_id=NEW.brand_id AND s.store_id=NEW.store_id AND s.configuration_id=NEW.configuration_id
      AND s.command_type='Submit' AND s.actor_reference::text=approver
  ) THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM rms_store.store_configuration_sole_operator_approval m
    WHERE m.brand_id=NEW.brand_id AND m.store_id=NEW.store_id AND m.configuration_id=NEW.configuration_id
      AND m.actor_id::text=approver
      AND m.approval_evidence_id::text=NEW.configuration_json->>'approvalEvidenceReference'
      AND (NEW.command_type<>'Approve' OR (m.operation_id=NEW.operation_id
        AND m.audit_id=NEW.audit_reference AND m.approved_at=NEW.occurred_at))
      AND bop_tenant.brand_sole_operator_was_on(m.brand_id, m.approved_at)
  ) THEN
    RAISE EXCEPTION 'store configuration approval needs another person' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_store.check_store_configuration_authoring_approver() FROM PUBLIC;

CREATE OR REPLACE FUNCTION rms_store.check_store_configuration_version_approver() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
  IF NEW.approved_by_reference IS NOT NULL AND NEW.approved_by_reference=NEW.authored_by_reference
    AND NOT EXISTS (
      SELECT 1 FROM rms_store.store_configuration_sole_operator_approval m
      WHERE m.brand_id=NEW.brand_id AND m.store_id=NEW.store_id AND m.configuration_id=NEW.configuration_id
        AND m.actor_id=NEW.approved_by_reference AND m.approval_evidence_id=NEW.approval_evidence_reference
        AND bop_tenant.brand_sole_operator_was_on(m.brand_id, m.approved_at)
    ) THEN
    RAISE EXCEPTION 'store configuration approval needs another person' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_store.check_store_configuration_version_approver() FROM PUBLIC;
