-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_store.store_configuration_publication_content (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  configuration_id platform_helpers.uuid_v7 NOT NULL,
  publishing_family_reference platform_helpers.uuid_v7 NOT NULL,
  configuration_type text NOT NULL CHECK (configuration_type ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  purpose_code text NOT NULL CHECK (purpose_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  configuration_json jsonb NOT NULL CHECK (jsonb_typeof(configuration_json) = 'object'),
  business_day_start_source text NOT NULL CHECK (business_day_start_source IN ('PlatformDefault','StoreOverride')),
  recorded_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'ConfigurationMetadata'),
  CONSTRAINT store_publication_content_pkey PRIMARY KEY (brand_id,store_id,configuration_id),
  CONSTRAINT store_publication_content_configuration_fkey FOREIGN KEY (brand_id,store_id,configuration_id)
    REFERENCES rms_store.store_configuration_version (brand_id,store_id,configuration_id)
);
CREATE TRIGGER store_publication_content_no_update BEFORE UPDATE ON rms_store.store_configuration_publication_content
  FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_configuration_history_update();
CREATE RULE store_publication_content_no_delete AS ON DELETE TO rms_store.store_configuration_publication_content DO INSTEAD NOTHING;
ALTER TABLE rms_store.store_configuration_publication_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_configuration_publication_content FORCE ROW LEVEL SECURITY;
CREATE POLICY store_publication_content_scope ON rms_store.store_configuration_publication_content
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_store.store_configuration_publication_content FROM PUBLIC;
