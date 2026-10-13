-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- WP-2423 Q19 (DEC-SOLE-OPERATOR-APPROVAL, supplementary decision 2): the allergen roster gets a
-- two-person rule. One person records the roster (an append-only proposal binding its exact
-- content digest); another person holding roster permission approves it, which creates the
-- registry version. The person who recorded it may approve it only alone as sole operator (in
-- effect at that moment), marked approval_mode SoleOperator with their second-factor time at most
-- 15 minutes before. Earlier registry versions have no recorder and keep their meaning.
CREATE FUNCTION rms_catalog.reject_allergen_registry_proposal_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'append-only allergen registry proposal' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.reject_allergen_registry_proposal_mutation() FROM PUBLIC;

CREATE TABLE rms_catalog.allergen_registry_proposal (
 proposal_id platform_helpers.uuid_v7 PRIMARY KEY,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 registry_version_id platform_helpers.uuid_v7 NOT NULL,
 jurisdiction_code text NOT NULL CHECK (jurisdiction_code ~ '^[A-Z][A-Z0-9_-]{1,31}$'),
 policy_document_digest text NOT NULL CHECK (policy_document_digest ~ '^sha256:[0-9a-f]{64}$'),
 recorder_actor_id platform_helpers.uuid_v7 NOT NULL,
 recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at)),
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 CONSTRAINT allergen_registry_proposal_version_unique UNIQUE (brand_id,registry_version_id),
 CONSTRAINT allergen_registry_proposal_identity_unique UNIQUE (proposal_id,brand_id)
);
CREATE TRIGGER allergen_registry_proposal_no_mutation BEFORE UPDATE OR DELETE ON rms_catalog.allergen_registry_proposal
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.reject_allergen_registry_proposal_mutation();
CREATE TRIGGER allergen_registry_proposal_no_truncate BEFORE TRUNCATE ON rms_catalog.allergen_registry_proposal
 FOR EACH STATEMENT EXECUTE FUNCTION rms_catalog.reject_allergen_registry_proposal_mutation();
ALTER TABLE rms_catalog.allergen_registry_proposal ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.allergen_registry_proposal FORCE ROW LEVEL SECURITY;
CREATE POLICY allergen_registry_proposal_brand_policy ON rms_catalog.allergen_registry_proposal
 USING (brand_id=platform_helpers.current_brand_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id());
REVOKE ALL ON TABLE rms_catalog.allergen_registry_proposal FROM PUBLIC;

ALTER TABLE rms_catalog.allergen_registry_version
 ADD COLUMN proposal_id platform_helpers.uuid_v7,
 ADD COLUMN recorder_actor_id platform_helpers.uuid_v7,
 ADD COLUMN approval_mode text NOT NULL DEFAULT 'Independent'
  CONSTRAINT allergen_registry_version_mode_check CHECK (approval_mode IN ('Independent','SoleOperator')),
 ADD COLUMN approver_mfa_at timestamptz;
ALTER TABLE rms_catalog.allergen_registry_version
 ADD CONSTRAINT allergen_registry_version_proposal_fk FOREIGN KEY (proposal_id,brand_id)
  REFERENCES rms_catalog.allergen_registry_proposal (proposal_id,brand_id),
 ADD CONSTRAINT allergen_registry_version_proposal_once UNIQUE (proposal_id),
 ADD CONSTRAINT allergen_registry_version_recorder CHECK ((proposal_id IS NULL) = (recorder_actor_id IS NULL)),
 ADD CONSTRAINT allergen_registry_version_independent CHECK (
  recorder_actor_id IS NULL OR reviewer_actor_id <> recorder_actor_id OR approval_mode='SoleOperator'
 ),
 ADD CONSTRAINT allergen_registry_version_sole_operator CHECK (
  approval_mode<>'SoleOperator' OR (recorder_actor_id IS NOT NULL AND reviewer_actor_id=recorder_actor_id)
 ),
 ADD CONSTRAINT allergen_registry_version_sole_operator_mfa CHECK (
  (approval_mode='SoleOperator') = (approver_mfa_at IS NOT NULL)
  AND (approver_mfa_at IS NULL OR (
   isfinite(approver_mfa_at) AND approver_mfa_at BETWEEN reviewed_at-interval '15 minutes' AND reviewed_at
  ))
 );

-- An approval of a proposal binds exactly what was recorded and who recorded it.
CREATE FUNCTION rms_catalog.check_allergen_registry_version_proposal() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NEW.proposal_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM rms_catalog.allergen_registry_proposal p
  WHERE p.proposal_id=NEW.proposal_id AND p.brand_id=NEW.brand_id
   AND p.registry_version_id=NEW.registry_version_id AND p.recorder_actor_id=NEW.recorder_actor_id
   AND p.jurisdiction_code=NEW.jurisdiction_code AND p.policy_document_digest=NEW.policy_document_digest
   AND p.recorded_at<=NEW.reviewed_at
 ) THEN
  RAISE EXCEPTION 'allergen registry approval must match its recorded proposal' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_catalog.check_allergen_registry_version_proposal() FROM PUBLIC;
CREATE TRIGGER allergen_registry_version_proposal BEFORE INSERT ON rms_catalog.allergen_registry_version
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.check_allergen_registry_version_proposal();
