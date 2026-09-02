-- bop-rms-migration: 1
-- owner: @bop/publishing
-- schema: bop_publishing
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA bop_publishing;
REVOKE ALL ON SCHEMA bop_publishing FROM PUBLIC;
CREATE FUNCTION bop_publishing.reject_live_gate_history_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Live Gate history is append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_publishing.reject_live_gate_history_update() FROM PUBLIC;
CREATE TABLE bop_publishing.live_gate_version (
  gate_reference platform_helpers.uuid_v7 NOT NULL, gate_id text NOT NULL CHECK (gate_id ~ '^[A-Z][A-Z0-9-]{7,95}$'),
  tenant_id platform_helpers.uuid_v7 NOT NULL, brand_id platform_helpers.uuid_v7 NOT NULL, store_id platform_helpers.uuid_v7 NOT NULL,
  gate_version bigint NOT NULL CHECK (gate_version > 0), environment text NOT NULL CHECK (environment='Production'),
  state text NOT NULL CHECK (state IN ('Draft','Blocked','InReview','Approved','Rejected','Reopened')),
  owner_reference platform_helpers.uuid_v7 NOT NULL, submitted_by_reference platform_helpers.uuid_v7,
  approved_by_reference platform_helpers.uuid_v7, decision_evidence_reference platform_helpers.uuid_v7,
  last_reviewed_at timestamp with time zone, changed_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification='ConfigurationMetadata'),
  CONSTRAINT live_gate_version_pkey PRIMARY KEY (brand_id,store_id,gate_reference,gate_version),
  CONSTRAINT live_gate_id_version_unique UNIQUE (brand_id,store_id,gate_id,gate_version),
  CONSTRAINT live_gate_segregation CHECK (approved_by_reference IS NULL OR approved_by_reference<>submitted_by_reference),
  CONSTRAINT live_gate_decision CHECK ((state='Approved')=(approved_by_reference IS NOT NULL) AND ((state IN ('Approved','Rejected'))=(decision_evidence_reference IS NOT NULL)) AND ((state IN ('Approved','Rejected'))=(last_reviewed_at IS NOT NULL)) AND (last_reviewed_at IS NULL OR last_reviewed_at<=changed_at))
);
CREATE TABLE bop_publishing.live_gate_requirement (
  requirement_id platform_helpers.uuid_v7 NOT NULL, brand_id platform_helpers.uuid_v7 NOT NULL, store_id platform_helpers.uuid_v7 NOT NULL,
  gate_reference platform_helpers.uuid_v7 NOT NULL, gate_version bigint NOT NULL, category_code text NOT NULL CHECK (category_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  requirement_code text NOT NULL CHECK (requirement_code ~ '^[A-Z][A-Z0-9_]{2,63}$'), owner_reference platform_helpers.uuid_v7 NOT NULL,
  applicable boolean NOT NULL, status text NOT NULL CHECK (status IN ('Missing','Submitted','Accepted','Rejected','Expired','Revoked','NotApplicable')),
  evidence_reference platform_helpers.uuid_v7, evidence_version bigint CHECK (evidence_version>0), valid_until timestamp with time zone, blocking_reason_code text,
  data_classification text NOT NULL CHECK (data_classification='ConfigurationMetadata'),
  CONSTRAINT live_gate_requirement_pkey PRIMARY KEY (brand_id,store_id,requirement_id),
  CONSTRAINT live_gate_requirement_gate_fkey FOREIGN KEY (brand_id,store_id,gate_reference,gate_version) REFERENCES bop_publishing.live_gate_version (brand_id,store_id,gate_reference,gate_version),
  CONSTRAINT live_gate_requirement_unique UNIQUE (brand_id,store_id,gate_reference,gate_version,requirement_code),
  CONSTRAINT live_gate_requirement_applicability CHECK ((NOT applicable AND status='NotApplicable') OR (applicable AND status<>'NotApplicable')),
  CONSTRAINT live_gate_requirement_evidence CHECK ((evidence_reference IS NULL)=(evidence_version IS NULL) AND ((status IN ('Submitted','Accepted','Rejected','Expired','Revoked'))=(evidence_reference IS NOT NULL))),
  CONSTRAINT live_gate_requirement_block CHECK ((status IN ('Missing','Rejected','Expired','Revoked'))=(blocking_reason_code IS NOT NULL) AND (status<>'Accepted' OR valid_until IS NOT NULL))
);
CREATE TABLE bop_publishing.live_gate_operation (
  operation_id platform_helpers.uuid_v7 NOT NULL, brand_id platform_helpers.uuid_v7 NOT NULL, store_id platform_helpers.uuid_v7 NOT NULL,
  gate_reference platform_helpers.uuid_v7 NOT NULL, command_type text NOT NULL CHECK (command_type IN ('AttachEvidence','RequestReview','Approve','Reject','Reopen')),
  expected_version bigint NOT NULL CHECK (expected_version>0), resulting_version bigint NOT NULL CHECK (resulting_version=expected_version+1),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'), actor_reference platform_helpers.uuid_v7 NOT NULL,
  purpose_code text NOT NULL CHECK (purpose_code ~ '^[A-Z][A-Z0-9_]{2,63}$'), audit_reference platform_helpers.uuid_v7 NOT NULL,
  occurred_at timestamp with time zone NOT NULL, data_classification text NOT NULL CHECK (data_classification='ConfigurationMetadata'),
  CONSTRAINT live_gate_operation_pkey PRIMARY KEY (brand_id,store_id,operation_id)
);
CREATE TRIGGER live_gate_version_no_update BEFORE UPDATE ON bop_publishing.live_gate_version FOR EACH ROW EXECUTE FUNCTION bop_publishing.reject_live_gate_history_update();
CREATE RULE live_gate_version_no_delete AS ON DELETE TO bop_publishing.live_gate_version DO INSTEAD NOTHING;
CREATE TRIGGER live_gate_requirement_no_update BEFORE UPDATE ON bop_publishing.live_gate_requirement FOR EACH ROW EXECUTE FUNCTION bop_publishing.reject_live_gate_history_update();
CREATE RULE live_gate_requirement_no_delete AS ON DELETE TO bop_publishing.live_gate_requirement DO INSTEAD NOTHING;
CREATE TRIGGER live_gate_operation_no_update BEFORE UPDATE ON bop_publishing.live_gate_operation FOR EACH ROW EXECUTE FUNCTION bop_publishing.reject_live_gate_history_update();
CREATE RULE live_gate_operation_no_delete AS ON DELETE TO bop_publishing.live_gate_operation DO INSTEAD NOTHING;
ALTER TABLE bop_publishing.live_gate_version ENABLE ROW LEVEL SECURITY; ALTER TABLE bop_publishing.live_gate_version FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_publishing.live_gate_requirement ENABLE ROW LEVEL SECURITY; ALTER TABLE bop_publishing.live_gate_requirement FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_publishing.live_gate_operation ENABLE ROW LEVEL SECURITY; ALTER TABLE bop_publishing.live_gate_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY live_gate_version_scope ON bop_publishing.live_gate_version USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
CREATE POLICY live_gate_requirement_scope ON bop_publishing.live_gate_requirement USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
CREATE POLICY live_gate_operation_scope ON bop_publishing.live_gate_operation USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE bop_publishing.live_gate_version,bop_publishing.live_gate_requirement,bop_publishing.live_gate_operation FROM PUBLIC;
