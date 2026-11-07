-- bop-rms-migration: 1
-- owner: @bop/permission
-- schema: bop_permission
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 M07 DEC-SOLE-OPERATOR-APPROVAL (staff roles; coordinator under Q19, the Owner may
-- overrule it; Owner standing approval 2026-10-14): a store run by one owner could never give a
-- new cashier a role, because a role assignment needed a second approver who did not exist. While
-- the Brand Owner runs the Brand alone (sole operator in effect: the setting is On and the
-- requester is the only person who holds staff role approval at that scope) the requester may
-- approve their own request, never for themselves. The decision is the existing append-only
-- decision row; this append-only companion record marks it (approval_mode SoleOperator) with the
-- approver's second-factor time, at most 15 minutes before. Every other assignment still needs
-- someone other than its requester and subject. Rows already recorded are unchanged.
CREATE FUNCTION bop_permission.reject_role_assignment_sole_operator_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'append-only role assignment sole operator approval' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_permission.reject_role_assignment_sole_operator_mutation() FROM PUBLIC;

CREATE TABLE bop_permission.role_assignment_sole_operator_approval (
  change_id platform_helpers.uuid_v7 PRIMARY KEY
    REFERENCES bop_permission.role_assignment_change (change_id),
  brand_id platform_helpers.uuid_v7 NOT NULL,
  -- Null for a Brand role.
  store_id platform_helpers.uuid_v7,
  approval_mode text NOT NULL CHECK (approval_mode = 'SoleOperator'),
  actor_id platform_helpers.uuid_v7 NOT NULL,
  actor_mfa_at timestamp with time zone NOT NULL CHECK (isfinite(actor_mfa_at)),
  approved_at timestamp with time zone NOT NULL
    CHECK (isfinite(approved_at) AND approved_at = date_trunc('milliseconds', approved_at)),
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  data_classification text NOT NULL CHECK (data_classification = 'ConfigurationMetadata'),
  CONSTRAINT role_assignment_sole_operator_approval_recent_mfa CHECK (
    actor_mfa_at BETWEEN approved_at - interval '15 minutes' AND approved_at
  )
);

-- The checks read the exact rows they name as the migration owner (SECURITY DEFINER,
-- row_security off), so a hidden row is never mistaken for an absent one and callers need no
-- further grants. A mark names an open Assign request of the same Brand and scope that its actor
-- asked for, for someone else, while sole operator is On (held until the approval commits, so
-- turning it off waits for the approval or the approval sees it off).
CREATE FUNCTION bop_permission.check_role_assignment_sole_operator_approval() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM bop_permission.role_assignment_change c
    WHERE c.change_id = NEW.change_id AND c.brand_id = NEW.brand_id
      AND c.store_id IS NOT DISTINCT FROM NEW.store_id AND c.kind = 'Assign'
      AND c.requested_by = NEW.actor_id AND c.actor_id <> NEW.actor_id
  ) THEN
    RAISE EXCEPTION 'role assignment sole operator approval must mark its requester''s own request' USING ERRCODE = '23514';
  END IF;
  IF bop_tenant.hold_brand_sole_operator_on(NEW.brand_id, NEW.approved_at) IS NOT TRUE THEN
    RAISE EXCEPTION 'role assignment sole operator approval needs sole operator on' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_permission.check_role_assignment_sole_operator_approval() FROM PUBLIC;
CREATE TRIGGER role_assignment_sole_operator_approval_request
  BEFORE INSERT ON bop_permission.role_assignment_sole_operator_approval
  FOR EACH ROW EXECUTE FUNCTION bop_permission.check_role_assignment_sole_operator_approval();

-- At commit a mark stands only with its decision: Approved by the same person at the same instant
-- with the same audit. A mark with no such decision rolls the whole transaction back.
CREATE FUNCTION bop_permission.check_role_assignment_sole_operator_decided() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM bop_permission.role_assignment_change_decision d
    WHERE d.change_id = NEW.change_id AND d.decision = 'Approved'
      AND d.decided_by = NEW.actor_id AND d.decided_at = NEW.approved_at
      AND d.audit_id = NEW.audit_id
  ) THEN
    RAISE EXCEPTION 'role assignment sole operator approval needs its approval' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION bop_permission.check_role_assignment_sole_operator_decided() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER role_assignment_sole_operator_approval_decided
  AFTER INSERT ON bop_permission.role_assignment_sole_operator_approval
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bop_permission.check_role_assignment_sole_operator_decided();

CREATE TRIGGER role_assignment_sole_operator_approval_no_mutation
  BEFORE UPDATE OR DELETE ON bop_permission.role_assignment_sole_operator_approval
  FOR EACH ROW EXECUTE FUNCTION bop_permission.reject_role_assignment_sole_operator_mutation();
CREATE TRIGGER role_assignment_sole_operator_approval_no_truncate
  BEFORE TRUNCATE ON bop_permission.role_assignment_sole_operator_approval
  FOR EACH STATEMENT EXECUTE FUNCTION bop_permission.reject_role_assignment_sole_operator_mutation();
ALTER TABLE bop_permission.role_assignment_sole_operator_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.role_assignment_sole_operator_approval FORCE ROW LEVEL SECURITY;
CREATE POLICY role_assignment_sole_operator_approval_scope ON bop_permission.role_assignment_sole_operator_approval
  USING (brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id()))
  WITH CHECK (brand_id = platform_helpers.current_brand_id()
    AND (store_id IS NULL OR store_id = platform_helpers.current_store_id()));
REVOKE ALL ON TABLE bop_permission.role_assignment_sole_operator_approval FROM PUBLIC;

-- The decision guard (last defined by 2000_010) now reads the mark as the migration owner. The
-- scope check and every other rule are unchanged; an Approved decision by the requester stands
-- only with its mark (same person, instant and audit) while sole operator was On at that instant.
-- Nobody ever decides a request for themselves.
CREATE OR REPLACE FUNCTION bop_permission.enforce_role_assignment_change_decision()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
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
  IF change.kind = 'Assign' AND (NEW.decision = 'Applied'
      OR (NEW.decision IN ('Approved', 'Rejected') AND NEW.decided_by = change.actor_id)
      OR (NEW.decision = 'Rejected' AND NEW.decided_by = change.requested_by)
      OR (NEW.decision = 'Approved' AND NEW.decided_by = change.requested_by AND NOT (
        EXISTS (
          SELECT 1 FROM bop_permission.role_assignment_sole_operator_approval m
          WHERE m.change_id = NEW.change_id AND m.actor_id = NEW.decided_by
            AND m.approved_at = NEW.decided_at AND m.audit_id = NEW.audit_id
        )
        AND bop_tenant.brand_sole_operator_was_on(NEW.brand_id, NEW.decided_at)))
      OR (NEW.decision = 'Withdrawn' AND NEW.decided_by <> change.requested_by)) THEN
    RAISE EXCEPTION 'Role assignment needs an independent decision' USING ERRCODE = '23514';
  END IF;
  IF change.kind = 'Revoke' AND (NEW.decision <> 'Applied' OR NEW.decided_by <> change.requested_by) THEN
    RAISE EXCEPTION 'Role assignment revocation is applied by its requester' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_permission.enforce_role_assignment_change_decision() FROM PUBLIC;
