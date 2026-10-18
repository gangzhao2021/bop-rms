-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Lifecycle transitions retain configurationVersion. Store every transition as
-- a separate immutable operation; publish final snapshots to the existing tables.
CREATE TABLE rms_store.store_configuration_authoring_operation (
  operation_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  sequence_number bigint NOT NULL CHECK (sequence_number > 0),
  configuration_id platform_helpers.uuid_v7 NOT NULL,
  configuration_version bigint NOT NULL CHECK (configuration_version > 0),
  command_type text NOT NULL CHECK (command_type IN ('SaveDraft','Validate','Submit','Approve','Publish')),
  lifecycle text NOT NULL CHECK (lifecycle IN ('Draft','PendingApproval','Approved','Published')),
  expected_version bigint NOT NULL CHECK (expected_version >= 0),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  configuration_json jsonb NOT NULL CHECK (jsonb_typeof(configuration_json) = 'object'),
  actor_reference platform_helpers.uuid_v7 NOT NULL,
  purpose_code text NOT NULL CHECK (purpose_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  audit_reference platform_helpers.uuid_v7 NOT NULL,
  occurred_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification = 'ConfigurationMetadata'),
  CONSTRAINT store_authoring_operation_pkey PRIMARY KEY (brand_id,store_id,operation_id),
  CONSTRAINT store_authoring_sequence_unique UNIQUE (brand_id,store_id,sequence_number),
  CONSTRAINT store_authoring_audit_unique UNIQUE (brand_id,store_id,audit_reference),
  CONSTRAINT store_authoring_command_state CHECK (
    (command_type IN ('SaveDraft','Validate') AND lifecycle='Draft')
    OR (command_type='Submit' AND lifecycle='PendingApproval')
    OR (command_type='Approve' AND lifecycle='Approved')
    OR (command_type='Publish' AND lifecycle='Published')
  ),
  CONSTRAINT store_authoring_expected_version CHECK (
    expected_version = configuration_version - CASE WHEN command_type='SaveDraft' THEN 1 ELSE 0 END
  ),
  CONSTRAINT store_authoring_content_binding CHECK (
    configuration_json @> jsonb_build_object(
      'configurationReference',configuration_id::text,
      'brandReference',brand_id::text,
      'storeReference',store_id::text,
      'configurationVersion',configuration_version,
      'lifecycle',lifecycle
    )
  )
);
CREATE TRIGGER store_authoring_no_update BEFORE UPDATE ON rms_store.store_configuration_authoring_operation
  FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_configuration_history_update();
CREATE RULE store_authoring_no_delete AS ON DELETE TO rms_store.store_configuration_authoring_operation DO INSTEAD NOTHING;
ALTER TABLE rms_store.store_configuration_authoring_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_configuration_authoring_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY store_authoring_scope ON rms_store.store_configuration_authoring_operation
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_store.store_configuration_authoring_operation FROM PUBLIC;
