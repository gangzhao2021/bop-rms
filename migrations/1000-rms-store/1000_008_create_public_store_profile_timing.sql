-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Store owns approved profile scheduling; generic EffectivePeriod owns its rules.
CREATE TABLE rms_store.public_store_profile_timing (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  family_id platform_helpers.uuid_v7 NOT NULL,
  timing_id platform_helpers.uuid_v7 NOT NULL,
  timing_version integer NOT NULL CHECK (timing_version > 0),
  timing_json jsonb NOT NULL CHECK (jsonb_typeof(timing_json)='object' AND octet_length(timing_json::text)<=32768),
  approval_json jsonb NOT NULL CHECK (jsonb_typeof(approval_json)='object' AND octet_length(approval_json::text)<=16384),
  audit_reference platform_helpers.uuid_v7 NOT NULL,
  recorded_at timestamp with time zone NOT NULL,
  PRIMARY KEY (brand_id,store_id,family_id,timing_version),
  UNIQUE (brand_id,store_id,timing_id),
  UNIQUE (brand_id,store_id,audit_reference),
  CHECK (timing_json @> jsonb_build_object('familyReference',family_id::text,
    'timingVersionReference',timing_id::text,'version',timing_version,
    'configurationType','STORE_PROFILE','purposeCode','CUSTOMER_ENTRY',
    'scope',jsonb_build_object('kind','Store','brandReference',brand_id::text,'storeReference',store_id::text)))
);
CREATE TRIGGER public_store_profile_timing_no_update BEFORE UPDATE ON rms_store.public_store_profile_timing
  FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_configuration_history_update();
CREATE RULE public_store_profile_timing_no_delete AS ON DELETE TO rms_store.public_store_profile_timing DO INSTEAD NOTHING;
ALTER TABLE rms_store.public_store_profile_timing ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.public_store_profile_timing FORCE ROW LEVEL SECURITY;
CREATE POLICY public_store_profile_timing_scope ON rms_store.public_store_profile_timing
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_store.public_store_profile_timing FROM PUBLIC;
