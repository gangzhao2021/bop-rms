-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 DEC-SOLE-OPERATOR-APPROVAL (Owner decision 2026-10-16): while the Brand Owner runs the
-- Store alone (sole operator in effect at that moment), the Owner may approve a Store configuration
-- created from Store setup that they created or sent for approval themselves. The approval itself
-- is the existing authoring operation (and its Publishing review record); this append-only
-- companion record marks it (approval_mode SoleOperator) with the approver's second-factor time,
-- at most 15 minutes before. Every other Store configuration approval still needs another person:
-- the approver may equal the author only where this mark exists, which the database now checks
-- on the authoring history and on the published configuration (formerly a plain inequality).
CREATE FUNCTION rms_store.reject_store_configuration_sole_operator_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'append-only store configuration sole operator approval' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_store.reject_store_configuration_sole_operator_mutation() FROM PUBLIC;

-- The checks below read the exact rows they name (brand, Store, configuration) as the migration
-- owner (SECURITY DEFINER, row_security off: fails closed if the owner cannot bypass forced RLS),
-- so a hidden row is never mistaken for an absent one and callers need no extra grants.
CREATE TABLE rms_store.store_configuration_sole_operator_approval (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  configuration_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  approval_evidence_id platform_helpers.uuid_v7 NOT NULL,
  approval_mode text NOT NULL CHECK (approval_mode='SoleOperator'),
  actor_id platform_helpers.uuid_v7 NOT NULL,
  actor_mfa_at timestamptz NOT NULL CHECK (isfinite(actor_mfa_at)),
  approved_at timestamptz NOT NULL CHECK (isfinite(approved_at) AND approved_at=date_trunc('milliseconds',approved_at)),
  audit_id platform_helpers.uuid_v7 NOT NULL,
  data_classification text NOT NULL CHECK (data_classification='ConfigurationMetadata'),
  CONSTRAINT store_configuration_sole_operator_approval_pkey PRIMARY KEY (brand_id,store_id,configuration_id),
  CONSTRAINT store_configuration_sole_operator_approval_operation_unique UNIQUE (brand_id,store_id,operation_id),
  CONSTRAINT store_configuration_sole_operator_approval_audit_unique UNIQUE (brand_id,store_id,audit_id),
  CONSTRAINT store_configuration_sole_operator_approval_recent_mfa CHECK (
    actor_mfa_at BETWEEN approved_at-interval '15 minutes' AND approved_at
  )
);
CREATE TRIGGER store_configuration_sole_operator_no_mutation BEFORE UPDATE OR DELETE ON rms_store.store_configuration_sole_operator_approval
  FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_configuration_sole_operator_mutation();
CREATE TRIGGER store_configuration_sole_operator_no_truncate BEFORE TRUNCATE ON rms_store.store_configuration_sole_operator_approval
  FOR EACH STATEMENT EXECUTE FUNCTION rms_store.reject_store_configuration_sole_operator_mutation();
ALTER TABLE rms_store.store_configuration_sole_operator_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_configuration_sole_operator_approval FORCE ROW LEVEL SECURITY;
CREATE POLICY store_configuration_sole_operator_scope ON rms_store.store_configuration_sole_operator_approval
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_store.store_configuration_sole_operator_approval FROM PUBLIC;

-- The mark is written while the approval is prepared, before its authoring operation. At COMMIT it
-- must mark exactly that Approve operation of a configuration from Store setup, made by the marked
-- person, who created the configuration or sent it for approval (a self-approval). A mark that no
-- such approval committed with rolls the transaction back.
CREATE FUNCTION rms_store.check_store_configuration_sole_operator_approval() RETURNS trigger
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
      AND a.configuration_json ? 'setupBasis'
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
CREATE CONSTRAINT TRIGGER store_configuration_sole_operator_approval_marks_approval
  AFTER INSERT ON rms_store.store_configuration_sole_operator_approval
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION rms_store.check_store_configuration_sole_operator_approval();

-- An approval recorded in the authoring history whose approver created the configuration, or sent
-- it for approval, needs the matching sole-operator mark (written earlier in the same approval).
CREATE FUNCTION rms_store.check_store_configuration_authoring_approver() RETURNS trigger
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
  ) THEN
    RAISE EXCEPTION 'store configuration approval needs another person' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_store.check_store_configuration_authoring_approver() FROM PUBLIC;
CREATE TRIGGER store_authoring_independent_approver BEFORE INSERT ON rms_store.store_configuration_authoring_operation
  FOR EACH ROW EXECUTE FUNCTION rms_store.check_store_configuration_authoring_approver();

-- The published configuration: approver and author may be the same person only with the mark.
ALTER TABLE rms_store.store_configuration_version
  DROP CONSTRAINT store_configuration_approval;
ALTER TABLE rms_store.store_configuration_version
  ADD CONSTRAINT store_configuration_approval CHECK (
    (approved_by_reference IS NULL) = (approval_evidence_reference IS NULL)
    AND ((lifecycle IN ('Draft','PendingApproval')) = (approved_by_reference IS NULL))
    AND ((lifecycle IN ('Published','Superseded','Archived')) = (publication_reference IS NOT NULL))
    AND ((lifecycle IN ('Published','Superseded','Archived')) = (live_gate_evidence_reference IS NOT NULL))
  );
CREATE FUNCTION rms_store.check_store_configuration_version_approver() RETURNS trigger
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
    ) THEN
    RAISE EXCEPTION 'store configuration approval needs another person' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_store.check_store_configuration_version_approver() FROM PUBLIC;
CREATE TRIGGER store_configuration_independent_approver BEFORE INSERT ON rms_store.store_configuration_version
  FOR EACH ROW EXECUTE FUNCTION rms_store.check_store_configuration_version_approver();
