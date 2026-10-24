-- bop-rms-migration: 1
-- owner: @rms/printing-device
-- schema: rms_device
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-SOLE-OPERATOR-APPROVAL (v15 defect 2026-10-16, Owner standing approval 2026-10-14
-- WP-2423 sole operator): the same database check as 2000_067 for the receipt template. An
-- application defect read the Brand's sole-operator setting version 9 ("On") as the latest after
-- version 10 turned it off. Now (Organization read, 2000_066):
-- 1. A receipt template sole-operator mark is recorded only while the Brand's sole-operator setting
--    was On at the marked approval instant and is still On (held until the approval commits).
-- 2. An approval or publication that relies on a mark (approver = author or sender) is accepted
--    only if the setting was On at the marked approval instant.
-- Every other condition (2000_063) is unchanged; rows already recorded are kept.
CREATE FUNCTION rms_device.check_receipt_template_sole_operator_setting() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
  IF bop_tenant.hold_brand_sole_operator_on(NEW.brand_id, NEW.approved_at) IS NOT TRUE THEN
    RAISE EXCEPTION 'receipt template sole operator approval needs sole operator on' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_device.check_receipt_template_sole_operator_setting() FROM PUBLIC;
CREATE TRIGGER digital_receipt_template_sole_operator_setting_on BEFORE INSERT ON rms_device.digital_receipt_template_sole_operator_approval
  FOR EACH ROW EXECUTE FUNCTION rms_device.check_receipt_template_sole_operator_setting();

CREATE OR REPLACE FUNCTION rms_device.check_receipt_template_lifecycle_approver() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE
  result jsonb := NEW.receipt_json->'result';
  original rms_device.digital_receipt_template_submission%ROWTYPE;
BEGIN
  IF NEW.outcome<>'Committed' OR jsonb_typeof(result) IS DISTINCT FROM 'object' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO original FROM rms_device.digital_receipt_template_submission
    WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND version_id=NEW.expected_version_id;
  IF original.operation_id IS NULL
    OR result->>'approvedByReference' IS NULL
    OR result->>'approvedByReference' NOT IN (original.authored_by_id::text,original.submitted_by_id::text) THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM rms_device.digital_receipt_template_sole_operator_approval m
    WHERE m.tenant_id=NEW.tenant_id AND m.brand_id=NEW.brand_id AND m.store_id=NEW.store_id
      AND m.template_id=NEW.template_id AND m.version_id=NEW.expected_version_id
      AND m.review_lifecycle_id=NEW.review_lifecycle_id
      AND m.actor_id::text=result->>'approvedByReference'
      AND m.approval_evidence_id::text=result->>'approvalEvidenceReference'
      AND to_char(m.approved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=result->>'approvedAt'
      AND m.operation_id=(CASE WHEN NEW.action='Approve' THEN NEW.operation_id ELSE NEW.expected_review_operation_id END)
      AND (NEW.action<>'Approve' OR (m.audit_id=NEW.audit_reference AND m.approved_at=NEW.occurred_at))
      AND bop_tenant.brand_sole_operator_was_on(m.brand_id, m.approved_at)) THEN
    RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_RESULT_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_device.check_receipt_template_lifecycle_approver() FROM PUBLIC;
