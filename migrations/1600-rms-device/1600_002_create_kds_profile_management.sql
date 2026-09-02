-- bop-rms-migration: 1
-- owner: @rms/printing-device
-- schema: rms_device
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE FUNCTION rms_device.enforce_kds_profile_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.brand_id <> OLD.brand_id
    OR NEW.store_id <> OLD.store_id
    OR NEW.profile_id <> OLD.profile_id
    OR NEW.created_at <> OLD.created_at
    OR NEW.created_by_reference <> OLD.created_by_reference
    OR NEW.aggregate_version <> OLD.aggregate_version + 1 THEN
    RAISE EXCEPTION 'KDS profile identity or revision is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_device.enforce_kds_profile_revision() FROM PUBLIC;

CREATE TABLE rms_device.kds_profile (
  profile_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft', 'Published', 'Revoked')),
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  current_version_reference platform_helpers.uuid_v7 NOT NULL,
  created_by_reference platform_helpers.uuid_v7 NOT NULL,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL CHECK (updated_at >= created_at),
  data_classification text NOT NULL CHECK (data_classification = 'Confidential'),
  CONSTRAINT kds_profile_pkey PRIMARY KEY (brand_id, store_id, profile_id)
);

CREATE TABLE rms_device.kds_profile_version (
  version_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  profile_id platform_helpers.uuid_v7 NOT NULL,
  version_number bigint NOT NULL CHECK (version_number > 0),
  profile_label_code text NOT NULL CHECK (profile_label_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  browser_family text NOT NULL CHECK (browser_family = 'ChromiumManaged'),
  minimum_logical_width integer NOT NULL CHECK (minimum_logical_width >= 1024),
  minimum_logical_height integer NOT NULL CHECK (minimum_logical_height >= 768),
  wake_policy_code text NOT NULL CHECK (wake_policy_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  power_policy_code text NOT NULL CHECK (power_policy_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  auto_lock_seconds integer NOT NULL CHECK (auto_lock_seconds BETWEEN 60 AND 900),
  visibility_loss_locks boolean NOT NULL CHECK (visibility_loss_locks),
  handover_policy text NOT NULL CHECK (handover_policy = 'LockThenRotateNamedSession'),
  notification_mode text NOT NULL CHECK (notification_mode IN ('VisualAndAudible', 'VisualOnly')),
  network_procedure_code text NOT NULL CHECK (network_procedure_code = 'KDS-NETWORK-RECOVERY-V1'),
  replacement_procedure_code text NOT NULL CHECK (replacement_procedure_code = 'KDS-REPLACEMENT-V1'),
  checklist_version_code text NOT NULL CHECK (checklist_version_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  created_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'Confidential'),
  CONSTRAINT kds_profile_version_pkey PRIMARY KEY (brand_id, store_id, version_id),
  CONSTRAINT kds_profile_version_profile_fkey FOREIGN KEY (brand_id, store_id, profile_id)
    REFERENCES rms_device.kds_profile (brand_id, store_id, profile_id),
  CONSTRAINT kds_profile_version_number_unique UNIQUE (brand_id, store_id, profile_id, version_number)
);

CREATE TABLE rms_device.kds_profile_assignment (
  assignment_record_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  profile_id platform_helpers.uuid_v7 NOT NULL,
  device_id platform_helpers.uuid_v7 NOT NULL,
  station_reference platform_helpers.uuid_v7 NOT NULL,
  assignment_action text NOT NULL CHECK (assignment_action IN ('Assigned', 'Unassigned')),
  effective_from timestamp with time zone NOT NULL,
  effective_to timestamp with time zone,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  recorded_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'Confidential'),
  CONSTRAINT kds_profile_assignment_pkey PRIMARY KEY (brand_id, store_id, assignment_record_id),
  CONSTRAINT kds_profile_assignment_profile_fkey FOREIGN KEY (brand_id, store_id, profile_id)
    REFERENCES rms_device.kds_profile (brand_id, store_id, profile_id),
  CONSTRAINT kds_profile_assignment_device_fkey FOREIGN KEY (brand_id, store_id, device_id)
    REFERENCES rms_device.device (brand_id, store_id, device_id),
  CONSTRAINT kds_profile_assignment_period CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT kds_profile_assignment_version_unique UNIQUE (brand_id, store_id, profile_id, aggregate_version)
);

CREATE TABLE rms_device.kds_uat_run (
  run_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  profile_id platform_helpers.uuid_v7 NOT NULL,
  profile_version_reference platform_helpers.uuid_v7 NOT NULL,
  device_id platform_helpers.uuid_v7 NOT NULL,
  station_reference platform_helpers.uuid_v7 NOT NULL,
  run_number bigint NOT NULL CHECK (run_number > 0),
  checklist_version_code text NOT NULL CHECK (checklist_version_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  browser_version_code text NOT NULL CHECK (browser_version_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  logical_width integer NOT NULL CHECK (logical_width >= 1024),
  logical_height integer NOT NULL CHECK (logical_height >= 768),
  status text NOT NULL CHECK (status IN ('NotRun', 'InProgress', 'Blocked', 'Failed', 'Passed')),
  due_at timestamp with time zone NOT NULL,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  evidence_reference platform_helpers.uuid_v7,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  recorded_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'Confidential'),
  CONSTRAINT kds_uat_run_pkey PRIMARY KEY (brand_id, store_id, run_id),
  CONSTRAINT kds_uat_run_profile_fkey FOREIGN KEY (brand_id, store_id, profile_id)
    REFERENCES rms_device.kds_profile (brand_id, store_id, profile_id),
  CONSTRAINT kds_uat_run_device_fkey FOREIGN KEY (brand_id, store_id, device_id)
    REFERENCES rms_device.device (brand_id, store_id, device_id),
  CONSTRAINT kds_uat_run_number_unique UNIQUE (brand_id, store_id, profile_id, run_number),
  CONSTRAINT kds_uat_run_shape CHECK (
    (status = 'NotRun') = (started_at IS NULL)
    AND (status IN ('Blocked', 'Failed', 'Passed')) = (completed_at IS NOT NULL)
    AND (status = 'Passed') = (evidence_reference IS NOT NULL)
  )
);

CREATE TABLE rms_device.kds_uat_check_result (
  result_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  run_id platform_helpers.uuid_v7 NOT NULL,
  check_code text NOT NULL CHECK (check_code IN (
    'ACCESSIBILITY', 'AUTO_LOCK', 'MANAGED_BROWSER', 'NAMED_SESSION_HANDOVER', 'NETWORK_LOSS',
    'NOTIFICATION', 'REPLACEMENT', 'RESOLUTION', 'VISIBILITY_LOCK', 'WAKE_POWER'
  )),
  outcome text NOT NULL CHECK (outcome IN ('Passed', 'Failed', 'Blocked')),
  safe_result_code text NOT NULL CHECK (safe_result_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  recorded_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'Confidential'),
  CONSTRAINT kds_uat_check_result_pkey PRIMARY KEY (brand_id, store_id, result_id),
  CONSTRAINT kds_uat_check_result_run_fkey FOREIGN KEY (brand_id, store_id, run_id)
    REFERENCES rms_device.kds_uat_run (brand_id, store_id, run_id),
  CONSTRAINT kds_uat_check_result_unique UNIQUE (brand_id, store_id, run_id, check_code)
);

CREATE TABLE rms_device.kds_profile_operation (
  operation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  profile_id platform_helpers.uuid_v7 NOT NULL,
  command_type text NOT NULL CHECK (command_type IN (
    'CreateKdsProfile', 'ReviseKdsProfile', 'AssignKdsProfile', 'RecordKdsUat',
    'PublishKdsProfile', 'RevokeKdsProfile'
  )),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  occurred_at timestamp with time zone NOT NULL,
  audit_reference platform_helpers.uuid_v7 NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'Confidential'),
  CONSTRAINT kds_profile_operation_pkey PRIMARY KEY (brand_id, store_id, operation_id),
  CONSTRAINT kds_profile_operation_profile_fkey FOREIGN KEY (brand_id, store_id, profile_id)
    REFERENCES rms_device.kds_profile (brand_id, store_id, profile_id),
  CONSTRAINT kds_profile_operation_version_unique UNIQUE (brand_id, store_id, profile_id, aggregate_version)
);

CREATE INDEX kds_profile_lifecycle_idx ON rms_device.kds_profile (brand_id, store_id, lifecycle, updated_at, profile_id);
CREATE INDEX kds_profile_assignment_history_idx ON rms_device.kds_profile_assignment (brand_id, store_id, profile_id, recorded_at, assignment_record_id);
CREATE INDEX kds_uat_due_idx ON rms_device.kds_uat_run (brand_id, store_id, status, due_at, run_id);

CREATE TRIGGER kds_profile_revision_trigger BEFORE UPDATE ON rms_device.kds_profile
  FOR EACH ROW EXECUTE FUNCTION rms_device.enforce_kds_profile_revision();
CREATE RULE kds_profile_no_delete AS ON DELETE TO rms_device.kds_profile DO INSTEAD NOTHING;
CREATE TRIGGER kds_profile_version_no_update_trigger BEFORE UPDATE ON rms_device.kds_profile_version
  FOR EACH ROW EXECUTE FUNCTION rms_device.reject_device_history_update();
CREATE RULE kds_profile_version_no_delete AS ON DELETE TO rms_device.kds_profile_version DO INSTEAD NOTHING;
CREATE TRIGGER kds_profile_assignment_no_update_trigger BEFORE UPDATE ON rms_device.kds_profile_assignment
  FOR EACH ROW EXECUTE FUNCTION rms_device.reject_device_history_update();
CREATE RULE kds_profile_assignment_no_delete AS ON DELETE TO rms_device.kds_profile_assignment DO INSTEAD NOTHING;
CREATE TRIGGER kds_uat_run_no_update_trigger BEFORE UPDATE ON rms_device.kds_uat_run
  FOR EACH ROW EXECUTE FUNCTION rms_device.reject_device_history_update();
CREATE RULE kds_uat_run_no_delete AS ON DELETE TO rms_device.kds_uat_run DO INSTEAD NOTHING;
CREATE TRIGGER kds_uat_check_no_update_trigger BEFORE UPDATE ON rms_device.kds_uat_check_result
  FOR EACH ROW EXECUTE FUNCTION rms_device.reject_device_history_update();
CREATE RULE kds_uat_check_no_delete AS ON DELETE TO rms_device.kds_uat_check_result DO INSTEAD NOTHING;
CREATE TRIGGER kds_profile_operation_no_update_trigger BEFORE UPDATE ON rms_device.kds_profile_operation
  FOR EACH ROW EXECUTE FUNCTION rms_device.reject_device_history_update();
CREATE RULE kds_profile_operation_no_delete AS ON DELETE TO rms_device.kds_profile_operation DO INSTEAD NOTHING;

ALTER TABLE rms_device.kds_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_device.kds_profile FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_device.kds_profile_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_device.kds_profile_version FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_device.kds_profile_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_device.kds_profile_assignment FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_device.kds_uat_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_device.kds_uat_run FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_device.kds_uat_check_result ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_device.kds_uat_check_result FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_device.kds_profile_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_device.kds_profile_operation FORCE ROW LEVEL SECURITY;

CREATE POLICY kds_profile_scope_policy ON rms_device.kds_profile USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id()) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY kds_profile_version_scope_policy ON rms_device.kds_profile_version USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id()) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY kds_profile_assignment_scope_policy ON rms_device.kds_profile_assignment USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id()) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY kds_uat_run_scope_policy ON rms_device.kds_uat_run USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id()) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY kds_uat_check_scope_policy ON rms_device.kds_uat_check_result USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id()) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
CREATE POLICY kds_profile_operation_scope_policy ON rms_device.kds_profile_operation USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id()) WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());

REVOKE ALL ON TABLE rms_device.kds_profile FROM PUBLIC;
REVOKE ALL ON TABLE rms_device.kds_profile_version FROM PUBLIC;
REVOKE ALL ON TABLE rms_device.kds_profile_assignment FROM PUBLIC;
REVOKE ALL ON TABLE rms_device.kds_uat_run FROM PUBLIC;
REVOKE ALL ON TABLE rms_device.kds_uat_check_result FROM PUBLIC;
REVOKE ALL ON TABLE rms_device.kds_profile_operation FROM PUBLIC;
