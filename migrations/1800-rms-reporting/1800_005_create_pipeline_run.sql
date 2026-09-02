-- bop-rms-migration: 1
-- owner: @rms/business-intelligence
-- schema: rms_reporting
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_reporting.backfill_request (
  request_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  current_version_id platform_helpers.uuid_v7,
  lifecycle text NOT NULL CHECK (lifecycle IN ('Requested','Approved','Rejected','Running','Completed','Failed','Cancelled')),
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT backfill_request_scope_identity_unique UNIQUE (request_id,tenant_id,brand_id),
  CONSTRAINT backfill_request_time_order_check CHECK (updated_at >= created_at)
);

CREATE TABLE rms_reporting.backfill_request_version (
  request_version_id platform_helpers.uuid_v7 PRIMARY KEY,
  request_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  version_number integer NOT NULL CHECK (version_number > 0),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Requested','Approved','Rejected','Running','Completed','Failed','Cancelled')),
  pipeline_reference platform_helpers.uuid_v7 NOT NULL,
  pipeline_version_reference platform_helpers.uuid_v7 NOT NULL,
  transformation_version_reference platform_helpers.uuid_v7 NOT NULL,
  output_dataset_version_reference platform_helpers.uuid_v7 NOT NULL,
  output_partition_code text NOT NULL CHECK (output_partition_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  range_from timestamp with time zone NOT NULL,
  range_until timestamp with time zone NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  requested_at timestamp with time zone NOT NULL,
  requested_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  decided_at timestamp with time zone,
  decided_by_actor_id platform_helpers.uuid_v7,
  bound_run_id platform_helpers.uuid_v7,
  recorded_at timestamp with time zone NOT NULL,
  recorded_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  CONSTRAINT backfill_request_version_root_fk FOREIGN KEY (request_id,tenant_id,brand_id) REFERENCES rms_reporting.backfill_request(request_id,tenant_id,brand_id),
  CONSTRAINT backfill_request_version_identity_unique UNIQUE (request_version_id,request_id,tenant_id,brand_id),
  CONSTRAINT backfill_request_version_number_unique UNIQUE (request_id,version_number),
  CONSTRAINT backfill_request_range_check CHECK (range_until > range_from AND range_until <= requested_at),
  CONSTRAINT backfill_request_recorded_time_check CHECK (
    requested_at <= recorded_at AND
    (decided_at IS NULL OR (decided_at >= requested_at AND decided_at <= recorded_at))
  ),
  CONSTRAINT backfill_request_approver_check CHECK (decided_by_actor_id IS NULL OR decided_by_actor_id <> requested_by_actor_id),
  CONSTRAINT backfill_request_decision_alignment_check CHECK (
    (decided_at IS NULL) = (decided_by_actor_id IS NULL) AND
    (bound_run_id IS NULL OR decided_at IS NOT NULL) AND
    ((lifecycle='Requested' AND decided_at IS NULL AND bound_run_id IS NULL) OR
     (lifecycle IN ('Approved','Rejected') AND decided_at IS NOT NULL AND bound_run_id IS NULL) OR
     (lifecycle IN ('Running','Completed','Failed') AND decided_at IS NOT NULL AND bound_run_id IS NOT NULL) OR
     lifecycle='Cancelled')
  )
);
ALTER TABLE rms_reporting.backfill_request ADD CONSTRAINT backfill_request_current_version_fk
  FOREIGN KEY (current_version_id,request_id,tenant_id,brand_id)
  REFERENCES rms_reporting.backfill_request_version(request_version_id,request_id,tenant_id,brand_id);

CREATE TABLE rms_reporting.pipeline_run (
  run_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  pipeline_reference platform_helpers.uuid_v7 NOT NULL,
  pipeline_version_reference platform_helpers.uuid_v7 NOT NULL,
  transformation_version_reference platform_helpers.uuid_v7 NOT NULL,
  input_checkpoint_reference platform_helpers.uuid_v7 NOT NULL,
  output_dataset_version_reference platform_helpers.uuid_v7 NOT NULL,
  output_partition_code text NOT NULL CHECK (output_partition_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  environment_code text NOT NULL CHECK (environment_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  logical_batch_digest text NOT NULL CHECK (logical_batch_digest ~ '^sha256:[0-9a-f]{64}$'),
  execution_kind text NOT NULL CHECK (execution_kind IN ('Load','Retry','PipelineCorrection','Backfill','Rebuild')),
  replay boolean NOT NULL,
  retry_of_run_id platform_helpers.uuid_v7,
  backfill_request_version_id platform_helpers.uuid_v7,
  correction_reason_code text CHECK (correction_reason_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  correction_code_version_reference platform_helpers.uuid_v7,
  pre_reconciliation_run_id platform_helpers.uuid_v7,
  queued_at timestamp with time zone NOT NULL,
  requested_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  CONSTRAINT pipeline_run_scope_identity_unique UNIQUE (run_id,tenant_id,brand_id),
  CONSTRAINT pipeline_run_retry_fk FOREIGN KEY (retry_of_run_id,tenant_id,brand_id) REFERENCES rms_reporting.pipeline_run(run_id,tenant_id,brand_id),
  CONSTRAINT pipeline_run_backfill_fk FOREIGN KEY (backfill_request_version_id) REFERENCES rms_reporting.backfill_request_version(request_version_id),
  CONSTRAINT pipeline_run_pre_reconciliation_fk FOREIGN KEY (pre_reconciliation_run_id,tenant_id,brand_id) REFERENCES rms_reporting.reconciliation_run(run_id,tenant_id,brand_id),
  CONSTRAINT pipeline_run_replay_alignment_check CHECK ((execution_kind='Load') <> replay),
  CONSTRAINT pipeline_run_retry_alignment_check CHECK ((execution_kind='Retry') = (retry_of_run_id IS NOT NULL)),
  CONSTRAINT pipeline_run_backfill_alignment_check CHECK ((backfill_request_version_id IS NULL) = (pre_reconciliation_run_id IS NULL)),
  CONSTRAINT pipeline_run_correction_alignment_check CHECK ((correction_reason_code IS NULL) = (correction_code_version_reference IS NULL)),
  CONSTRAINT pipeline_run_intent_alignment_check CHECK (
    (execution_kind IN ('Backfill','Rebuild') AND backfill_request_version_id IS NOT NULL) OR
    (execution_kind='PipelineCorrection' AND correction_reason_code IS NOT NULL AND backfill_request_version_id IS NULL) OR
    execution_kind='Retry' OR
    (execution_kind='Load' AND backfill_request_version_id IS NULL AND correction_reason_code IS NULL)
  )
);
CREATE UNIQUE INDEX pipeline_run_original_logical_batch_unique
  ON rms_reporting.pipeline_run(tenant_id,brand_id,logical_batch_digest)
  WHERE execution_kind <> 'Retry';

ALTER TABLE rms_reporting.backfill_request_version ADD CONSTRAINT backfill_request_bound_run_fk
  FOREIGN KEY (bound_run_id,tenant_id,brand_id)
  REFERENCES rms_reporting.pipeline_run(run_id,tenant_id,brand_id);

CREATE TABLE rms_reporting.pipeline_run_state (
  state_id platform_helpers.uuid_v7 PRIMARY KEY,
  run_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  sequence integer NOT NULL CHECK (sequence > 0),
  status text NOT NULL CHECK (status IN ('Queued','Running','Succeeded','SucceededWithWarning','Failed','Cancelled')),
  watermark_occurred_at timestamp with time zone,
  records_read numeric(30,0),
  records_written numeric(30,0),
  records_late numeric(30,0),
  records_rejected numeric(30,0),
  data_quality_result_id platform_helpers.uuid_v7,
  post_reconciliation_run_id platform_helpers.uuid_v7,
  error_reference platform_helpers.uuid_v7,
  occurred_at timestamp with time zone NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  CONSTRAINT pipeline_run_state_run_fk FOREIGN KEY (run_id,tenant_id,brand_id) REFERENCES rms_reporting.pipeline_run(run_id,tenant_id,brand_id),
  CONSTRAINT pipeline_run_state_quality_fk FOREIGN KEY (data_quality_result_id,tenant_id,brand_id) REFERENCES rms_reporting.data_quality_result(result_id,tenant_id,brand_id),
  CONSTRAINT pipeline_run_state_reconciliation_fk FOREIGN KEY (post_reconciliation_run_id,tenant_id,brand_id) REFERENCES rms_reporting.reconciliation_run(run_id,tenant_id,brand_id),
  CONSTRAINT pipeline_run_state_sequence_unique UNIQUE (run_id,sequence),
  CONSTRAINT pipeline_run_state_count_check CHECK (
    records_read >= 0 AND records_written >= 0 AND records_late >= 0 AND records_rejected >= 0 AND
    records_late <= records_read AND records_rejected <= records_read
  ),
  CONSTRAINT pipeline_run_state_watermark_check CHECK (watermark_occurred_at IS NULL OR watermark_occurred_at <= occurred_at),
  CONSTRAINT pipeline_run_state_terminal_alignment_check CHECK (
    (status IN ('Succeeded','SucceededWithWarning','Failed','Cancelled')) =
      (records_read IS NOT NULL AND records_written IS NOT NULL AND records_late IS NOT NULL AND records_rejected IS NOT NULL) AND
    (status IN ('Succeeded','SucceededWithWarning')) = (data_quality_result_id IS NOT NULL) AND
    (status='Failed') = (error_reference IS NOT NULL) AND
    (status='Queued' AND watermark_occurred_at IS NULL OR status<>'Queued')
  )
);

CREATE TABLE rms_reporting.pipeline_operation_record (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  action text NOT NULL CHECK (action IN ('CreateRun','AdvanceRun','RequestBackfill','ApproveBackfill','RejectBackfill','BindBackfill','CompleteBackfill','FailBackfill','CancelBackfill')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  result_reference platform_helpers.uuid_v7 NOT NULL,
  outbox_event_id platform_helpers.uuid_v7 UNIQUE,
  event_type text CHECK (event_type IN ('AnalyticsLoadCompleted','AnalyticsLoadFailed','AnalyticsBackfillCompleted')),
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  occurred_at timestamp with time zone NOT NULL,
  CONSTRAINT pipeline_operation_event_alignment_check CHECK (
    (outbox_event_id IS NULL) = (event_type IS NULL) AND
    (event_type IS NULL OR action='AdvanceRun')
  )
);

CREATE RULE backfill_request_version_no_update AS ON UPDATE TO rms_reporting.backfill_request_version DO INSTEAD NOTHING;
CREATE RULE backfill_request_version_no_delete AS ON DELETE TO rms_reporting.backfill_request_version DO INSTEAD NOTHING;
CREATE RULE pipeline_run_no_update AS ON UPDATE TO rms_reporting.pipeline_run DO INSTEAD NOTHING;
CREATE RULE pipeline_run_no_delete AS ON DELETE TO rms_reporting.pipeline_run DO INSTEAD NOTHING;
CREATE RULE pipeline_run_state_no_update AS ON UPDATE TO rms_reporting.pipeline_run_state DO INSTEAD NOTHING;
CREATE RULE pipeline_run_state_no_delete AS ON DELETE TO rms_reporting.pipeline_run_state DO INSTEAD NOTHING;
CREATE RULE pipeline_operation_no_update AS ON UPDATE TO rms_reporting.pipeline_operation_record DO INSTEAD NOTHING;
CREATE RULE pipeline_operation_no_delete AS ON DELETE TO rms_reporting.pipeline_operation_record DO INSTEAD NOTHING;

ALTER TABLE rms_reporting.backfill_request ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.backfill_request FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.backfill_request_version ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.backfill_request_version FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.pipeline_run ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.pipeline_run FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.pipeline_run_state ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.pipeline_run_state FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.pipeline_operation_record ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.pipeline_operation_record FORCE ROW LEVEL SECURITY;

CREATE POLICY backfill_request_scope_policy ON rms_reporting.backfill_request USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY backfill_request_version_scope_policy ON rms_reporting.backfill_request_version USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY pipeline_run_scope_policy ON rms_reporting.pipeline_run USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY pipeline_run_state_scope_policy ON rms_reporting.pipeline_run_state USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY pipeline_operation_scope_policy ON rms_reporting.pipeline_operation_record USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));

REVOKE ALL ON TABLE rms_reporting.backfill_request FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.backfill_request_version FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.pipeline_run FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.pipeline_run_state FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.pipeline_operation_record FROM PUBLIC;
