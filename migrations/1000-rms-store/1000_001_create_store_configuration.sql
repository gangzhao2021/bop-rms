-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA rms_store;
REVOKE ALL ON SCHEMA rms_store FROM PUBLIC;

CREATE FUNCTION rms_store.reject_store_configuration_history_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Store configuration history is append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_store.reject_store_configuration_history_update() FROM PUBLIC;

CREATE TABLE rms_store.store_configuration_version (
  configuration_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  configuration_version bigint NOT NULL CHECK (configuration_version > 0),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft','PendingApproval','Approved','Published','Superseded','Archived')),
  configuration_source text NOT NULL CHECK (configuration_source IN ('BrandInherited','StoreOverride')),
  brand_base_version_reference platform_helpers.uuid_v7 NOT NULL,
  default_locale text NOT NULL CHECK (char_length(default_locale) BETWEEN 2 AND 35),
  currency_code text NOT NULL CHECK (currency_code = 'CAD'),
  time_zone text NOT NULL CHECK (char_length(time_zone) BETWEEN 1 AND 64),
  business_day_start_local_time time without time zone NOT NULL DEFAULT TIME '04:00:00',
  address_reference platform_helpers.uuid_v7 NOT NULL,
  contact_reference platform_helpers.uuid_v7 NOT NULL,
  receipt_reference platform_helpers.uuid_v7 NOT NULL,
  tax_configuration_reference platform_helpers.uuid_v7 NOT NULL,
  payment_configuration_reference platform_helpers.uuid_v7 NOT NULL,
  capacity_configuration_reference platform_helpers.uuid_v7,
  enabled_service_modes text[] NOT NULL CHECK (
    cardinality(enabled_service_modes) BETWEEN 1 AND 3
    AND enabled_service_modes <@ ARRAY['DineIn','Pickup','Delivery']::text[]
  ),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  supersedes_configuration_reference platform_helpers.uuid_v7,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  authored_by_reference platform_helpers.uuid_v7 NOT NULL,
  approved_by_reference platform_helpers.uuid_v7,
  approval_evidence_reference platform_helpers.uuid_v7,
  publication_reference platform_helpers.uuid_v7,
  live_gate_evidence_reference platform_helpers.uuid_v7,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL CHECK (updated_at >= created_at),
  data_classification text NOT NULL CHECK (data_classification = 'ConfigurationMetadata'),
  CONSTRAINT store_configuration_version_pkey PRIMARY KEY (brand_id,store_id,configuration_id),
  CONSTRAINT store_configuration_version_unique UNIQUE (brand_id,store_id,configuration_version),
  CONSTRAINT store_configuration_period CHECK (effective_until IS NULL OR effective_until > effective_from),
  CONSTRAINT store_configuration_supersession CHECK ((configuration_version = 1) = (supersedes_configuration_reference IS NULL)),
  CONSTRAINT store_configuration_approval CHECK (
    (approved_by_reference IS NULL) = (approval_evidence_reference IS NULL)
    AND (approved_by_reference IS NULL OR approved_by_reference <> authored_by_reference)
    AND ((lifecycle IN ('Draft','PendingApproval')) = (approved_by_reference IS NULL))
    AND ((lifecycle IN ('Published','Superseded','Archived')) = (publication_reference IS NOT NULL))
    AND ((lifecycle IN ('Published','Superseded','Archived')) = (live_gate_evidence_reference IS NOT NULL))
  )
);

CREATE TABLE rms_store.store_weekly_service_period (
  period_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  configuration_id platform_helpers.uuid_v7 NOT NULL,
  iso_weekday smallint NOT NULL CHECK (iso_weekday BETWEEN 1 AND 7),
  sequence_number smallint NOT NULL CHECK (sequence_number BETWEEN 1 AND 16),
  start_local_time time without time zone NOT NULL,
  end_local_time time without time zone NOT NULL,
  ends_next_day boolean NOT NULL,
  service_modes text[] NOT NULL CHECK (cardinality(service_modes) BETWEEN 1 AND 3 AND service_modes <@ ARRAY['DineIn','Pickup','Delivery']::text[]),
  order_cutoff_seconds integer NOT NULL CHECK (order_cutoff_seconds BETWEEN 0 AND 86400),
  lead_time_seconds integer NOT NULL CHECK (lead_time_seconds BETWEEN 0 AND 86400),
  data_classification text NOT NULL CHECK (data_classification = 'ConfigurationMetadata'),
  CONSTRAINT store_weekly_service_period_pkey PRIMARY KEY (brand_id,store_id,period_id),
  CONSTRAINT store_weekly_service_configuration_fkey FOREIGN KEY (brand_id,store_id,configuration_id)
    REFERENCES rms_store.store_configuration_version (brand_id,store_id,configuration_id),
  CONSTRAINT store_weekly_service_sequence_unique UNIQUE (brand_id,store_id,configuration_id,iso_weekday,sequence_number),
  CONSTRAINT store_weekly_service_time CHECK (
    (NOT ends_next_day AND end_local_time > start_local_time)
    OR (ends_next_day AND end_local_time < start_local_time)
  )
);

CREATE TABLE rms_store.store_service_exception (
  exception_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  configuration_id platform_helpers.uuid_v7 NOT NULL,
  local_date date NOT NULL,
  exception_kind text NOT NULL CHECK (exception_kind IN ('Holiday','TemporaryClosure','Override')),
  interval_summary_digest text NOT NULL CHECK (interval_summary_digest ~ '^sha256:[0-9a-f]{64}$'),
  data_classification text NOT NULL CHECK (data_classification = 'ConfigurationMetadata'),
  CONSTRAINT store_service_exception_pkey PRIMARY KEY (brand_id,store_id,exception_id),
  CONSTRAINT store_service_exception_configuration_fkey FOREIGN KEY (brand_id,store_id,configuration_id)
    REFERENCES rms_store.store_configuration_version (brand_id,store_id,configuration_id),
  CONSTRAINT store_service_exception_date_unique UNIQUE (brand_id,store_id,configuration_id,local_date)
);

CREATE TABLE rms_store.store_configuration_operation (
  operation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  configuration_id platform_helpers.uuid_v7 NOT NULL,
  command_type text NOT NULL CHECK (command_type IN ('SaveDraft','Validate','Submit','Approve','Publish','Schedule','CreateOverride','PauseService','ResumeService')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  expected_version bigint NOT NULL CHECK (expected_version >= 0),
  resulting_version bigint NOT NULL CHECK (resulting_version > 0),
  actor_reference platform_helpers.uuid_v7 NOT NULL,
  purpose_code text NOT NULL CHECK (purpose_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  audit_reference platform_helpers.uuid_v7 NOT NULL,
  occurred_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'ConfigurationMetadata'),
  CONSTRAINT store_configuration_operation_pkey PRIMARY KEY (brand_id,store_id,operation_id),
  CONSTRAINT store_configuration_operation_configuration_fkey FOREIGN KEY (brand_id,store_id,configuration_id)
    REFERENCES rms_store.store_configuration_version (brand_id,store_id,configuration_id)
);

CREATE INDEX store_configuration_effective_idx ON rms_store.store_configuration_version
  (brand_id,store_id,lifecycle,effective_from,configuration_version DESC);
CREATE INDEX store_weekly_service_idx ON rms_store.store_weekly_service_period
  (brand_id,store_id,configuration_id,iso_weekday,sequence_number);

CREATE TRIGGER store_configuration_no_update_trigger BEFORE UPDATE ON rms_store.store_configuration_version
  FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_configuration_history_update();
CREATE RULE store_configuration_no_delete AS ON DELETE TO rms_store.store_configuration_version DO INSTEAD NOTHING;
CREATE TRIGGER store_weekly_service_no_update_trigger BEFORE UPDATE ON rms_store.store_weekly_service_period
  FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_configuration_history_update();
CREATE RULE store_weekly_service_no_delete AS ON DELETE TO rms_store.store_weekly_service_period DO INSTEAD NOTHING;
CREATE TRIGGER store_service_exception_no_update_trigger BEFORE UPDATE ON rms_store.store_service_exception
  FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_configuration_history_update();
CREATE RULE store_service_exception_no_delete AS ON DELETE TO rms_store.store_service_exception DO INSTEAD NOTHING;
CREATE TRIGGER store_configuration_operation_no_update_trigger BEFORE UPDATE ON rms_store.store_configuration_operation
  FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_configuration_history_update();
CREATE RULE store_configuration_operation_no_delete AS ON DELETE TO rms_store.store_configuration_operation DO INSTEAD NOTHING;

ALTER TABLE rms_store.store_configuration_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_configuration_version FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_weekly_service_period ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_weekly_service_period FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_service_exception ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_service_exception FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_configuration_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_configuration_operation FORCE ROW LEVEL SECURITY;

CREATE POLICY store_configuration_scope_policy ON rms_store.store_configuration_version
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
CREATE POLICY store_weekly_service_scope_policy ON rms_store.store_weekly_service_period
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
CREATE POLICY store_service_exception_scope_policy ON rms_store.store_service_exception
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
CREATE POLICY store_configuration_operation_scope_policy ON rms_store.store_configuration_operation
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());

REVOKE ALL ON TABLE rms_store.store_configuration_version FROM PUBLIC;
REVOKE ALL ON TABLE rms_store.store_weekly_service_period FROM PUBLIC;
REVOKE ALL ON TABLE rms_store.store_service_exception FROM PUBLIC;
REVOKE ALL ON TABLE rms_store.store_configuration_operation FROM PUBLIC;
