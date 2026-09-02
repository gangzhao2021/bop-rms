-- bop-rms-migration: 1
-- owner: @rms/business-intelligence
-- schema: rms_reporting
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_reporting.metric_definition (
  metric_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  stable_code text NOT NULL CHECK (stable_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  owner_domain_code text NOT NULL CHECK (owner_domain_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  business_owner_id platform_helpers.uuid_v7 NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  current_version_id platform_helpers.uuid_v7,
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft','InReview','Certified','Deprecated','Archived')),
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT metric_definition_scope_identity_unique UNIQUE (metric_id,tenant_id,brand_id),
  CONSTRAINT metric_definition_code_unique UNIQUE NULLS NOT DISTINCT (tenant_id,brand_id,store_id,stable_code),
  CONSTRAINT metric_definition_time_order_check CHECK (updated_at >= created_at)
);

CREATE TABLE rms_reporting.metric_version (
  metric_version_id platform_helpers.uuid_v7 PRIMARY KEY,
  metric_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  version_number integer NOT NULL CHECK (version_number > 0),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft','InReview','Certified','Deprecated','Archived')),
  certification_status text NOT NULL CHECK (certification_status IN ('Draft','InReview','Certified','Deprecated')),
  display_name_code text NOT NULL CHECK (display_name_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  business_definition_code text NOT NULL CHECK (business_definition_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  formula_reference platform_helpers.uuid_v7 NOT NULL,
  base_fact_reference platform_helpers.uuid_v7 NOT NULL,
  grain_code text NOT NULL CHECK (grain_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  time_semantics text NOT NULL CHECK (time_semantics IN ('BusinessDate','OccurredAt','CompletedAt')),
  timezone text NOT NULL CHECK (timezone ~ '^[A-Za-z_+-]+/[A-Za-z0-9_+/-]+$'),
  currency_semantics text NOT NULL CHECK (currency_semantics IN ('None','OriginalCurrency','SingleCurrency','VersionedFx')),
  currency_code character(3),
  null_policy text NOT NULL CHECK (null_policy IN ('Exclude','TreatAsZero','Fail')),
  query_expression_reference platform_helpers.uuid_v7 NOT NULL,
  last_successful_build_at timestamp with time zone,
  data_freshness_seconds integer NOT NULL CHECK (data_freshness_seconds BETWEEN 1 AND 604800),
  data_quality_status text NOT NULL CHECK (data_quality_status IN ('Pending','Pass','Warning','Failed')),
  effective_from timestamp with time zone NOT NULL,
  effective_until timestamp with time zone,
  replacement_metric_id platform_helpers.uuid_v7,
  created_at timestamp with time zone NOT NULL,
  created_by_actor_id platform_helpers.uuid_v7 NOT NULL,
  CONSTRAINT metric_version_root_fk FOREIGN KEY (metric_id,tenant_id,brand_id) REFERENCES rms_reporting.metric_definition(metric_id,tenant_id,brand_id),
  CONSTRAINT metric_version_identity_unique UNIQUE (metric_version_id,metric_id,tenant_id,brand_id),
  CONSTRAINT metric_version_number_unique UNIQUE (metric_id,version_number),
  CONSTRAINT metric_version_state_alignment_check CHECK (
    (lifecycle='Draft' AND certification_status='Draft') OR
    (lifecycle='InReview' AND certification_status='InReview') OR
    (lifecycle='Certified' AND certification_status='Certified' AND last_successful_build_at IS NOT NULL AND data_quality_status='Pass') OR
    (lifecycle='Deprecated' AND certification_status='Deprecated') OR
    (lifecycle='Archived' AND certification_status <> 'InReview')
  ),
  CONSTRAINT metric_version_currency_check CHECK ((currency_semantics='SingleCurrency') = (currency_code IS NOT NULL)),
  CONSTRAINT metric_version_effective_check CHECK (effective_until IS NULL OR effective_until > effective_from),
  CONSTRAINT metric_version_replacement_check CHECK (replacement_metric_id IS NULL OR lifecycle IN ('Deprecated','Archived'))
);
ALTER TABLE rms_reporting.metric_definition ADD CONSTRAINT metric_definition_current_version_fk
  FOREIGN KEY (current_version_id,metric_id,tenant_id,brand_id)
  REFERENCES rms_reporting.metric_version(metric_version_id,metric_id,tenant_id,brand_id);

CREATE TABLE rms_reporting.metric_dimension (
  metric_version_id platform_helpers.uuid_v7 NOT NULL,
  metric_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  dimension_code text NOT NULL CHECK (dimension_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  PRIMARY KEY (metric_version_id,dimension_code),
  CONSTRAINT metric_dimension_version_fk FOREIGN KEY (metric_version_id,metric_id,tenant_id,brand_id) REFERENCES rms_reporting.metric_version(metric_version_id,metric_id,tenant_id,brand_id)
);
CREATE TABLE rms_reporting.metric_required_filter (
  metric_version_id platform_helpers.uuid_v7 NOT NULL,
  metric_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  filter_code text NOT NULL CHECK (filter_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  PRIMARY KEY (metric_version_id,filter_code),
  CONSTRAINT metric_filter_version_fk FOREIGN KEY (metric_version_id,metric_id,tenant_id,brand_id) REFERENCES rms_reporting.metric_version(metric_version_id,metric_id,tenant_id,brand_id)
);
CREATE TABLE rms_reporting.metric_inclusion_rule (
  metric_version_id platform_helpers.uuid_v7 NOT NULL,
  metric_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  rule_code text NOT NULL CHECK (rule_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  PRIMARY KEY (metric_version_id,rule_code),
  CONSTRAINT metric_inclusion_version_fk FOREIGN KEY (metric_version_id,metric_id,tenant_id,brand_id) REFERENCES rms_reporting.metric_version(metric_version_id,metric_id,tenant_id,brand_id)
);
CREATE TABLE rms_reporting.metric_exclusion_rule (
  metric_version_id platform_helpers.uuid_v7 NOT NULL,
  metric_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  rule_code text NOT NULL CHECK (rule_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  PRIMARY KEY (metric_version_id,rule_code),
  CONSTRAINT metric_exclusion_version_fk FOREIGN KEY (metric_version_id,metric_id,tenant_id,brand_id) REFERENCES rms_reporting.metric_version(metric_version_id,metric_id,tenant_id,brand_id)
);
CREATE TABLE rms_reporting.metric_dataset_reference (
  metric_version_id platform_helpers.uuid_v7 NOT NULL,
  metric_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  dataset_version_reference platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (metric_version_id,dataset_version_reference),
  CONSTRAINT metric_dataset_version_fk FOREIGN KEY (metric_version_id,metric_id,tenant_id,brand_id) REFERENCES rms_reporting.metric_version(metric_version_id,metric_id,tenant_id,brand_id)
);
CREATE TABLE rms_reporting.metric_transformation_reference (
  metric_version_id platform_helpers.uuid_v7 NOT NULL,
  metric_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  transformation_version_reference platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (metric_version_id,transformation_version_reference),
  CONSTRAINT metric_transformation_version_fk FOREIGN KEY (metric_version_id,metric_id,tenant_id,brand_id) REFERENCES rms_reporting.metric_version(metric_version_id,metric_id,tenant_id,brand_id)
);
CREATE TABLE rms_reporting.metric_dependency_reference (
  metric_version_id platform_helpers.uuid_v7 NOT NULL,
  metric_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  dependency_metric_version_reference platform_helpers.uuid_v7 NOT NULL,
  PRIMARY KEY (metric_version_id,dependency_metric_version_reference),
  CONSTRAINT metric_dependency_version_fk FOREIGN KEY (metric_version_id,metric_id,tenant_id,brand_id) REFERENCES rms_reporting.metric_version(metric_version_id,metric_id,tenant_id,brand_id)
);
CREATE TABLE rms_reporting.metric_certification_evidence (
  certification_id platform_helpers.uuid_v7 PRIMARY KEY,
  metric_version_id platform_helpers.uuid_v7 NOT NULL,
  metric_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  validation_evidence_reference platform_helpers.uuid_v7 NOT NULL,
  business_approval_evidence_reference platform_helpers.uuid_v7 NOT NULL,
  business_approver_actor_id platform_helpers.uuid_v7 NOT NULL,
  data_approval_evidence_reference platform_helpers.uuid_v7 NOT NULL,
  data_approver_actor_id platform_helpers.uuid_v7 NOT NULL,
  certified_at timestamp with time zone NOT NULL,
  CONSTRAINT metric_certification_version_fk FOREIGN KEY (metric_version_id,metric_id,tenant_id,brand_id) REFERENCES rms_reporting.metric_version(metric_version_id,metric_id,tenant_id,brand_id),
  CONSTRAINT metric_certification_role_separation CHECK (business_approval_evidence_reference <> data_approval_evidence_reference AND business_approver_actor_id <> data_approver_actor_id),
  CONSTRAINT metric_certification_once UNIQUE (metric_version_id)
);
CREATE TABLE rms_reporting.metric_operation_record (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  metric_id platform_helpers.uuid_v7 NOT NULL,
  metric_version_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7,
  action text NOT NULL CHECK (action IN ('CreateDraft','ReplaceDraft','CreateRevision','SubmitReview','Certify','Deprecate','Archive')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  primary_outbox_event_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  secondary_outbox_event_id platform_helpers.uuid_v7 UNIQUE,
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  occurred_at timestamp with time zone NOT NULL,
  CONSTRAINT metric_operation_version_fk FOREIGN KEY (metric_version_id,metric_id,tenant_id,brand_id) REFERENCES rms_reporting.metric_version(metric_version_id,metric_id,tenant_id,brand_id),
  CONSTRAINT metric_operation_event_count CHECK ((action='Certify') = (secondary_outbox_event_id IS NOT NULL))
);

CREATE RULE metric_version_no_update AS ON UPDATE TO rms_reporting.metric_version DO INSTEAD NOTHING;
CREATE RULE metric_version_no_delete AS ON DELETE TO rms_reporting.metric_version DO INSTEAD NOTHING;
CREATE RULE metric_dimension_no_update AS ON UPDATE TO rms_reporting.metric_dimension DO INSTEAD NOTHING;
CREATE RULE metric_dimension_no_delete AS ON DELETE TO rms_reporting.metric_dimension DO INSTEAD NOTHING;
CREATE RULE metric_filter_no_update AS ON UPDATE TO rms_reporting.metric_required_filter DO INSTEAD NOTHING;
CREATE RULE metric_filter_no_delete AS ON DELETE TO rms_reporting.metric_required_filter DO INSTEAD NOTHING;
CREATE RULE metric_inclusion_no_update AS ON UPDATE TO rms_reporting.metric_inclusion_rule DO INSTEAD NOTHING;
CREATE RULE metric_inclusion_no_delete AS ON DELETE TO rms_reporting.metric_inclusion_rule DO INSTEAD NOTHING;
CREATE RULE metric_exclusion_no_update AS ON UPDATE TO rms_reporting.metric_exclusion_rule DO INSTEAD NOTHING;
CREATE RULE metric_exclusion_no_delete AS ON DELETE TO rms_reporting.metric_exclusion_rule DO INSTEAD NOTHING;
CREATE RULE metric_dataset_no_update AS ON UPDATE TO rms_reporting.metric_dataset_reference DO INSTEAD NOTHING;
CREATE RULE metric_dataset_no_delete AS ON DELETE TO rms_reporting.metric_dataset_reference DO INSTEAD NOTHING;
CREATE RULE metric_transformation_no_update AS ON UPDATE TO rms_reporting.metric_transformation_reference DO INSTEAD NOTHING;
CREATE RULE metric_transformation_no_delete AS ON DELETE TO rms_reporting.metric_transformation_reference DO INSTEAD NOTHING;
CREATE RULE metric_dependency_no_update AS ON UPDATE TO rms_reporting.metric_dependency_reference DO INSTEAD NOTHING;
CREATE RULE metric_dependency_no_delete AS ON DELETE TO rms_reporting.metric_dependency_reference DO INSTEAD NOTHING;
CREATE RULE metric_certification_no_update AS ON UPDATE TO rms_reporting.metric_certification_evidence DO INSTEAD NOTHING;
CREATE RULE metric_certification_no_delete AS ON DELETE TO rms_reporting.metric_certification_evidence DO INSTEAD NOTHING;
CREATE RULE metric_operation_no_update AS ON UPDATE TO rms_reporting.metric_operation_record DO INSTEAD NOTHING;
CREATE RULE metric_operation_no_delete AS ON DELETE TO rms_reporting.metric_operation_record DO INSTEAD NOTHING;

ALTER TABLE rms_reporting.metric_definition ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.metric_definition FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.metric_version ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.metric_version FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.metric_dimension ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.metric_dimension FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.metric_required_filter ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.metric_required_filter FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.metric_inclusion_rule ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.metric_inclusion_rule FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.metric_exclusion_rule ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.metric_exclusion_rule FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.metric_dataset_reference ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.metric_dataset_reference FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.metric_transformation_reference ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.metric_transformation_reference FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.metric_dependency_reference ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.metric_dependency_reference FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.metric_certification_evidence ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.metric_certification_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_reporting.metric_operation_record ENABLE ROW LEVEL SECURITY; ALTER TABLE rms_reporting.metric_operation_record FORCE ROW LEVEL SECURITY;

CREATE POLICY metric_definition_scope_policy ON rms_reporting.metric_definition USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY metric_version_scope_policy ON rms_reporting.metric_version USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY metric_dimension_scope_policy ON rms_reporting.metric_dimension USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY metric_filter_scope_policy ON rms_reporting.metric_required_filter USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY metric_inclusion_scope_policy ON rms_reporting.metric_inclusion_rule USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY metric_exclusion_scope_policy ON rms_reporting.metric_exclusion_rule USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY metric_dataset_scope_policy ON rms_reporting.metric_dataset_reference USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY metric_transformation_scope_policy ON rms_reporting.metric_transformation_reference USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY metric_dependency_scope_policy ON rms_reporting.metric_dependency_reference USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY metric_certification_scope_policy ON rms_reporting.metric_certification_evidence USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY metric_operation_scope_policy ON rms_reporting.metric_operation_record USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));

REVOKE ALL ON TABLE rms_reporting.metric_definition FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.metric_version FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.metric_dimension FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.metric_required_filter FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.metric_inclusion_rule FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.metric_exclusion_rule FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.metric_dataset_reference FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.metric_transformation_reference FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.metric_dependency_reference FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.metric_certification_evidence FROM PUBLIC;
REVOKE ALL ON TABLE rms_reporting.metric_operation_record FROM PUBLIC;
