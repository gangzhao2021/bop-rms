-- bop-rms-migration: 1
-- owner: @rms/printing-device
-- schema: rms_device
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_device.digital_receipt_template_submission (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  template_id platform_helpers.uuid_v7 NOT NULL,
  family_id platform_helpers.uuid_v7 NOT NULL,
  version_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  draft_revision bigint NOT NULL CHECK (draft_revision BETWEEN 1 AND 2147483647),
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  authored_by_id platform_helpers.uuid_v7 NOT NULL,
  submitted_by_id platform_helpers.uuid_v7 NOT NULL,
  operation_id platform_helpers.uuid_v7 NOT NULL PRIMARY KEY,
  review_lifecycle_id platform_helpers.uuid_v7 NOT NULL,
  review_version bigint NOT NULL CHECK (review_version BETWEEN 2 AND 2147483647),
  validation_evidence_id platform_helpers.uuid_v7 NOT NULL,
  checked_at timestamptz NOT NULL CHECK (isfinite(checked_at) AND checked_at=date_trunc('milliseconds',checked_at)),
  validation_valid_until timestamptz NOT NULL CHECK (isfinite(validation_valid_until) AND validation_valid_until=date_trunc('milliseconds',validation_valid_until)),
  submitted_at timestamptz NOT NULL CHECK (isfinite(submitted_at) AND submitted_at=date_trunc('milliseconds',submitted_at)),
  audit_reference platform_helpers.uuid_v7 NOT NULL,
  data_classification text NOT NULL CHECK (data_classification='Internal'),
  record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=16384),
  record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT digital_receipt_template_submission_window CHECK (checked_at<=submitted_at AND submitted_at<validation_valid_until),
  CONSTRAINT digital_receipt_template_submission_draft_fk FOREIGN KEY (tenant_id,brand_id,store_id,template_id,version_id)
    REFERENCES rms_device.digital_receipt_template_draft_revision (tenant_id,brand_id,store_id,template_id,version_id)
);
CREATE FUNCTION rms_device.digital_receipt_template_submission_insert_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE draft rms_device.digital_receipt_template_draft_revision%ROWTYPE;
  head rms_device.digital_receipt_template_draft_revision%ROWTYPE;
BEGIN
  IF TG_TABLE_SCHEMA<>'rms_device' OR TG_TABLE_NAME<>'digital_receipt_template_submission'
    OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
    OR current_setting('transaction_isolation')<>'read committed'
    OR (NEW.tenant_id::text=current_setting('bop.tenant_id',true)
      AND NEW.brand_id=platform_helpers.current_brand_id()
      AND NEW.store_id=platform_helpers.current_store_id()) IS NOT TRUE THEN
    RAISE EXCEPTION 'RECEIPT_TEMPLATE_SUBMISSION_SCOPE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ReceiptTemplate:'||NEW.brand_id::text||':'||NEW.store_id::text||':'||NEW.template_id::text,0));
  IF jsonb_typeof(NEW.record_json) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'RECEIPT_TEMPLATE_SUBMISSION_RECORD_INVALID' USING ERRCODE='23514';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(NEW.record_json))<>20
    OR NEW.record_json->>'profile' IS DISTINCT FROM 'DigitalReceiptTemplateSubmissionV1'
    OR NEW.record_json->'tenantReference' IS DISTINCT FROM to_jsonb(NEW.tenant_id::text)
    OR NEW.record_json->'brandReference' IS DISTINCT FROM to_jsonb(NEW.brand_id::text)
    OR NEW.record_json->'storeReference' IS DISTINCT FROM to_jsonb(NEW.store_id::text)
    OR NEW.record_json->'templateReference' IS DISTINCT FROM to_jsonb(NEW.template_id::text)
    OR NEW.record_json->'familyReference' IS DISTINCT FROM to_jsonb(NEW.family_id::text)
    OR NEW.record_json->'versionReference' IS DISTINCT FROM to_jsonb(NEW.version_id::text)
    OR NEW.record_json->'draftRevision' IS DISTINCT FROM to_jsonb(NEW.draft_revision)
    OR NEW.record_json->'contentDigest' IS DISTINCT FROM to_jsonb(NEW.content_digest::text)
    OR NEW.record_json->'authoredByReference' IS DISTINCT FROM to_jsonb(NEW.authored_by_id::text)
    OR NEW.record_json->'submittedByReference' IS DISTINCT FROM to_jsonb(NEW.submitted_by_id::text)
    OR NEW.record_json->'operationReference' IS DISTINCT FROM to_jsonb(NEW.operation_id::text)
    OR NEW.record_json->'reviewLifecycleReference' IS DISTINCT FROM to_jsonb(NEW.review_lifecycle_id::text)
    OR NEW.record_json->'reviewVersion' IS DISTINCT FROM to_jsonb(NEW.review_version)
    OR NEW.record_json->'validationEvidenceReference' IS DISTINCT FROM to_jsonb(NEW.validation_evidence_id::text)
    OR NEW.record_json->'checkedAt' IS DISTINCT FROM to_jsonb(to_char(NEW.checked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    OR NEW.record_json->'validationValidUntil' IS DISTINCT FROM to_jsonb(to_char(NEW.validation_valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    OR NEW.record_json->'submittedAt' IS DISTINCT FROM to_jsonb(to_char(NEW.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    OR NEW.record_json->'auditReference' IS DISTINCT FROM to_jsonb(NEW.audit_reference::text)
    OR NEW.record_json->'dataClassification' IS DISTINCT FROM to_jsonb(NEW.data_classification::text)
  THEN
    RAISE EXCEPTION 'RECEIPT_TEMPLATE_SUBMISSION_RECORD_INVALID' USING ERRCODE='23514';
  END IF;
  SELECT * INTO draft FROM rms_device.digital_receipt_template_draft_revision
    WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id
      AND template_id=NEW.template_id AND version_id=NEW.version_id;
  SELECT * INTO head FROM rms_device.digital_receipt_template_draft_revision
    WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND template_id=NEW.template_id
    ORDER BY revision DESC LIMIT 1;
  IF draft.version_id IS NULL OR head.version_id IS DISTINCT FROM NEW.version_id
    OR (draft.family_id,draft.revision,draft.content_digest,draft.actor_id)
      IS DISTINCT FROM (NEW.family_id,NEW.draft_revision,NEW.content_digest,NEW.authored_by_id)
    OR draft.updated_at>NEW.submitted_at THEN
    RAISE EXCEPTION 'RECEIPT_TEMPLATE_SUBMISSION_DRAFT_INCOHERENT' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_device.digital_receipt_template_submission_insert_guard() FROM PUBLIC;
CREATE TRIGGER digital_receipt_template_submission_insert BEFORE INSERT ON rms_device.digital_receipt_template_submission
  FOR EACH ROW EXECUTE FUNCTION rms_device.digital_receipt_template_submission_insert_guard();
CREATE FUNCTION rms_device.reject_receipt_template_submission_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'RECEIPT_TEMPLATE_SUBMISSION_IMMUTABLE' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_device.reject_receipt_template_submission_mutation() FROM PUBLIC;
CREATE TRIGGER digital_receipt_template_submission_no_mutation BEFORE UPDATE OR DELETE ON rms_device.digital_receipt_template_submission
  FOR EACH ROW EXECUTE FUNCTION rms_device.reject_receipt_template_submission_mutation();
CREATE TRIGGER digital_receipt_template_submission_no_truncate BEFORE TRUNCATE ON rms_device.digital_receipt_template_submission
  FOR EACH STATEMENT EXECUTE FUNCTION rms_device.reject_receipt_template_submission_mutation();
ALTER TABLE rms_device.digital_receipt_template_submission ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_device.digital_receipt_template_submission FORCE ROW LEVEL SECURITY;
CREATE POLICY digital_receipt_template_submission_scope ON rms_device.digital_receipt_template_submission
  USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE)
  WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_device.digital_receipt_template_submission FROM PUBLIC;
