-- bop-rms-migration: 1
-- owner: @rms/business-intelligence
-- schema: rms_reporting
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_reporting.report_run (
  run_id platform_helpers.uuid_v7 PRIMARY KEY,
  report_id platform_helpers.uuid_v7 NOT NULL,
  report_version_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  parameter_snapshot_digest text NOT NULL CHECK (parameter_snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('Manual','Scheduled')),
  schedule_version_id platform_helpers.uuid_v7,
  triggered_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  rerun_of_run_id platform_helpers.uuid_v7,
  queued_at timestamp with time zone NOT NULL,
  CONSTRAINT report_run_report_version_fk FOREIGN KEY (report_version_id,report_id,tenant_id,brand_id) REFERENCES rms_reporting.report_version(report_version_id,report_id,tenant_id,brand_id),
  CONSTRAINT report_run_scope_identity_unique UNIQUE (run_id,tenant_id,brand_id),
  CONSTRAINT report_run_schedule_alignment_check CHECK ((trigger_kind='Scheduled')=(schedule_version_id IS NOT NULL)),
  CONSTRAINT report_run_rerun_self_check CHECK (rerun_of_run_id IS NULL OR rerun_of_run_id<>run_id),
  CONSTRAINT report_run_rerun_fk FOREIGN KEY (rerun_of_run_id,tenant_id,brand_id) REFERENCES rms_reporting.report_run(run_id,tenant_id,brand_id)
);

CREATE TABLE rms_reporting.report_run_metric_reference (
  run_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  metric_version_reference platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (run_id,metric_version_reference),
  CONSTRAINT report_run_metric_run_fk FOREIGN KEY (run_id,tenant_id,brand_id) REFERENCES rms_reporting.report_run(run_id,tenant_id,brand_id)
);

CREATE TABLE rms_reporting.report_run_state_record (
  state_id platform_helpers.uuid_v7 PRIMARY KEY,
  run_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  sequence integer NOT NULL CHECK (sequence>0),
  status text NOT NULL CHECK (status IN ('Queued','Running','Completed','CompletedWithWarning','Failed','Cancelled')),
  occurred_at timestamp with time zone NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  data_as_of timestamp with time zone,
  projection_checkpoint text CHECK (projection_checkpoint IS NULL OR projection_checkpoint ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  generated_at timestamp with time zone,
  duration_milliseconds integer CHECK (duration_milliseconds BETWEEN 0 AND 86400000),
  row_count integer CHECK (row_count BETWEEN 0 AND 100000),
  summary_digest text CHECK (summary_digest IS NULL OR summary_digest ~ '^sha256:[0-9a-f]{64}$'),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  CONSTRAINT report_run_state_run_fk FOREIGN KEY (run_id,tenant_id,brand_id) REFERENCES rms_reporting.report_run(run_id,tenant_id,brand_id),
  CONSTRAINT report_run_state_sequence_unique UNIQUE (run_id,sequence),
  CONSTRAINT report_run_state_result_alignment_check CHECK (
    (status IN ('Queued','Running','Cancelled') AND data_as_of IS NULL AND projection_checkpoint IS NULL AND generated_at IS NULL AND duration_milliseconds IS NULL AND row_count IS NULL AND summary_digest IS NULL AND (status='Cancelled' OR error_code IS NULL)) OR
    (status='Completed' AND data_as_of IS NOT NULL AND projection_checkpoint IS NOT NULL AND generated_at IS NOT NULL AND duration_milliseconds IS NOT NULL AND row_count IS NOT NULL AND summary_digest IS NOT NULL AND error_code IS NULL) OR
    (status='CompletedWithWarning' AND data_as_of IS NOT NULL AND projection_checkpoint IS NOT NULL AND generated_at IS NOT NULL AND duration_milliseconds IS NOT NULL AND row_count IS NOT NULL AND summary_digest IS NOT NULL AND error_code IS NOT NULL) OR
    (status='Failed' AND generated_at IS NOT NULL AND duration_milliseconds IS NOT NULL AND error_code IS NOT NULL)
  )
);

CREATE TABLE rms_reporting.report_artifact (
  artifact_id platform_helpers.uuid_v7 PRIMARY KEY,
  run_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  created_at timestamp with time zone NOT NULL,
  CONSTRAINT report_artifact_run_fk FOREIGN KEY (run_id,tenant_id,brand_id) REFERENCES rms_reporting.report_run(run_id,tenant_id,brand_id),
  CONSTRAINT report_artifact_scope_identity_unique UNIQUE (artifact_id,tenant_id,brand_id)
);

CREATE TABLE rms_reporting.report_artifact_revision (
  revision_id platform_helpers.uuid_v7 PRIMARY KEY,
  artifact_id platform_helpers.uuid_v7 NOT NULL,
  run_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  revision_number integer NOT NULL CHECK (revision_number>0),
  output_asset_reference platform_helpers.uuid_v7 NOT NULL UNIQUE,
  format text NOT NULL CHECK (format IN ('Csv','Spreadsheet','Pdf')),
  data_classification text NOT NULL CHECK (data_classification IN ('Public','Internal','Confidential','Restricted')),
  created_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  CONSTRAINT report_artifact_revision_artifact_fk FOREIGN KEY (artifact_id,tenant_id,brand_id) REFERENCES rms_reporting.report_artifact(artifact_id,tenant_id,brand_id),
  CONSTRAINT report_artifact_revision_run_fk FOREIGN KEY (run_id,tenant_id,brand_id) REFERENCES rms_reporting.report_run(run_id,tenant_id,brand_id),
  CONSTRAINT report_artifact_revision_number_unique UNIQUE (artifact_id,revision_number),
  CONSTRAINT report_artifact_revision_expiry_check CHECK (expires_at>created_at)
);

CREATE TABLE rms_reporting.report_artifact_revocation (
  revocation_id platform_helpers.uuid_v7 PRIMARY KEY,
  artifact_id platform_helpers.uuid_v7 NOT NULL,
  revision_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  revoked_at timestamp with time zone NOT NULL,
  revoked_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  CONSTRAINT report_artifact_revocation_artifact_fk FOREIGN KEY (artifact_id,tenant_id,brand_id) REFERENCES rms_reporting.report_artifact(artifact_id,tenant_id,brand_id),
  CONSTRAINT report_artifact_revocation_revision_fk FOREIGN KEY (revision_id) REFERENCES rms_reporting.report_artifact_revision(revision_id)
);

CREATE TABLE rms_reporting.report_run_operation_record (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  run_id platform_helpers.uuid_v7,
  artifact_id platform_helpers.uuid_v7,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  action_code text NOT NULL CHECK (action_code IN ('Queue','Rerun','Transition','RecordArtifact','RevokeArtifact','DownloadArtifact')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  result_reference platform_helpers.uuid_v7 NOT NULL,
  outbox_event_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  occurred_at timestamp with time zone NOT NULL,
  CONSTRAINT report_run_operation_target_check CHECK (run_id IS NOT NULL OR artifact_id IS NOT NULL)
);

CREATE TABLE rms_reporting.report_artifact_download_record (
  download_record_id platform_helpers.uuid_v7 PRIMARY KEY,
  artifact_id platform_helpers.uuid_v7 NOT NULL,
  revision_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  authorized_at timestamp with time zone NOT NULL,
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  CONSTRAINT report_artifact_download_artifact_fk FOREIGN KEY (artifact_id,tenant_id,brand_id) REFERENCES rms_reporting.report_artifact(artifact_id,tenant_id,brand_id),
  CONSTRAINT report_artifact_download_revision_fk FOREIGN KEY (revision_id) REFERENCES rms_reporting.report_artifact_revision(revision_id)
);

CREATE RULE report_run_no_update AS ON UPDATE TO rms_reporting.report_run DO INSTEAD NOTHING;
CREATE RULE report_run_no_delete AS ON DELETE TO rms_reporting.report_run DO INSTEAD NOTHING;
CREATE RULE report_run_metric_no_update AS ON UPDATE TO rms_reporting.report_run_metric_reference DO INSTEAD NOTHING;
CREATE RULE report_run_metric_no_delete AS ON DELETE TO rms_reporting.report_run_metric_reference DO INSTEAD NOTHING;
CREATE RULE report_run_state_no_update AS ON UPDATE TO rms_reporting.report_run_state_record DO INSTEAD NOTHING;
CREATE RULE report_run_state_no_delete AS ON DELETE TO rms_reporting.report_run_state_record DO INSTEAD NOTHING;
CREATE RULE report_artifact_no_update AS ON UPDATE TO rms_reporting.report_artifact DO INSTEAD NOTHING;
CREATE RULE report_artifact_no_delete AS ON DELETE TO rms_reporting.report_artifact DO INSTEAD NOTHING;
CREATE RULE report_artifact_revision_no_update AS ON UPDATE TO rms_reporting.report_artifact_revision DO INSTEAD NOTHING;
CREATE RULE report_artifact_revision_no_delete AS ON DELETE TO rms_reporting.report_artifact_revision DO INSTEAD NOTHING;
CREATE RULE report_artifact_revocation_no_update AS ON UPDATE TO rms_reporting.report_artifact_revocation DO INSTEAD NOTHING;
CREATE RULE report_artifact_revocation_no_delete AS ON DELETE TO rms_reporting.report_artifact_revocation DO INSTEAD NOTHING;
CREATE RULE report_run_operation_no_update AS ON UPDATE TO rms_reporting.report_run_operation_record DO INSTEAD NOTHING;
CREATE RULE report_run_operation_no_delete AS ON DELETE TO rms_reporting.report_run_operation_record DO INSTEAD NOTHING;
CREATE RULE report_artifact_download_no_update AS ON UPDATE TO rms_reporting.report_artifact_download_record DO INSTEAD NOTHING;
CREATE RULE report_artifact_download_no_delete AS ON DELETE TO rms_reporting.report_artifact_download_record DO INSTEAD NOTHING;

ALTER TABLE rms_reporting.report_run ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.report_run FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.report_run_metric_reference ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.report_run_metric_reference FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.report_run_state_record ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.report_run_state_record FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.report_artifact ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.report_artifact FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.report_artifact_revision ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.report_artifact_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.report_artifact_revocation ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.report_artifact_revocation FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.report_run_operation_record ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.report_run_operation_record FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.report_artifact_download_record ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.report_artifact_download_record FORCE ROW LEVEL SECURITY;

CREATE POLICY report_run_scope_policy ON rms_reporting.report_run USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY report_run_metric_scope_policy ON rms_reporting.report_run_metric_reference USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY report_run_state_scope_policy ON rms_reporting.report_run_state_record USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY report_artifact_scope_policy ON rms_reporting.report_artifact USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY report_artifact_revision_scope_policy ON rms_reporting.report_artifact_revision USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY report_artifact_revocation_scope_policy ON rms_reporting.report_artifact_revocation USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY report_run_operation_scope_policy ON rms_reporting.report_run_operation_record USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY report_artifact_download_scope_policy ON rms_reporting.report_artifact_download_record USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));

REVOKE ALL ON TABLE rms_reporting.report_run FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.report_run_metric_reference FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.report_run_state_record FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.report_artifact FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.report_artifact_revision FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.report_artifact_revocation FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.report_run_operation_record FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.report_artifact_download_record FROM PUBLIC;
