-- bop-rms-migration: 1
-- owner: @bop/feature-control
-- schema: bop_feature_control
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA bop_feature_control;
REVOKE ALL ON SCHEMA bop_feature_control FROM PUBLIC;

CREATE FUNCTION bop_feature_control.reject_feature_control_history_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Feature Control history is append-only' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION bop_feature_control.reject_feature_control_history_update() FROM PUBLIC;

CREATE TABLE bop_feature_control.control_version (
  control_id platform_helpers.uuid_v7 NOT NULL, brand_id platform_helpers.uuid_v7 NOT NULL, store_id platform_helpers.uuid_v7,
  control_key text NOT NULL CHECK (control_key ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){2,7}$'), control_version bigint NOT NULL CHECK (control_version > 0),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 240), owner_reference platform_helpers.uuid_v7 NOT NULL,
  purpose_code text NOT NULL CHECK (purpose_code ~ '^[A-Z][A-Z0-9_]{0,63}$'), source text NOT NULL CHECK (source IN ('BrandOverride','StoreOverride')),
  default_value text NOT NULL CHECK (default_value IN ('Enabled','Disabled')), configured_value text NOT NULL CHECK (configured_value IN ('Enabled','Disabled')),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft','PendingApproval','Approved','Published','Superseded','Disabled')), temporary boolean NOT NULL,
  effective_from timestamp with time zone NOT NULL, effective_until timestamp with time zone, review_at timestamp with time zone NOT NULL, expires_at timestamp with time zone,
  authored_by_reference platform_helpers.uuid_v7 NOT NULL, approved_by_reference platform_helpers.uuid_v7, approval_evidence_reference platform_helpers.uuid_v7, publication_reference platform_helpers.uuid_v7,
  created_at timestamp with time zone NOT NULL, data_classification text NOT NULL CHECK (data_classification = 'ConfigurationMetadata'),
  CONSTRAINT feature_control_version_pkey PRIMARY KEY (brand_id,control_id,control_version),
  CONSTRAINT feature_control_scope_source CHECK ((store_id IS NULL AND source='BrandOverride') OR (store_id IS NOT NULL AND source='StoreOverride')),
  CONSTRAINT feature_control_period CHECK (effective_until IS NULL OR effective_until > effective_from),
  CONSTRAINT feature_control_review CHECK (review_at >= effective_from AND (expires_at IS NULL OR (expires_at > effective_from AND review_at <= expires_at)) AND temporary=(expires_at IS NOT NULL)),
  CONSTRAINT feature_control_approval CHECK ((approved_by_reference IS NULL)=(approval_evidence_reference IS NULL) AND (approved_by_reference IS NULL OR approved_by_reference<>authored_by_reference) AND ((lifecycle IN ('Draft','PendingApproval'))=(approved_by_reference IS NULL)) AND ((lifecycle IN ('Published','Superseded','Disabled'))=(publication_reference IS NOT NULL)))
);
CREATE UNIQUE INDEX feature_control_scope_key_version_unique ON bop_feature_control.control_version (brand_id,COALESCE(store_id,'00000000-0000-0000-0000-000000000000'::uuid),control_key,control_version);

CREATE TABLE bop_feature_control.control_dependency (
  dependency_id platform_helpers.uuid_v7 NOT NULL, brand_id platform_helpers.uuid_v7 NOT NULL, store_id platform_helpers.uuid_v7,
  control_id platform_helpers.uuid_v7 NOT NULL, control_version bigint NOT NULL, dependency_kind text NOT NULL CHECK (dependency_kind IN ('RequiresCapability','ConflictsWithCapability','RequiresFutureTrigger')),
  target_key text NOT NULL CHECK (target_key ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){2,7}$'), minimum_compatible_version bigint NOT NULL CHECK (minimum_compatible_version > 0),
  dependency_status text NOT NULL CHECK (dependency_status IN ('Satisfied','Unsatisfied','NotApplicable')), evidence_reference platform_helpers.uuid_v7, evidence_version bigint CHECK (evidence_version > 0),
  data_classification text NOT NULL CHECK (data_classification = 'ConfigurationMetadata'),
  CONSTRAINT feature_control_dependency_pkey PRIMARY KEY (brand_id,dependency_id),
  CONSTRAINT feature_control_dependency_control_fkey FOREIGN KEY (brand_id,control_id,control_version) REFERENCES bop_feature_control.control_version (brand_id,control_id,control_version),
  CONSTRAINT feature_control_dependency_evidence CHECK ((evidence_reference IS NULL)=(evidence_version IS NULL) AND ((dependency_status='Satisfied')=(evidence_reference IS NOT NULL)))
);
CREATE TABLE bop_feature_control.control_operation (
  operation_id platform_helpers.uuid_v7 NOT NULL, brand_id platform_helpers.uuid_v7 NOT NULL, store_id platform_helpers.uuid_v7,
  control_id platform_helpers.uuid_v7 NOT NULL, command_type text NOT NULL CHECK (command_type IN ('SaveDraft','Submit','Approve','Publish','Schedule','Disable')),
  expected_version bigint NOT NULL CHECK (expected_version >= 0), resulting_version bigint NOT NULL CHECK (resulting_version > 0), intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  actor_reference platform_helpers.uuid_v7 NOT NULL, purpose_code text NOT NULL CHECK (purpose_code ~ '^[A-Z][A-Z0-9_]{0,63}$'), audit_reference platform_helpers.uuid_v7 NOT NULL,
  occurred_at timestamp with time zone NOT NULL, data_classification text NOT NULL CHECK (data_classification='ConfigurationMetadata'),
  CONSTRAINT feature_control_operation_pkey PRIMARY KEY (brand_id,operation_id)
);
CREATE TRIGGER feature_control_version_no_update BEFORE UPDATE ON bop_feature_control.control_version FOR EACH ROW EXECUTE FUNCTION bop_feature_control.reject_feature_control_history_update();
CREATE RULE feature_control_version_no_delete AS ON DELETE TO bop_feature_control.control_version DO INSTEAD NOTHING;
CREATE TRIGGER feature_control_dependency_no_update BEFORE UPDATE ON bop_feature_control.control_dependency FOR EACH ROW EXECUTE FUNCTION bop_feature_control.reject_feature_control_history_update();
CREATE RULE feature_control_dependency_no_delete AS ON DELETE TO bop_feature_control.control_dependency DO INSTEAD NOTHING;
CREATE TRIGGER feature_control_operation_no_update BEFORE UPDATE ON bop_feature_control.control_operation FOR EACH ROW EXECUTE FUNCTION bop_feature_control.reject_feature_control_history_update();
CREATE RULE feature_control_operation_no_delete AS ON DELETE TO bop_feature_control.control_operation DO INSTEAD NOTHING;
ALTER TABLE bop_feature_control.control_version ENABLE ROW LEVEL SECURITY; ALTER TABLE bop_feature_control.control_version FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_feature_control.control_dependency ENABLE ROW LEVEL SECURITY; ALTER TABLE bop_feature_control.control_dependency FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_feature_control.control_operation ENABLE ROW LEVEL SECURITY; ALTER TABLE bop_feature_control.control_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY feature_control_version_scope ON bop_feature_control.control_version USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY feature_control_dependency_scope ON bop_feature_control.control_dependency USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
CREATE POLICY feature_control_operation_scope ON bop_feature_control.control_operation USING (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id())) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND (store_id IS NULL OR store_id=platform_helpers.current_store_id()));
REVOKE ALL ON TABLE bop_feature_control.control_version, bop_feature_control.control_dependency, bop_feature_control.control_operation FROM PUBLIC;
