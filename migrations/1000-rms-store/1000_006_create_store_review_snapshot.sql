-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Planned publication content is not approval, release or Live Gate authority.
CREATE TABLE rms_store.store_configuration_review_snapshot (
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  lifecycle_id platform_helpers.uuid_v7 NOT NULL,
  configuration_id platform_helpers.uuid_v7 NOT NULL,
  approval_evidence_reference platform_helpers.uuid_v7 NOT NULL,
  publishing_family_reference platform_helpers.uuid_v7 NOT NULL,
  configuration_type text NOT NULL CHECK (configuration_type ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  purpose_code text NOT NULL CHECK (purpose_code ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'),
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  configuration_json jsonb NOT NULL CHECK (jsonb_typeof(configuration_json) = 'object'),
  actor_reference platform_helpers.uuid_v7 NOT NULL,
  audit_reference platform_helpers.uuid_v7 NOT NULL,
  recorded_at timestamp with time zone NOT NULL,
  data_classification text NOT NULL CHECK (data_classification='ConfigurationMetadata'),
  PRIMARY KEY (brand_id,store_id,lifecycle_id),
  UNIQUE (brand_id,store_id,approval_evidence_reference),
  UNIQUE (brand_id,store_id,audit_reference),
  CHECK (configuration_json @> jsonb_build_object(
    'brandReference',brand_id::text,'storeReference',store_id::text,
    'configurationReference',configuration_id::text,
    'approvalEvidenceReference',approval_evidence_reference::text,'lifecycle','Published'))
);
CREATE TRIGGER store_review_snapshot_no_update BEFORE UPDATE ON rms_store.store_configuration_review_snapshot
  FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_configuration_history_update();
CREATE RULE store_review_snapshot_no_delete AS ON DELETE TO rms_store.store_configuration_review_snapshot DO INSTEAD NOTHING;
ALTER TABLE rms_store.store_configuration_review_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_configuration_review_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY store_review_snapshot_scope ON rms_store.store_configuration_review_snapshot
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_store.store_configuration_review_snapshot FROM PUBLIC;
