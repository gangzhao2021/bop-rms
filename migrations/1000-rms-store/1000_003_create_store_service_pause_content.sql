-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
ALTER TABLE rms_store.store_configuration_operation
  ADD CONSTRAINT store_operation_command_unique UNIQUE (brand_id,store_id,operation_id,command_type);

CREATE TABLE rms_store.store_service_pause_content (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  command_type text NOT NULL CHECK (command_type = 'PauseService'),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone NOT NULL,
  service_modes text[] CHECK (service_modes IS NULL OR (cardinality(service_modes) BETWEEN 1 AND 3 AND service_modes <@ ARRAY['DineIn','Pickup','Delivery']::text[])),
  data_classification text NOT NULL CHECK (data_classification = 'ConfigurationMetadata'),
  CONSTRAINT store_service_pause_content_pkey PRIMARY KEY (brand_id,store_id,operation_id),
  CONSTRAINT store_service_pause_operation_fkey FOREIGN KEY (brand_id,store_id,operation_id,command_type)
    REFERENCES rms_store.store_configuration_operation (brand_id,store_id,operation_id,command_type),
  CONSTRAINT store_service_pause_period CHECK (effective_from < effective_until)
);

CREATE TABLE rms_store.store_service_resume_content (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL,
  command_type text NOT NULL CHECK (command_type = 'ResumeService'),
  pause_operation_id platform_helpers.uuid_v7 NOT NULL,
  effective_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'ConfigurationMetadata'),
  CONSTRAINT store_service_resume_content_pkey PRIMARY KEY (brand_id,store_id,operation_id),
  CONSTRAINT store_service_resume_operation_fkey FOREIGN KEY (brand_id,store_id,operation_id,command_type)
    REFERENCES rms_store.store_configuration_operation (brand_id,store_id,operation_id,command_type),
  CONSTRAINT store_service_resume_pause_fkey FOREIGN KEY (brand_id,store_id,pause_operation_id)
    REFERENCES rms_store.store_service_pause_content (brand_id,store_id,operation_id)
);

CREATE TRIGGER store_service_pause_content_no_update BEFORE UPDATE ON rms_store.store_service_pause_content
  FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_configuration_history_update();
CREATE RULE store_service_pause_content_no_delete AS ON DELETE TO rms_store.store_service_pause_content DO INSTEAD NOTHING;
ALTER TABLE rms_store.store_service_pause_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_service_pause_content FORCE ROW LEVEL SECURITY;
CREATE POLICY store_service_pause_content_scope ON rms_store.store_service_pause_content
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_store.store_service_pause_content FROM PUBLIC;

CREATE TRIGGER store_service_resume_content_no_update BEFORE UPDATE ON rms_store.store_service_resume_content
  FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_configuration_history_update();
CREATE RULE store_service_resume_content_no_delete AS ON DELETE TO rms_store.store_service_resume_content DO INSTEAD NOTHING;
ALTER TABLE rms_store.store_service_resume_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_service_resume_content FORCE ROW LEVEL SECURITY;
CREATE POLICY store_service_resume_content_scope ON rms_store.store_service_resume_content
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_store.store_service_resume_content FROM PUBLIC;
