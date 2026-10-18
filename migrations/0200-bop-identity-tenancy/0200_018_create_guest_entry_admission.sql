-- bop-rms-migration: 1
-- owner: @bop/identity
-- schema: bop_identity
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Single-use evidence consumed atomically with GuestSession creation.
CREATE TABLE bop_identity.guest_entry_admission (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  entry_request_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  evidence_id platform_helpers.uuid_v7 NOT NULL,
  audit_reference platform_helpers.uuid_v7 NOT NULL,
  evidence_json jsonb NOT NULL CHECK (jsonb_typeof(evidence_json)='object' AND octet_length(evidence_json::text)<=16384),
  consumed_at timestamp with time zone NOT NULL,
  PRIMARY KEY (brand_id,store_id,entry_request_id),
  UNIQUE (brand_id,store_id,operation_id),
  UNIQUE (brand_id,store_id,evidence_id),
  UNIQUE (brand_id,store_id,audit_reference),
  CHECK (entry_request_id<>operation_id),
  CHECK (evidence_json @> jsonb_build_object('decision','Allowed',
    'brandReference',brand_id::text,'storeReference',store_id::text,
    'entryRequestReference',entry_request_id::text,'evidenceReference',evidence_id::text))
);
CREATE TRIGGER guest_entry_admission_no_mutation BEFORE UPDATE OR DELETE ON bop_identity.guest_entry_admission
  FOR EACH ROW EXECUTE FUNCTION bop_identity.reject_guest_session_operation_mutation();
CREATE TRIGGER guest_entry_admission_no_truncate BEFORE TRUNCATE ON bop_identity.guest_entry_admission
  FOR EACH STATEMENT EXECUTE FUNCTION bop_identity.reject_guest_session_operation_mutation();
ALTER TABLE bop_identity.guest_entry_admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.guest_entry_admission FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_entry_admission_scope ON bop_identity.guest_entry_admission
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE bop_identity.guest_entry_admission FROM PUBLIC;
