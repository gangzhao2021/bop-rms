-- bop-rms-migration: 1
-- owner: @rms/business-intelligence
-- schema: rms_reporting
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_reporting.data_quality_check (
  check_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  current_version_id platform_helpers.uuid_v7,
  lifecycle text NOT NULL CHECK (lifecycle IN ('Active','Archived')),
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT data_quality_check_scope_identity_unique UNIQUE (check_id,tenant_id,brand_id),
  CONSTRAINT data_quality_check_time_order_check CHECK (updated_at >= created_at)
);

CREATE TABLE rms_reporting.data_quality_check_version (
  check_version_id platform_helpers.uuid_v7 PRIMARY KEY,
  check_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  version_number integer NOT NULL CHECK (version_number > 0),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Active','Archived')),
  check_kind text NOT NULL CHECK (check_kind IN ('Completeness','Uniqueness','ReferentialIntegrity','ValidRange','Timeliness','Reconciliation','SchemaCompatibility','CurrencyTimezoneConsistency')),
  dataset_version_reference platform_helpers.uuid_v7 NOT NULL,
  partition_code text NOT NULL CHECK (partition_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  rule_code text NOT NULL CHECK (rule_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  expectation_code text NOT NULL CHECK (expectation_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  default_severity text NOT NULL CHECK (default_severity IN ('Info','Warning','Error','Critical')),
  owner_id platform_helpers.uuid_v7 NOT NULL,
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  CONSTRAINT data_quality_check_version_root_fk FOREIGN KEY (check_id,tenant_id,brand_id) REFERENCES rms_reporting.data_quality_check(check_id,tenant_id,brand_id),
  CONSTRAINT data_quality_check_version_identity_unique UNIQUE (check_version_id,check_id,tenant_id,brand_id),
  CONSTRAINT data_quality_check_version_number_unique UNIQUE (check_id,version_number),
  CONSTRAINT data_quality_check_version_effective_check CHECK (effective_until IS NULL OR effective_until > effective_from)
);
ALTER TABLE rms_reporting.data_quality_check ADD CONSTRAINT data_quality_check_current_version_fk
  FOREIGN KEY (current_version_id,check_id,tenant_id,brand_id)
  REFERENCES rms_reporting.data_quality_check_version(check_version_id,check_id,tenant_id,brand_id);

CREATE TABLE rms_reporting.data_quality_result (
  result_id platform_helpers.uuid_v7 PRIMARY KEY,
  execution_id platform_helpers.uuid_v7 NOT NULL,
  check_id platform_helpers.uuid_v7 NOT NULL,
  check_version_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  dataset_version_reference platform_helpers.uuid_v7 NOT NULL,
  partition_code text NOT NULL CHECK (partition_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  outcome text NOT NULL CHECK (outcome IN ('Pass','Fail')),
  severity text NOT NULL CHECK (severity IN ('Info','Warning','Error','Critical')),
  expected_observation_code text NOT NULL CHECK (expected_observation_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  actual_observation_code text NOT NULL CHECK (actual_observation_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  publication_disposition text NOT NULL CHECK (publication_disposition IN ('ContinueFormalReporting','BlockFormalReporting')),
  affected_from timestamp with time zone NOT NULL,
  affected_until timestamp with time zone NOT NULL,
  detected_at timestamp with time zone NOT NULL,
  CONSTRAINT data_quality_result_check_version_fk FOREIGN KEY (check_version_id,check_id,tenant_id,brand_id) REFERENCES rms_reporting.data_quality_check_version(check_version_id,check_id,tenant_id,brand_id),
  CONSTRAINT data_quality_result_scope_identity_unique UNIQUE (result_id,tenant_id,brand_id),
  CONSTRAINT data_quality_result_period_check CHECK (affected_until > affected_from),
  CONSTRAINT data_quality_result_publication_check CHECK ((publication_disposition='BlockFormalReporting') = (outcome='Fail' AND severity='Critical'))
);

CREATE TABLE rms_reporting.data_quality_issue_action (
  action_id platform_helpers.uuid_v7 PRIMARY KEY,
  result_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  sequence integer NOT NULL CHECK (sequence > 0),
  action text NOT NULL CHECK (action IN ('Acknowledge','Assign','OpenIncident','RequestBackfill','Resolve')),
  owner_id platform_helpers.uuid_v7,
  incident_reference platform_helpers.uuid_v7,
  backfill_request_reference platform_helpers.uuid_v7,
  rerun_result_id platform_helpers.uuid_v7,
  resolution_code text CHECK (resolution_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  occurred_at timestamp with time zone NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  CONSTRAINT data_quality_issue_action_result_fk FOREIGN KEY (result_id,tenant_id,brand_id) REFERENCES rms_reporting.data_quality_result(result_id,tenant_id,brand_id),
  CONSTRAINT data_quality_issue_action_rerun_fk FOREIGN KEY (rerun_result_id,tenant_id,brand_id) REFERENCES rms_reporting.data_quality_result(result_id,tenant_id,brand_id),
  CONSTRAINT data_quality_issue_action_sequence_unique UNIQUE (result_id,sequence),
  CONSTRAINT data_quality_issue_action_alignment_check CHECK (
    (action='Assign') = (owner_id IS NOT NULL) AND
    (action='OpenIncident') = (incident_reference IS NOT NULL) AND
    (action='RequestBackfill') = (backfill_request_reference IS NOT NULL) AND
    (action='Resolve') = (rerun_result_id IS NOT NULL) AND
    (action='Resolve') = (resolution_code IS NOT NULL)
  )
);

CREATE TABLE rms_reporting.reconciliation_run (
  run_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  control text NOT NULL CHECK (control IN ('OrderItemTotal','PaymentLedger','InventoryLedger','PurchaseOrderReceipt','LoyaltyLedger','OutputAttempt')),
  period_from timestamp with time zone NOT NULL,
  period_until timestamp with time zone NOT NULL,
  left_observation_reference platform_helpers.uuid_v7 NOT NULL,
  right_observation_reference platform_helpers.uuid_v7 NOT NULL,
  expected_value text NOT NULL CHECK (expected_value ~ '^-?(0|[1-9][0-9]{0,20})([.][0-9]{1,9})?$'),
  actual_value text NOT NULL CHECK (actual_value ~ '^-?(0|[1-9][0-9]{0,20})([.][0-9]{1,9})?$'),
  difference_value text NOT NULL CHECK (difference_value ~ '^-?(0|[1-9][0-9]{0,20})([.][0-9]{1,9})?$'),
  unit_code text NOT NULL CHECK (unit_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  outcome text NOT NULL CHECK (outcome IN ('Matched','Difference')),
  detected_at timestamp with time zone NOT NULL,
  CONSTRAINT reconciliation_run_scope_identity_unique UNIQUE (run_id,tenant_id,brand_id),
  CONSTRAINT reconciliation_run_period_check CHECK (period_until > period_from),
  CONSTRAINT reconciliation_run_outcome_alignment_check CHECK ((outcome='Matched') = (difference_value ~ '^-?0([.]0+)?$'))
);

CREATE TABLE rms_reporting.reconciliation_exception_state (
  state_id platform_helpers.uuid_v7 PRIMARY KEY,
  exception_id platform_helpers.uuid_v7 NOT NULL,
  run_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  sequence integer NOT NULL CHECK (sequence > 0),
  status text NOT NULL CHECK (status IN ('Open','Investigating','Resolved')),
  owner_id platform_helpers.uuid_v7,
  investigation_code text CHECK (investigation_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  resolution_code text CHECK (resolution_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  resolution_rerun_id platform_helpers.uuid_v7,
  occurred_at timestamp with time zone NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  CONSTRAINT reconciliation_exception_state_run_fk FOREIGN KEY (run_id,tenant_id,brand_id) REFERENCES rms_reporting.reconciliation_run(run_id,tenant_id,brand_id),
  CONSTRAINT reconciliation_exception_state_rerun_fk FOREIGN KEY (resolution_rerun_id,tenant_id,brand_id) REFERENCES rms_reporting.reconciliation_run(run_id,tenant_id,brand_id),
  CONSTRAINT reconciliation_exception_state_sequence_unique UNIQUE (exception_id,sequence),
  CONSTRAINT reconciliation_exception_state_alignment_check CHECK (
    (status='Open' AND investigation_code IS NULL AND resolution_code IS NULL AND resolution_rerun_id IS NULL) OR
    (status='Investigating' AND owner_id IS NOT NULL AND investigation_code IS NOT NULL AND resolution_code IS NULL AND resolution_rerun_id IS NULL) OR
    (status='Resolved' AND owner_id IS NOT NULL AND resolution_code IS NOT NULL AND resolution_rerun_id IS NOT NULL)
  )
);

CREATE TABLE rms_reporting.data_quality_operation_record (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  action text NOT NULL CHECK (action IN ('CreateCheck','ReplaceCheck','ArchiveCheck','RecordResult','ActOnIssue','RecordReconciliation','ActOnReconciliation')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  result_reference platform_helpers.uuid_v7 NOT NULL,
  outbox_event_id platform_helpers.uuid_v7 UNIQUE,
  event_type text CHECK (event_type IN ('DataQualityIssueDetected','DataQualityIssueResolved','ReconciliationDifferenceDetected')),
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  occurred_at timestamp with time zone NOT NULL,
  CONSTRAINT data_quality_operation_event_alignment_check CHECK (
    (outbox_event_id IS NULL) = (event_type IS NULL) AND
    (event_type IS NULL OR
      (event_type='DataQualityIssueDetected' AND action='RecordResult') OR
      (event_type='DataQualityIssueResolved' AND action='ActOnIssue') OR
      (event_type='ReconciliationDifferenceDetected' AND action='RecordReconciliation'))
  )
);

CREATE RULE data_quality_check_version_no_update AS ON UPDATE TO rms_reporting.data_quality_check_version DO INSTEAD NOTHING;
CREATE RULE data_quality_check_version_no_delete AS ON DELETE TO rms_reporting.data_quality_check_version DO INSTEAD NOTHING;
CREATE RULE data_quality_result_no_update AS ON UPDATE TO rms_reporting.data_quality_result DO INSTEAD NOTHING;
CREATE RULE data_quality_result_no_delete AS ON DELETE TO rms_reporting.data_quality_result DO INSTEAD NOTHING;
CREATE RULE data_quality_issue_action_no_update AS ON UPDATE TO rms_reporting.data_quality_issue_action DO INSTEAD NOTHING;
CREATE RULE data_quality_issue_action_no_delete AS ON DELETE TO rms_reporting.data_quality_issue_action DO INSTEAD NOTHING;
CREATE RULE reconciliation_run_no_update AS ON UPDATE TO rms_reporting.reconciliation_run DO INSTEAD NOTHING;
CREATE RULE reconciliation_run_no_delete AS ON DELETE TO rms_reporting.reconciliation_run DO INSTEAD NOTHING;
CREATE RULE reconciliation_exception_state_no_update AS ON UPDATE TO rms_reporting.reconciliation_exception_state DO INSTEAD NOTHING;
CREATE RULE reconciliation_exception_state_no_delete AS ON DELETE TO rms_reporting.reconciliation_exception_state DO INSTEAD NOTHING;
CREATE RULE data_quality_operation_no_update AS ON UPDATE TO rms_reporting.data_quality_operation_record DO INSTEAD NOTHING;
CREATE RULE data_quality_operation_no_delete AS ON DELETE TO rms_reporting.data_quality_operation_record DO INSTEAD NOTHING;

ALTER TABLE rms_reporting.data_quality_check ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.data_quality_check FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.data_quality_check_version ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.data_quality_check_version FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.data_quality_result ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.data_quality_result FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.data_quality_issue_action ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.data_quality_issue_action FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.reconciliation_run ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.reconciliation_run FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.reconciliation_exception_state ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.reconciliation_exception_state FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.data_quality_operation_record ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.data_quality_operation_record FORCE ROW LEVEL SECURITY;

CREATE POLICY data_quality_check_scope_policy ON rms_reporting.data_quality_check USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY data_quality_check_version_scope_policy ON rms_reporting.data_quality_check_version USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY data_quality_result_scope_policy ON rms_reporting.data_quality_result USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY data_quality_issue_action_scope_policy ON rms_reporting.data_quality_issue_action USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY reconciliation_run_scope_policy ON rms_reporting.reconciliation_run USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY reconciliation_exception_state_scope_policy ON rms_reporting.reconciliation_exception_state USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY data_quality_operation_scope_policy ON rms_reporting.data_quality_operation_record USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));

REVOKE ALL ON TABLE rms_reporting.data_quality_check FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.data_quality_check_version FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.data_quality_result FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.data_quality_issue_action FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.reconciliation_run FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.reconciliation_exception_state FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.data_quality_operation_record FROM PUBLIC;
