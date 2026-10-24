-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 (v15 live check of 0833a52c):
-- 1. Only the person who made a Store configuration change checks it (Validate) and sends it for
--    approval (Submit). Someone else approves it, declines it or asks its author; they never take
--    a step on it in the author's name. Rows already recorded are kept as they are.
-- 2. DEC-SOLE-OPERATOR-APPROVAL (Owner decision 2026-10-16) also covers an Owner's own opening
--    hours change on a Store whose configuration was installed (not from Store setup): the
--    sole-operator mark (2000_060) may now mark that self-approval too. Every other condition of
--    the mark is unchanged (exactly that Approve operation, by the marked person, who created or
--    sent the change; at most 15 minutes after their second factor).
CREATE FUNCTION rms_store.check_store_configuration_author_step() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.command_type IN ('Validate','Submit')
    AND NEW.actor_reference::text IS DISTINCT FROM NEW.configuration_json->>'authoredByReference' THEN
    RAISE EXCEPTION 'only the person who made a store configuration change checks or sends it' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_store.check_store_configuration_author_step() FROM PUBLIC;
CREATE TRIGGER store_authoring_author_step BEFORE INSERT ON rms_store.store_configuration_authoring_operation
  FOR EACH ROW EXECUTE FUNCTION rms_store.check_store_configuration_author_step();

CREATE OR REPLACE FUNCTION rms_store.check_store_configuration_sole_operator_approval() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE
  matched boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM rms_store.store_configuration_authoring_operation a
    WHERE a.brand_id=NEW.brand_id AND a.store_id=NEW.store_id AND a.operation_id=NEW.operation_id
      AND a.configuration_id=NEW.configuration_id AND a.command_type='Approve' AND a.lifecycle='Approved'
      AND a.actor_reference=NEW.actor_id AND a.audit_reference=NEW.audit_id AND a.occurred_at=NEW.approved_at
      AND a.configuration_json->>'approvedByReference'=NEW.actor_id::text
      AND a.configuration_json->>'approvalEvidenceReference'=NEW.approval_evidence_id::text
      AND (a.configuration_json->>'authoredByReference'=NEW.actor_id::text OR EXISTS (
        SELECT 1 FROM rms_store.store_configuration_authoring_operation s
        WHERE s.brand_id=NEW.brand_id AND s.store_id=NEW.store_id AND s.configuration_id=NEW.configuration_id
          AND s.command_type='Submit' AND s.actor_reference=NEW.actor_id))
  ) INTO matched;
  IF NOT matched THEN
    RAISE EXCEPTION 'store configuration sole operator approval must mark a self-approval' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION rms_store.check_store_configuration_sole_operator_approval() FROM PUBLIC;
