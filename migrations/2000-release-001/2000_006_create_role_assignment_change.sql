-- bop-rms-migration: 1
-- owner: @bop/permission
-- schema: bop_permission
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423: Store staff role assignment changes (Section 88 IAM-USER-DETAIL "change role / assignment
-- via approval"). Granting a role is requested by one administrator and becomes effective only after
-- an independent approver; revoking takes effect immediately. Nobody requests, approves or revokes a
-- change for themselves. Requests and decisions are append-only.
CREATE TABLE bop_permission.role_assignment_change (
  change_id platform_helpers.uuid_v7 PRIMARY KEY,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  kind text NOT NULL CHECK (kind IN ('Assign', 'Revoke')),
  role_id platform_helpers.uuid_v7 NOT NULL,
  assignment_id platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  membership_id platform_helpers.uuid_v7 NOT NULL,
  store_assignment_id platform_helpers.uuid_v7 NOT NULL,
  requested_by platform_helpers.uuid_v7 NOT NULL,
  requested_at timestamp with time zone NOT NULL CHECK (requested_at = date_trunc('milliseconds', requested_at)),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  data_classification text NOT NULL CHECK (data_classification = 'ConfigurationMetadata'),
  CONSTRAINT role_assignment_change_not_self CHECK (requested_by <> actor_id),
  CONSTRAINT role_assignment_change_role_fkey FOREIGN KEY (role_id, brand_id)
    REFERENCES bop_permission.role (role_id, brand_id)
);
-- One assignment request and at most one revocation per planned assignment.
CREATE UNIQUE INDEX role_assignment_change_assignment_kind
  ON bop_permission.role_assignment_change (brand_id, assignment_id, kind);
CREATE TABLE bop_permission.role_assignment_change_decision (
  change_id platform_helpers.uuid_v7 PRIMARY KEY REFERENCES bop_permission.role_assignment_change (change_id),
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  decision text NOT NULL CHECK (decision IN ('Approved', 'Rejected', 'Withdrawn', 'Applied')),
  decided_by platform_helpers.uuid_v7 NOT NULL,
  decided_at timestamp with time zone NOT NULL CHECK (decided_at = date_trunc('milliseconds', decided_at)),
  policy_version bigint CHECK (policy_version IS NULL OR policy_version > 0),
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  data_classification text NOT NULL CHECK (data_classification = 'ConfigurationMetadata')
);
CREATE FUNCTION bop_permission.enforce_role_assignment_change_decision()
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
  IF change.brand_id <> NEW.brand_id OR change.store_id <> NEW.store_id THEN
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
REVOKE ALL ON FUNCTION bop_permission.enforce_role_assignment_change_decision() FROM PUBLIC;
CREATE TRIGGER role_assignment_change_decision_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bop_permission.role_assignment_change_decision
  FOR EACH ROW EXECUTE FUNCTION bop_permission.enforce_role_assignment_change_decision();
CREATE FUNCTION bop_permission.reject_role_assignment_change_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Role assignment change history is append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_permission.reject_role_assignment_change_update() FROM PUBLIC;
CREATE TRIGGER role_assignment_change_append_only
  BEFORE UPDATE OR DELETE ON bop_permission.role_assignment_change
  FOR EACH ROW EXECUTE FUNCTION bop_permission.reject_role_assignment_change_update();
ALTER TABLE bop_permission.role_assignment_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.role_assignment_change FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.role_assignment_change_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_permission.role_assignment_change_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY role_assignment_change_scope ON bop_permission.role_assignment_change
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY role_assignment_change_decision_scope ON bop_permission.role_assignment_change_decision
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE bop_permission.role_assignment_change, bop_permission.role_assignment_change_decision FROM PUBLIC;
