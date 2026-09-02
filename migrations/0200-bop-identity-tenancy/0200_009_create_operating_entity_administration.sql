-- bop-rms-migration: 1
-- owner: @bop/operating-entity
-- schema: bop_operating_entity
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE FUNCTION bop_operating_entity.reject_administration_history_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Operating Entity administration history is append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_operating_entity.reject_administration_history_update() FROM PUBLIC;

CREATE FUNCTION bop_operating_entity.enforce_operating_entity_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.operating_entity_id <> OLD.operating_entity_id
    OR NEW.kind <> OLD.kind
    OR NEW.jurisdiction_code <> OLD.jurisdiction_code
    OR NEW.created_at <> OLD.created_at
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Operating Entity identity or revision is invalid' USING ERRCODE = '55000';
  END IF;
  IF OLD.lifecycle = 'Archived' THEN
    RAISE EXCEPTION 'archived Operating Entity is terminal' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_operating_entity.enforce_operating_entity_revision() FROM PUBLIC;

CREATE FUNCTION bop_operating_entity.enforce_assignment_revision_and_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  overlap_exists boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.assignment_id <> OLD.assignment_id
    OR NEW.brand_id <> OLD.brand_id
    OR NEW.operating_entity_id <> OLD.operating_entity_id
    OR NEW.business_function <> OLD.business_function
    OR NEW.effective_from <> OLD.effective_from
    OR NEW.version <> OLD.version + 1
  ) THEN
    RAISE EXCEPTION 'Business Function assignment identity or revision is invalid' USING ERRCODE = '55000';
  END IF;
  IF NEW.lifecycle = 'Active' THEN
    IF TG_TABLE_NAME = 'store_operating_entity_assignment' THEN
      EXECUTE
        'SELECT EXISTS (
          SELECT 1 FROM bop_operating_entity.store_operating_entity_assignment
          WHERE assignment_id <> $1 AND brand_id = $2 AND store_id = $3
            AND business_function = $4 AND lifecycle = ''Active''
            AND effective_from < COALESCE($6, ''infinity''::timestamptz)
            AND COALESCE(effective_until, ''infinity''::timestamptz) > $5
        )'
      INTO overlap_exists
      USING NEW.assignment_id, NEW.brand_id, NEW.store_id, NEW.business_function,
        NEW.effective_from, NEW.effective_until;
    ELSE
      overlap_exists := false;
    END IF;
    IF overlap_exists THEN
      RAISE EXCEPTION 'Business Function assignment overlaps an active assignment' USING ERRCODE = '23P01';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_operating_entity.enforce_assignment_revision_and_overlap() FROM PUBLIC;

CREATE TABLE bop_operating_entity.operating_entity_profile_version (
  profile_version_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  operating_entity_id platform_helpers.uuid_v7 NOT NULL,
  profile_version bigint NOT NULL CHECK (profile_version > 0),
  legal_name text NOT NULL CHECK (char_length(legal_name) BETWEEN 1 AND 200),
  trade_name text CHECK (trade_name IS NULL OR char_length(trade_name) BETWEEN 1 AND 200),
  jurisdiction_code text NOT NULL CHECK (jurisdiction_code = 'CA-ON'),
  registration_reference platform_helpers.uuid_v7,
  tax_registration_reference platform_helpers.uuid_v7,
  registered_address_reference platform_helpers.uuid_v7,
  billing_identity_reference platform_helpers.uuid_v7,
  settlement_reference platform_helpers.uuid_v7,
  evidence_references uuid[] NOT NULL DEFAULT '{}'::uuid[] CHECK (cardinality(evidence_references) <= 50),
  recorded_by_reference platform_helpers.uuid_v7 NOT NULL,
  recorded_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'RestrictedReferenceMetadata'),
  CONSTRAINT operating_entity_profile_version_pkey PRIMARY KEY (brand_id, profile_version_id),
  CONSTRAINT operating_entity_profile_version_entity_fkey FOREIGN KEY (operating_entity_id)
    REFERENCES bop_operating_entity.operating_entity (operating_entity_id),
  CONSTRAINT operating_entity_profile_version_unique
    UNIQUE (brand_id, operating_entity_id, profile_version)
);

CREATE TABLE bop_operating_entity.operating_entity_approval_decision (
  decision_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  operating_entity_id platform_helpers.uuid_v7 NOT NULL,
  entity_version bigint NOT NULL CHECK (entity_version > 0),
  decision text NOT NULL CHECK (decision IN ('Approved', 'Rejected')),
  submitted_by_reference platform_helpers.uuid_v7 NOT NULL,
  decided_by_reference platform_helpers.uuid_v7 NOT NULL,
  approval_evidence_reference platform_helpers.uuid_v7 NOT NULL,
  purpose_code text NOT NULL CHECK (purpose_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  decided_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'RestrictedReferenceMetadata'),
  CONSTRAINT operating_entity_approval_decision_pkey PRIMARY KEY (brand_id, decision_id),
  CONSTRAINT operating_entity_approval_decision_entity_fkey FOREIGN KEY (operating_entity_id)
    REFERENCES bop_operating_entity.operating_entity (operating_entity_id),
  CONSTRAINT operating_entity_approval_segregation CHECK (
    submitted_by_reference <> decided_by_reference
  ),
  CONSTRAINT operating_entity_approval_version_unique
    UNIQUE (brand_id, operating_entity_id, entity_version)
);

CREATE TABLE bop_operating_entity.operating_entity_authority_version (
  authority_version_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  operating_entity_id platform_helpers.uuid_v7 NOT NULL,
  authority_subject_reference platform_helpers.uuid_v7 NOT NULL,
  authority_role_code text NOT NULL CHECK (authority_role_code IN ('Director', 'Officer', 'SigningAuthority')),
  title_code text NOT NULL CHECK (title_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  status text NOT NULL CHECK (status IN ('Proposed', 'Active', 'Revoked', 'Expired')),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  restricted_detail_reference platform_helpers.uuid_v7 NOT NULL,
  approval_evidence_reference platform_helpers.uuid_v7 NOT NULL,
  authority_version bigint NOT NULL CHECK (authority_version > 0),
  recorded_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'RestrictedReferenceMetadata'),
  CONSTRAINT operating_entity_authority_version_pkey PRIMARY KEY (brand_id, authority_version_id),
  CONSTRAINT operating_entity_authority_version_entity_fkey FOREIGN KEY (operating_entity_id)
    REFERENCES bop_operating_entity.operating_entity (operating_entity_id),
  CONSTRAINT operating_entity_authority_period CHECK (
    effective_until IS NULL OR effective_until > effective_from
  ),
  CONSTRAINT operating_entity_authority_status CHECK (
    (status = 'Expired') = (effective_until IS NOT NULL)
  ),
  CONSTRAINT operating_entity_authority_version_unique
    UNIQUE (brand_id, operating_entity_id, authority_subject_reference, authority_role_code, authority_version)
);

CREATE TABLE bop_operating_entity.business_function_assignment_decision (
  assignment_decision_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  assignment_id platform_helpers.uuid_v7 NOT NULL,
  operating_entity_id platform_helpers.uuid_v7 NOT NULL,
  business_function text NOT NULL CHECK (business_function IN (
    'SalesReceiptIssuer', 'TaxRegistrant', 'PaymentSettlementOwner',
    'ProcurementBuyer', 'LicenseHolder', 'Employer'
  )),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  requested_by_reference platform_helpers.uuid_v7 NOT NULL,
  approved_by_reference platform_helpers.uuid_v7 NOT NULL,
  approval_evidence_reference platform_helpers.uuid_v7 NOT NULL,
  recorded_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'RestrictedReferenceMetadata'),
  CONSTRAINT business_function_assignment_decision_pkey PRIMARY KEY (brand_id, assignment_decision_id),
  CONSTRAINT business_function_assignment_decision_entity_fkey FOREIGN KEY (operating_entity_id)
    REFERENCES bop_operating_entity.operating_entity (operating_entity_id),
  CONSTRAINT business_function_assignment_decision_segregation CHECK (
    requested_by_reference <> approved_by_reference
  ),
  CONSTRAINT business_function_assignment_decision_period CHECK (
    effective_until IS NULL OR effective_until > effective_from
  ),
  CONSTRAINT business_function_assignment_decision_unique UNIQUE (brand_id, assignment_id)
);

CREATE TABLE bop_operating_entity.operating_entity_admin_operation (
  operation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  operating_entity_id platform_helpers.uuid_v7 NOT NULL,
  command_type text NOT NULL CHECK (command_type IN (
    'SaveProfile', 'SubmitForApproval', 'DecideApproval', 'ActivateEntity',
    'SuspendEntity', 'RecordAuthority', 'AssignBusinessFunction'
  )),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  entity_version bigint NOT NULL CHECK (entity_version > 0),
  actor_reference platform_helpers.uuid_v7 NOT NULL,
  purpose_code text NOT NULL CHECK (purpose_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  audit_reference platform_helpers.uuid_v7 NOT NULL,
  occurred_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'RestrictedReferenceMetadata'),
  CONSTRAINT operating_entity_admin_operation_pkey PRIMARY KEY (brand_id, operation_id),
  CONSTRAINT operating_entity_admin_operation_entity_fkey FOREIGN KEY (operating_entity_id)
    REFERENCES bop_operating_entity.operating_entity (operating_entity_id)
);

CREATE INDEX operating_entity_profile_admin_idx
  ON bop_operating_entity.operating_entity_profile_version
    (brand_id, operating_entity_id, profile_version DESC);
CREATE INDEX operating_entity_authority_admin_idx
  ON bop_operating_entity.operating_entity_authority_version
    (brand_id, operating_entity_id, status, authority_role_code);
CREATE INDEX operating_entity_operation_admin_idx
  ON bop_operating_entity.operating_entity_admin_operation
    (brand_id, operating_entity_id, occurred_at DESC);

CREATE TRIGGER operating_entity_revision_trigger
  BEFORE UPDATE ON bop_operating_entity.operating_entity
  FOR EACH ROW EXECUTE FUNCTION bop_operating_entity.enforce_operating_entity_revision();
CREATE RULE operating_entity_no_delete AS
  ON DELETE TO bop_operating_entity.operating_entity DO INSTEAD NOTHING;
CREATE TRIGGER brand_assignment_revision_overlap_trigger
  BEFORE INSERT OR UPDATE ON bop_operating_entity.brand_operating_entity_assignment
  FOR EACH ROW EXECUTE FUNCTION bop_operating_entity.enforce_assignment_revision_and_overlap();
CREATE RULE brand_assignment_no_delete AS
  ON DELETE TO bop_operating_entity.brand_operating_entity_assignment DO INSTEAD NOTHING;
CREATE TRIGGER store_assignment_revision_overlap_trigger
  BEFORE INSERT OR UPDATE ON bop_operating_entity.store_operating_entity_assignment
  FOR EACH ROW EXECUTE FUNCTION bop_operating_entity.enforce_assignment_revision_and_overlap();
CREATE RULE store_assignment_no_delete AS
  ON DELETE TO bop_operating_entity.store_operating_entity_assignment DO INSTEAD NOTHING;

CREATE TRIGGER operating_entity_profile_no_update_trigger
  BEFORE UPDATE ON bop_operating_entity.operating_entity_profile_version
  FOR EACH ROW EXECUTE FUNCTION bop_operating_entity.reject_administration_history_update();
CREATE RULE operating_entity_profile_no_delete AS
  ON DELETE TO bop_operating_entity.operating_entity_profile_version DO INSTEAD NOTHING;
CREATE TRIGGER operating_entity_approval_no_update_trigger
  BEFORE UPDATE ON bop_operating_entity.operating_entity_approval_decision
  FOR EACH ROW EXECUTE FUNCTION bop_operating_entity.reject_administration_history_update();
CREATE RULE operating_entity_approval_no_delete AS
  ON DELETE TO bop_operating_entity.operating_entity_approval_decision DO INSTEAD NOTHING;
CREATE TRIGGER operating_entity_authority_no_update_trigger
  BEFORE UPDATE ON bop_operating_entity.operating_entity_authority_version
  FOR EACH ROW EXECUTE FUNCTION bop_operating_entity.reject_administration_history_update();
CREATE RULE operating_entity_authority_no_delete AS
  ON DELETE TO bop_operating_entity.operating_entity_authority_version DO INSTEAD NOTHING;
CREATE TRIGGER business_function_decision_no_update_trigger
  BEFORE UPDATE ON bop_operating_entity.business_function_assignment_decision
  FOR EACH ROW EXECUTE FUNCTION bop_operating_entity.reject_administration_history_update();
CREATE RULE business_function_decision_no_delete AS
  ON DELETE TO bop_operating_entity.business_function_assignment_decision DO INSTEAD NOTHING;
CREATE TRIGGER operating_entity_operation_no_update_trigger
  BEFORE UPDATE ON bop_operating_entity.operating_entity_admin_operation
  FOR EACH ROW EXECUTE FUNCTION bop_operating_entity.reject_administration_history_update();
CREATE RULE operating_entity_operation_no_delete AS
  ON DELETE TO bop_operating_entity.operating_entity_admin_operation DO INSTEAD NOTHING;

ALTER TABLE bop_operating_entity.operating_entity_profile_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_operating_entity.operating_entity_profile_version FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_operating_entity.operating_entity_approval_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_operating_entity.operating_entity_approval_decision FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_operating_entity.operating_entity_authority_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_operating_entity.operating_entity_authority_version FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_operating_entity.business_function_assignment_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_operating_entity.business_function_assignment_decision FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_operating_entity.operating_entity_admin_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_operating_entity.operating_entity_admin_operation FORCE ROW LEVEL SECURITY;

CREATE POLICY operating_entity_profile_scope_policy ON bop_operating_entity.operating_entity_profile_version
  USING (brand_id = platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id = platform_helpers.current_store_id()))
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id = platform_helpers.current_store_id()));
CREATE POLICY operating_entity_approval_scope_policy ON bop_operating_entity.operating_entity_approval_decision
  USING (brand_id = platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id = platform_helpers.current_store_id()))
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id = platform_helpers.current_store_id()));
CREATE POLICY operating_entity_authority_scope_policy ON bop_operating_entity.operating_entity_authority_version
  USING (brand_id = platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id = platform_helpers.current_store_id()))
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id = platform_helpers.current_store_id()));
CREATE POLICY business_function_decision_scope_policy ON bop_operating_entity.business_function_assignment_decision
  USING (brand_id = platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id = platform_helpers.current_store_id()))
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id = platform_helpers.current_store_id()));
CREATE POLICY operating_entity_operation_scope_policy ON bop_operating_entity.operating_entity_admin_operation
  USING (brand_id = platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id = platform_helpers.current_store_id()))
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id = platform_helpers.current_store_id()));

REVOKE ALL ON TABLE bop_operating_entity.operating_entity_profile_version FROM PUBLIC;
REVOKE ALL ON TABLE bop_operating_entity.operating_entity_approval_decision FROM PUBLIC;
REVOKE ALL ON TABLE bop_operating_entity.operating_entity_authority_version FROM PUBLIC;
REVOKE ALL ON TABLE bop_operating_entity.business_function_assignment_decision FROM PUBLIC;
REVOKE ALL ON TABLE bop_operating_entity.operating_entity_admin_operation FROM PUBLIC;
