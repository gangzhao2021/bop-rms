-- bop-rms-migration: 1
-- owner: @rms/business-intelligence
-- schema: rms_reporting
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA rms_reporting;
REVOKE ALL ON SCHEMA rms_reporting FROM PUBLIC;

CREATE TABLE rms_reporting.report_definition (
  report_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  stable_code text NOT NULL CHECK (stable_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  current_version_id platform_helpers.uuid_v7,
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT report_definition_scope_identity_unique UNIQUE (report_id,tenant_id,brand_id),
  CONSTRAINT report_definition_scope_code_unique UNIQUE NULLS NOT DISTINCT (tenant_id,brand_id,store_id,stable_code),
  CONSTRAINT report_definition_time_order_check CHECK (updated_at >= created_at)
);

CREATE TABLE rms_reporting.report_version (
  report_version_id platform_helpers.uuid_v7 PRIMARY KEY,
  report_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  version_number integer NOT NULL CHECK (version_number > 0),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft','InReview','Published','Archived')),
  certification_status text NOT NULL CHECK (certification_status IN ('Draft','InReview','Certified')),
  report_name_code text NOT NULL CHECK (report_name_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  purpose_code text NOT NULL CHECK (purpose_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  owner_reference platform_helpers.uuid_v7 NOT NULL,
  visualization text NOT NULL CHECK (visualization IN ('Table','Bar','Line','Kpi')),
  row_limit integer NOT NULL CHECK (row_limit BETWEEN 1 AND 100000),
  default_time_range text NOT NULL CHECK (default_time_range IN ('BusinessDate','Rolling7Days','Rolling30Days','Parameter')),
  timezone text NOT NULL CHECK (timezone ~ '^[A-Za-z_+-]+/[A-Za-z0-9_+/-]+$'),
  data_freshness_seconds integer NOT NULL CHECK (data_freshness_seconds BETWEEN 1 AND 86400),
  scope_policy text NOT NULL CHECK (scope_policy IN ('Brand','Store')),
  audience text NOT NULL CHECK (audience IN ('Manager','Analyst','ReportAdmin')),
  export_csv boolean NOT NULL,
  export_json boolean NOT NULL,
  export_row_limit integer NOT NULL CHECK (export_row_limit BETWEEN 1 AND 100000),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  validation_evidence_id platform_helpers.uuid_v7,
  approval_evidence_id platform_helpers.uuid_v7,
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  CONSTRAINT report_version_root_fk FOREIGN KEY (report_id,tenant_id,brand_id) REFERENCES rms_reporting.report_definition(report_id,tenant_id,brand_id),
  CONSTRAINT report_version_scope_identity_unique UNIQUE (report_version_id,report_id,tenant_id,brand_id),
  CONSTRAINT report_version_number_unique UNIQUE (report_id,version_number),
  CONSTRAINT report_version_period_check CHECK (effective_until IS NULL OR effective_until > effective_from),
  CONSTRAINT report_version_store_alignment_check CHECK ((scope_policy='Store')=(store_id IS NOT NULL)),
  CONSTRAINT report_version_state_alignment_check CHECK (
    (lifecycle='Draft' AND certification_status='Draft') OR
    (lifecycle='InReview' AND certification_status='InReview' AND validation_evidence_id IS NOT NULL) OR
    (lifecycle='Published' AND certification_status='Certified' AND validation_evidence_id IS NOT NULL AND approval_evidence_id IS NOT NULL) OR
    (lifecycle='Archived' AND certification_status IN ('Draft','Certified'))
  )
);
ALTER TABLE rms_reporting.report_definition ADD CONSTRAINT report_definition_current_version_fk
  FOREIGN KEY (current_version_id,report_id,tenant_id,brand_id)
  REFERENCES rms_reporting.report_version(report_version_id,report_id,tenant_id,brand_id);

CREATE TABLE rms_reporting.report_dataset_reference (
  report_version_id platform_helpers.uuid_v7 NOT NULL,
  report_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  dataset_version_reference platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (report_version_id,dataset_version_reference),
  CONSTRAINT report_dataset_version_fk FOREIGN KEY (report_version_id,report_id,tenant_id,brand_id) REFERENCES rms_reporting.report_version(report_version_id,report_id,tenant_id,brand_id)
);
CREATE TABLE rms_reporting.report_metric_reference (
  report_version_id platform_helpers.uuid_v7 NOT NULL,
  report_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  metric_version_reference platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (report_version_id,metric_version_reference),
  CONSTRAINT report_metric_version_fk FOREIGN KEY (report_version_id,report_id,tenant_id,brand_id) REFERENCES rms_reporting.report_version(report_version_id,report_id,tenant_id,brand_id)
);
CREATE TABLE rms_reporting.report_dimension (
  report_version_id platform_helpers.uuid_v7 NOT NULL,
  report_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  dimension_code text NOT NULL CHECK (dimension_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  PRIMARY KEY (report_version_id,dimension_code),
  CONSTRAINT report_dimension_version_fk FOREIGN KEY (report_version_id,report_id,tenant_id,brand_id) REFERENCES rms_reporting.report_version(report_version_id,report_id,tenant_id,brand_id)
);
CREATE TABLE rms_reporting.report_filter (
  report_filter_id platform_helpers.uuid_v7 PRIMARY KEY,
  report_version_id platform_helpers.uuid_v7 NOT NULL,
  report_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  dimension_code text NOT NULL CHECK (dimension_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  operator text NOT NULL CHECK (operator IN ('Equal','In','Between')),
  value_codes text[] NOT NULL CHECK (cardinality(value_codes) BETWEEN 1 AND 50),
  CONSTRAINT report_filter_version_fk FOREIGN KEY (report_version_id,report_id,tenant_id,brand_id) REFERENCES rms_reporting.report_version(report_version_id,report_id,tenant_id,brand_id),
  CONSTRAINT report_filter_dimension_fk FOREIGN KEY (report_version_id,dimension_code) REFERENCES rms_reporting.report_dimension(report_version_id,dimension_code),
  CONSTRAINT report_filter_value_count_check CHECK ((operator='Equal' AND cardinality(value_codes)=1) OR (operator='Between' AND cardinality(value_codes)=2) OR operator='In'),
  CONSTRAINT report_filter_values_check CHECK (array_to_string(value_codes,',') ~ '^[A-Z0-9_.:,/-]+$')
);
CREATE TABLE rms_reporting.report_sort (
  report_sort_id platform_helpers.uuid_v7 PRIMARY KEY,
  report_version_id platform_helpers.uuid_v7 NOT NULL,
  report_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  field_code text NOT NULL CHECK (field_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  direction text NOT NULL CHECK (direction IN ('Ascending','Descending')),
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 5),
  CONSTRAINT report_sort_version_fk FOREIGN KEY (report_version_id,report_id,tenant_id,brand_id) REFERENCES rms_reporting.report_version(report_version_id,report_id,tenant_id,brand_id),
  CONSTRAINT report_sort_sequence_unique UNIQUE (report_version_id,sequence)
);

CREATE TABLE rms_reporting.report_operation_record (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  report_id platform_helpers.uuid_v7 NOT NULL,
  report_version_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  action_code text NOT NULL CHECK (action_code IN ('CreateDraft','ReplaceDraft','SubmitReview','Publish','Archive')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  result_aggregate_version integer NOT NULL CHECK (result_aggregate_version > 0),
  outbox_event_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  occurred_at timestamp with time zone NOT NULL,
  CONSTRAINT report_operation_version_fk FOREIGN KEY (report_version_id,report_id,tenant_id,brand_id) REFERENCES rms_reporting.report_version(report_version_id,report_id,tenant_id,brand_id)
);

CREATE TABLE rms_reporting.report_schedule (
  schedule_id platform_helpers.uuid_v7 PRIMARY KEY,
  report_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  current_version_id platform_helpers.uuid_v7,
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  CONSTRAINT report_schedule_scope_identity_unique UNIQUE (schedule_id,tenant_id,brand_id),
  CONSTRAINT report_schedule_report_fk FOREIGN KEY (report_id,tenant_id,brand_id) REFERENCES rms_reporting.report_definition(report_id,tenant_id,brand_id)
);
CREATE TABLE rms_reporting.report_schedule_version (
  schedule_version_id platform_helpers.uuid_v7 PRIMARY KEY,
  schedule_id platform_helpers.uuid_v7 NOT NULL,
  report_id platform_helpers.uuid_v7 NOT NULL,
  report_version_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  version_number integer NOT NULL CHECK (version_number > 0),
  status text NOT NULL CHECK (status IN ('Active','Paused','Archived')),
  cadence text NOT NULL CHECK (cadence IN ('Daily','Weekly','Monthly')),
  local_time time without time zone NOT NULL,
  timezone text NOT NULL CHECK (timezone ~ '^[A-Za-z_+-]+/[A-Za-z0-9_+/-]+$'),
  format text NOT NULL CHECK (format IN ('Csv','Json')),
  recipient_scope_reference platform_helpers.uuid_v7 NOT NULL,
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  CONSTRAINT report_schedule_version_root_fk FOREIGN KEY (schedule_id,tenant_id,brand_id) REFERENCES rms_reporting.report_schedule(schedule_id,tenant_id,brand_id),
  CONSTRAINT report_schedule_report_version_fk FOREIGN KEY (report_version_id,report_id,tenant_id,brand_id) REFERENCES rms_reporting.report_version(report_version_id,report_id,tenant_id,brand_id),
  CONSTRAINT report_schedule_version_identity_unique UNIQUE (schedule_version_id,schedule_id,tenant_id,brand_id),
  CONSTRAINT report_schedule_version_number_unique UNIQUE (schedule_id,version_number)
);
ALTER TABLE rms_reporting.report_schedule ADD CONSTRAINT report_schedule_current_version_fk
  FOREIGN KEY (current_version_id,schedule_id,tenant_id,brand_id)
  REFERENCES rms_reporting.report_schedule_version(schedule_version_id,schedule_id,tenant_id,brand_id);
CREATE TABLE rms_reporting.report_schedule_operation_record (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  schedule_id platform_helpers.uuid_v7 NOT NULL,
  schedule_version_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  outbox_event_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  occurred_at timestamp with time zone NOT NULL,
  CONSTRAINT report_schedule_operation_version_fk FOREIGN KEY (schedule_version_id,schedule_id,tenant_id,brand_id) REFERENCES rms_reporting.report_schedule_version(schedule_version_id,schedule_id,tenant_id,brand_id)
);

CREATE RULE report_version_no_update AS ON UPDATE TO rms_reporting.report_version DO INSTEAD NOTHING;
CREATE RULE report_version_no_delete AS ON DELETE TO rms_reporting.report_version DO INSTEAD NOTHING;
CREATE RULE report_dataset_no_update AS ON UPDATE TO rms_reporting.report_dataset_reference DO INSTEAD NOTHING;
CREATE RULE report_dataset_no_delete AS ON DELETE TO rms_reporting.report_dataset_reference DO INSTEAD NOTHING;
CREATE RULE report_metric_no_update AS ON UPDATE TO rms_reporting.report_metric_reference DO INSTEAD NOTHING;
CREATE RULE report_metric_no_delete AS ON DELETE TO rms_reporting.report_metric_reference DO INSTEAD NOTHING;
CREATE RULE report_dimension_no_update AS ON UPDATE TO rms_reporting.report_dimension DO INSTEAD NOTHING;
CREATE RULE report_dimension_no_delete AS ON DELETE TO rms_reporting.report_dimension DO INSTEAD NOTHING;
CREATE RULE report_filter_no_update AS ON UPDATE TO rms_reporting.report_filter DO INSTEAD NOTHING;
CREATE RULE report_filter_no_delete AS ON DELETE TO rms_reporting.report_filter DO INSTEAD NOTHING;
CREATE RULE report_sort_no_update AS ON UPDATE TO rms_reporting.report_sort DO INSTEAD NOTHING;
CREATE RULE report_sort_no_delete AS ON DELETE TO rms_reporting.report_sort DO INSTEAD NOTHING;
CREATE RULE report_operation_no_update AS ON UPDATE TO rms_reporting.report_operation_record DO INSTEAD NOTHING;
CREATE RULE report_operation_no_delete AS ON DELETE TO rms_reporting.report_operation_record DO INSTEAD NOTHING;
CREATE RULE report_schedule_version_no_update AS ON UPDATE TO rms_reporting.report_schedule_version DO INSTEAD NOTHING;
CREATE RULE report_schedule_version_no_delete AS ON DELETE TO rms_reporting.report_schedule_version DO INSTEAD NOTHING;
CREATE RULE report_schedule_operation_no_update AS ON UPDATE TO rms_reporting.report_schedule_operation_record DO INSTEAD NOTHING;
CREATE RULE report_schedule_operation_no_delete AS ON DELETE TO rms_reporting.report_schedule_operation_record DO INSTEAD NOTHING;

ALTER TABLE rms_reporting.report_definition ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.report_definition FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.report_version ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.report_version FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.report_dataset_reference ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.report_dataset_reference FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.report_metric_reference ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.report_metric_reference FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.report_dimension ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.report_dimension FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.report_filter ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.report_filter FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.report_sort ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.report_sort FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.report_operation_record ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.report_operation_record FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.report_schedule ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.report_schedule FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.report_schedule_version ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.report_schedule_version FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.report_schedule_operation_record ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.report_schedule_operation_record FORCE ROW LEVEL SECURITY;

CREATE POLICY report_definition_scope_policy ON rms_reporting.report_definition USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY report_version_scope_policy ON rms_reporting.report_version USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY report_dataset_scope_policy ON rms_reporting.report_dataset_reference USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY report_metric_scope_policy ON rms_reporting.report_metric_reference USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY report_dimension_scope_policy ON rms_reporting.report_dimension USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY report_filter_scope_policy ON rms_reporting.report_filter USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY report_sort_scope_policy ON rms_reporting.report_sort USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY report_operation_scope_policy ON rms_reporting.report_operation_record USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY report_schedule_scope_policy ON rms_reporting.report_schedule USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY report_schedule_version_scope_policy ON rms_reporting.report_schedule_version USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY report_schedule_operation_scope_policy ON rms_reporting.report_schedule_operation_record USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));

REVOKE ALL ON TABLE rms_reporting.report_definition FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.report_version FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.report_dataset_reference FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.report_metric_reference FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.report_dimension FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.report_filter FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.report_sort FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.report_operation_record FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.report_schedule FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.report_schedule_version FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.report_schedule_operation_record FROM PUBLIC;
