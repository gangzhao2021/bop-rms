-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Stored publication/media/effective evidence is historical, never current authority.
CREATE TABLE rms_store.public_store_profile_version (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  profile_id platform_helpers.uuid_v7 NOT NULL,
  profile_version integer NOT NULL CHECK (profile_version > 0),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  profile_json jsonb NOT NULL CHECK (jsonb_typeof(profile_json)='object' AND octet_length(profile_json::text)<=262144),
  actor_reference platform_helpers.uuid_v7 NOT NULL,
  audit_reference platform_helpers.uuid_v7 NOT NULL,
  recorded_at timestamp with time zone NOT NULL,
  PRIMARY KEY (brand_id,store_id,profile_id,profile_version),
  UNIQUE (brand_id,store_id,audit_reference),
  CHECK (profile_json @> jsonb_build_object('brandReference',brand_id::text,
    'storeReference',store_id::text,'profileReference',profile_id::text,
    'profileVersion',profile_version,'classification','Public'))
);
CREATE TRIGGER public_store_profile_no_update BEFORE UPDATE ON rms_store.public_store_profile_version
  FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_configuration_history_update();
CREATE RULE public_store_profile_no_delete AS ON DELETE TO rms_store.public_store_profile_version DO INSTEAD NOTHING;
ALTER TABLE rms_store.public_store_profile_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.public_store_profile_version FORCE ROW LEVEL SECURITY;
CREATE POLICY public_store_profile_scope ON rms_store.public_store_profile_version
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_store.public_store_profile_version FROM PUBLIC;
