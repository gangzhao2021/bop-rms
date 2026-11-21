-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_store.store_service_exception_content (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  exception_id platform_helpers.uuid_v7 NOT NULL,
  interval_count smallint NOT NULL CHECK (interval_count BETWEEN 0 AND 16),
  data_classification text NOT NULL CHECK (data_classification = 'ConfigurationMetadata'),
  CONSTRAINT store_exception_content_pkey PRIMARY KEY (brand_id,store_id,exception_id),
  CONSTRAINT store_exception_content_parent_fkey FOREIGN KEY (brand_id,store_id,exception_id)
    REFERENCES rms_store.store_service_exception (brand_id,store_id,exception_id)
);
CREATE TABLE rms_store.store_service_exception_interval (
  interval_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  exception_id platform_helpers.uuid_v7 NOT NULL,
  sequence_number smallint NOT NULL CHECK (sequence_number BETWEEN 1 AND 16),
  start_local_time time without time zone NOT NULL,
  end_local_time time without time zone NOT NULL,
  ends_next_day boolean NOT NULL,
  service_modes text[] NOT NULL CHECK (cardinality(service_modes) BETWEEN 1 AND 3 AND service_modes <@ ARRAY['DineIn','Pickup','Delivery']::text[]),
  order_cutoff_seconds integer NOT NULL CHECK (order_cutoff_seconds BETWEEN 0 AND 86400),
  lead_time_seconds integer NOT NULL CHECK (lead_time_seconds BETWEEN 0 AND 86400),
  data_classification text NOT NULL CHECK (data_classification = 'ConfigurationMetadata'),
  CONSTRAINT store_exception_interval_pkey PRIMARY KEY (brand_id,store_id,interval_id),
  CONSTRAINT store_exception_interval_content_fkey FOREIGN KEY (brand_id,store_id,exception_id)
    REFERENCES rms_store.store_service_exception_content (brand_id,store_id,exception_id),
  CONSTRAINT store_exception_interval_sequence_unique UNIQUE (brand_id,store_id,exception_id,sequence_number)
);

CREATE TRIGGER store_service_exception_content_no_update BEFORE UPDATE ON rms_store.store_service_exception_content
  FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_configuration_history_update();
CREATE RULE store_service_exception_content_no_delete AS ON DELETE TO rms_store.store_service_exception_content DO INSTEAD NOTHING;
ALTER TABLE rms_store.store_service_exception_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_service_exception_content FORCE ROW LEVEL SECURITY;
CREATE POLICY store_service_exception_content_scope ON rms_store.store_service_exception_content
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_store.store_service_exception_content FROM PUBLIC;

CREATE TRIGGER store_service_exception_interval_no_update BEFORE UPDATE ON rms_store.store_service_exception_interval
  FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_configuration_history_update();
CREATE RULE store_service_exception_interval_no_delete AS ON DELETE TO rms_store.store_service_exception_interval DO INSTEAD NOTHING;
ALTER TABLE rms_store.store_service_exception_interval ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_service_exception_interval FORCE ROW LEVEL SECURITY;
CREATE POLICY store_service_exception_interval_scope ON rms_store.store_service_exception_interval
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_store.store_service_exception_interval FROM PUBLIC;
