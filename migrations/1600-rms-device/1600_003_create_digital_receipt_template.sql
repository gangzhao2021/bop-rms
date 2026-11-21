-- bop-rms-migration: 1
-- owner: @rms/printing-device
-- schema: rms_device
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_device.digital_receipt_template_version (
  version_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  template_id platform_helpers.uuid_v7 NOT NULL,
  version_number bigint NOT NULL CHECK (version_number > 0),
  version_code text NOT NULL CHECK (version_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  operation_id platform_helpers.uuid_v7 NOT NULL,
  audit_id platform_helpers.uuid_v7 NOT NULL,
  publication_id platform_helpers.uuid_v7 NOT NULL,
  publication_digest text NOT NULL CHECK (publication_digest ~ '^sha256:[0-9a-f]{64}$'),
  published_at timestamp with time zone NOT NULL,
  version_json jsonb NOT NULL CHECK (jsonb_typeof(version_json) = 'object'),
  data_classification text NOT NULL CHECK (data_classification = 'Confidential'),
  CONSTRAINT digital_receipt_template_version_pkey PRIMARY KEY (brand_id, store_id, version_id),
  CONSTRAINT digital_receipt_template_number_unique UNIQUE (brand_id, store_id, template_id, version_number),
  CONSTRAINT digital_receipt_template_code_unique UNIQUE (brand_id, store_id, template_id, version_code),
  CONSTRAINT digital_receipt_template_operation_unique UNIQUE (brand_id, store_id, operation_id),
  CONSTRAINT digital_receipt_template_audit_unique UNIQUE (brand_id, store_id, audit_id)
);
CREATE TRIGGER digital_receipt_template_no_update_trigger
  BEFORE UPDATE ON rms_device.digital_receipt_template_version
  FOR EACH ROW EXECUTE FUNCTION rms_device.reject_device_history_update();
CREATE RULE digital_receipt_template_no_delete AS ON DELETE TO rms_device.digital_receipt_template_version DO INSTEAD NOTHING;
ALTER TABLE rms_device.digital_receipt_template_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_device.digital_receipt_template_version FORCE ROW LEVEL SECURITY;
CREATE POLICY digital_receipt_template_scope_policy ON rms_device.digital_receipt_template_version
  USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
  WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_device.digital_receipt_template_version FROM PUBLIC;
