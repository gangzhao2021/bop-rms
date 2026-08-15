-- bop-rms-migration: 1
-- owner: @rms/printing-device
-- schema: rms_device
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA rms_device;
REVOKE ALL ON SCHEMA rms_device FROM PUBLIC;

CREATE FUNCTION rms_device.reject_device_history_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'device history is append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_device.reject_device_history_update() FROM PUBLIC;

CREATE FUNCTION rms_device.enforce_device_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.brand_id <> OLD.brand_id
    OR NEW.store_id <> OLD.store_id
    OR NEW.device_id <> OLD.device_id
    OR NEW.device_type <> OLD.device_type
    OR NEW.device_code <> OLD.device_code
    OR NEW.created_at <> OLD.created_at
    OR NEW.created_by_reference <> OLD.created_by_reference
    OR NEW.aggregate_version <> OLD.aggregate_version + 1 THEN
    RAISE EXCEPTION 'device identity or revision is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_device.enforce_device_revision() FROM PUBLIC;

CREATE TABLE rms_device.device (
  device_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  device_type text NOT NULL CHECK (device_type IN (
    'PosTerminal', 'ReceiptPrinter', 'KitchenPrinter', 'LabelPrinter', 'KitchenDisplay',
    'CustomerDisplay', 'OrderStatusDisplay', 'KitchenAlertDevice',
    'PaymentTerminalReference', 'StoreGateway', 'Other'
  )),
  device_code text NOT NULL CHECK (device_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  safe_serial_suffix text CHECK (safe_serial_suffix IS NULL OR safe_serial_suffix ~ '^[A-Z0-9]{4,12}$'),
  lifecycle text NOT NULL CHECK (lifecycle IN (
    'Draft', 'Provisioning', 'Active', 'Suspended', 'Inactive', 'Retired'
  )),
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  configuration_version bigint NOT NULL CHECK (configuration_version > 0),
  display_label_code text NOT NULL CHECK (display_label_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  physical_location_reference platform_helpers.uuid_v7,
  network_connection_type_code text NOT NULL
    CHECK (network_connection_type_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  adapter_type_code text NOT NULL CHECK (adapter_type_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  adapter_version_code text NOT NULL CHECK (adapter_version_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  locale text NOT NULL CHECK (locale ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  time_zone text NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 64),
  output_profile_reference platform_helpers.uuid_v7,
  heartbeat_interval_seconds integer NOT NULL CHECK (heartbeat_interval_seconds BETWEEN 15 AND 3600),
  credential_reference platform_helpers.uuid_v7,
  credential_version integer CHECK (credential_version IS NULL OR credential_version > 0),
  credential_status text NOT NULL CHECK (credential_status IN ('NotProvisioned', 'Active', 'Revoked')),
  created_by_reference platform_helpers.uuid_v7 NOT NULL,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL CHECK (updated_at >= created_at),
  data_classification text NOT NULL CHECK (data_classification = 'CredentialMetadata'),
  CONSTRAINT device_pkey PRIMARY KEY (brand_id, store_id, device_id),
  CONSTRAINT device_code_unique UNIQUE (brand_id, store_id, device_code),
  CONSTRAINT device_credential_shape CHECK (
    (credential_reference IS NULL) = (credential_version IS NULL)
    AND ((credential_status = 'NotProvisioned') = (credential_reference IS NULL))
    AND (lifecycle <> 'Active' OR credential_status = 'Active')
  )
);

CREATE TABLE rms_device.device_capability_version (
  capability_version_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  device_id platform_helpers.uuid_v7 NOT NULL,
  configuration_version bigint NOT NULL CHECK (configuration_version > 0),
  capability_code text NOT NULL CHECK (capability_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  validated_model_reference platform_helpers.uuid_v7 NOT NULL,
  validation_reference platform_helpers.uuid_v7 NOT NULL,
  recorded_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'IndirectIdentifier'),
  CONSTRAINT device_capability_version_pkey
    PRIMARY KEY (brand_id, store_id, capability_version_id),
  CONSTRAINT device_capability_version_device_fkey
    FOREIGN KEY (brand_id, store_id, device_id)
    REFERENCES rms_device.device (brand_id, store_id, device_id),
  CONSTRAINT device_capability_version_unique
    UNIQUE (brand_id, store_id, device_id, configuration_version, capability_code)
);

CREATE TABLE rms_device.device_assignment (
  assignment_record_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  device_id platform_helpers.uuid_v7 NOT NULL,
  assignment_reference platform_helpers.uuid_v7 NOT NULL,
  assignment_action text NOT NULL CHECK (assignment_action IN ('Assigned', 'Unassigned')),
  station_reference platform_helpers.uuid_v7,
  profile_reference platform_helpers.uuid_v7,
  configuration_source_reference platform_helpers.uuid_v7 NOT NULL,
  named_operator_session_summary_reference platform_helpers.uuid_v7,
  effective_from timestamp with time zone NOT NULL,
  effective_to timestamp with time zone,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  recorded_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'Confidential'),
  CONSTRAINT device_assignment_pkey PRIMARY KEY (brand_id, store_id, assignment_record_id),
  CONSTRAINT device_assignment_device_fkey
    FOREIGN KEY (brand_id, store_id, device_id)
    REFERENCES rms_device.device (brand_id, store_id, device_id),
  CONSTRAINT device_assignment_effective_period CHECK (
    effective_to IS NULL OR effective_to > effective_from
  ),
  CONSTRAINT device_assignment_version_unique
    UNIQUE (brand_id, store_id, device_id, aggregate_version)
);

CREATE TABLE rms_device.device_health_signal (
  signal_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  device_id platform_helpers.uuid_v7 NOT NULL,
  health text NOT NULL CHECK (health IN ('Healthy', 'Degraded', 'Unavailable', 'Unknown')),
  connectivity text NOT NULL CHECK (
    connectivity IN ('Online', 'Offline', 'Intermittent', 'NotApplicable')
  ),
  observed_at timestamp with time zone NOT NULL,
  last_seen_at timestamp with time zone,
  heartbeat_due_at timestamp with time zone,
  software_version_code text NOT NULL CHECK (software_version_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  profile_version_code text NOT NULL CHECK (profile_version_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  incident_reference platform_helpers.uuid_v7,
  data_classification text NOT NULL CHECK (data_classification = 'IndirectIdentifier'),
  CONSTRAINT device_health_signal_pkey PRIMARY KEY (brand_id, store_id, signal_id),
  CONSTRAINT device_health_signal_device_fkey
    FOREIGN KEY (brand_id, store_id, device_id)
    REFERENCES rms_device.device (brand_id, store_id, device_id),
  CONSTRAINT device_health_signal_shape CHECK (
    (connectivity <> 'Online' OR last_seen_at IS NOT NULL)
    AND (health <> 'Healthy' OR connectivity = 'Online')
    AND (last_seen_at IS NULL OR last_seen_at <= observed_at)
    AND (heartbeat_due_at IS NULL OR heartbeat_due_at >= observed_at)
    AND (last_seen_at IS NOT NULL OR health = 'Unknown')
    AND (last_seen_at IS NOT NULL OR connectivity IN ('Offline', 'NotApplicable'))
  )
);

CREATE TABLE rms_device.device_health_current (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  device_id platform_helpers.uuid_v7 NOT NULL,
  signal_id platform_helpers.uuid_v7 NOT NULL,
  health text NOT NULL CHECK (health IN ('Healthy', 'Degraded', 'Unavailable', 'Unknown')),
  connectivity text NOT NULL CHECK (
    connectivity IN ('Online', 'Offline', 'Intermittent', 'NotApplicable')
  ),
  observed_at timestamp with time zone NOT NULL,
  projection_version bigint NOT NULL CHECK (projection_version > 0),
  data_classification text NOT NULL CHECK (data_classification = 'IndirectIdentifier'),
  CONSTRAINT device_health_current_pkey PRIMARY KEY (brand_id, store_id, device_id),
  CONSTRAINT device_health_current_device_fkey
    FOREIGN KEY (brand_id, store_id, device_id)
    REFERENCES rms_device.device (brand_id, store_id, device_id),
  CONSTRAINT device_health_current_signal_fkey
    FOREIGN KEY (brand_id, store_id, signal_id)
    REFERENCES rms_device.device_health_signal (brand_id, store_id, signal_id)
);

CREATE TABLE rms_device.device_operation (
  operation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  device_id platform_helpers.uuid_v7 NOT NULL,
  command_type text NOT NULL CHECK (command_type IN (
    'RegisterDevice', 'ReviseConfiguration', 'ChangeLifecycle', 'AssignDevice',
    'UnassignDevice', 'RecordHealth', 'RevokeCredential', 'OpenIncident'
  )),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  occurred_at timestamp with time zone NOT NULL,
  audit_reference platform_helpers.uuid_v7 NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'CredentialMetadata'),
  CONSTRAINT device_operation_pkey PRIMARY KEY (brand_id, store_id, operation_id),
  CONSTRAINT device_operation_device_fkey
    FOREIGN KEY (brand_id, store_id, device_id)
    REFERENCES rms_device.device (brand_id, store_id, device_id),
  CONSTRAINT device_operation_version_unique
    UNIQUE (brand_id, store_id, device_id, aggregate_version)
);

CREATE INDEX device_lifecycle_idx
  ON rms_device.device (brand_id, store_id, lifecycle, updated_at, device_id);
CREATE INDEX device_assignment_history_idx
  ON rms_device.device_assignment (brand_id, store_id, device_id, recorded_at, assignment_record_id);
CREATE INDEX device_health_history_idx
  ON rms_device.device_health_signal (brand_id, store_id, device_id, observed_at, signal_id);

CREATE TRIGGER device_revision_trigger
  BEFORE UPDATE ON rms_device.device
  FOR EACH ROW EXECUTE FUNCTION rms_device.enforce_device_revision();
CREATE RULE device_no_delete AS ON DELETE TO rms_device.device DO INSTEAD NOTHING;
CREATE TRIGGER device_capability_no_update_trigger
  BEFORE UPDATE ON rms_device.device_capability_version
  FOR EACH ROW EXECUTE FUNCTION rms_device.reject_device_history_update();
CREATE RULE device_capability_no_delete AS
  ON DELETE TO rms_device.device_capability_version DO INSTEAD NOTHING;
CREATE TRIGGER device_assignment_no_update_trigger
  BEFORE UPDATE ON rms_device.device_assignment
  FOR EACH ROW EXECUTE FUNCTION rms_device.reject_device_history_update();
CREATE RULE device_assignment_no_delete AS
  ON DELETE TO rms_device.device_assignment DO INSTEAD NOTHING;
CREATE TRIGGER device_health_signal_no_update_trigger
  BEFORE UPDATE ON rms_device.device_health_signal
  FOR EACH ROW EXECUTE FUNCTION rms_device.reject_device_history_update();
CREATE RULE device_health_signal_no_delete AS
  ON DELETE TO rms_device.device_health_signal DO INSTEAD NOTHING;
CREATE TRIGGER device_operation_no_update_trigger
  BEFORE UPDATE ON rms_device.device_operation
  FOR EACH ROW EXECUTE FUNCTION rms_device.reject_device_history_update();
CREATE RULE device_operation_no_delete AS
  ON DELETE TO rms_device.device_operation DO INSTEAD NOTHING;

ALTER TABLE rms_device.device ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_device.device FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_device.device_capability_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_device.device_capability_version FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_device.device_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_device.device_assignment FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_device.device_health_signal ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_device.device_health_signal FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_device.device_health_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_device.device_health_current FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_device.device_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_device.device_operation FORCE ROW LEVEL SECURITY;

CREATE POLICY device_scope_policy ON rms_device.device
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY device_capability_scope_policy ON rms_device.device_capability_version
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY device_assignment_scope_policy ON rms_device.device_assignment
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY device_health_signal_scope_policy ON rms_device.device_health_signal
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY device_health_current_scope_policy ON rms_device.device_health_current
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY device_operation_scope_policy ON rms_device.device_operation
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());

REVOKE ALL ON TABLE rms_device.device FROM PUBLIC;
REVOKE ALL ON TABLE rms_device.device_capability_version FROM PUBLIC;
REVOKE ALL ON TABLE rms_device.device_assignment FROM PUBLIC;
REVOKE ALL ON TABLE rms_device.device_health_signal FROM PUBLIC;
REVOKE ALL ON TABLE rms_device.device_health_current FROM PUBLIC;
REVOKE ALL ON TABLE rms_device.device_operation FROM PUBLIC;
