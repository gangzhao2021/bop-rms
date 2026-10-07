-- bop-rms-migration: 1
-- owner: @rms/printing-device
-- schema: rms_device
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_device.digital_receipt_template_submit_operation (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  template_id platform_helpers.uuid_v7 NOT NULL,
  expected_version_id platform_helpers.uuid_v7 NOT NULL,
  expected_revision bigint NOT NULL CHECK (expected_revision BETWEEN 1 AND 2147483647),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('Committed','Abandoned')),
  result_review_lifecycle_id platform_helpers.uuid_v7,
  result_review_version bigint,
  submission_digest text,
  audit_reference platform_helpers.uuid_v7 NOT NULL,
  occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
  receipt_json jsonb NOT NULL CHECK (jsonb_typeof(receipt_json)='object' AND octet_length(receipt_json::text)<=32768),
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT digital_receipt_template_submit_operation_result CHECK (
    (outcome='Abandoned' AND result_review_lifecycle_id IS NULL AND result_review_version IS NULL AND submission_digest IS NULL)
    OR (outcome='Committed' AND result_review_lifecycle_id IS NOT NULL AND result_review_version IS NOT NULL
      AND result_review_version BETWEEN 2 AND 2147483647 AND submission_digest IS NOT NULL AND submission_digest ~ '^sha256:[0-9a-f]{64}$'))
);
CREATE FUNCTION rms_device.digital_receipt_template_submit_operation_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE original rms_device.digital_receipt_template_submission%ROWTYPE;
  original_xmin xid;
BEGIN
  IF TG_TABLE_SCHEMA<>'rms_device' OR TG_TABLE_NAME<>'digital_receipt_template_submit_operation'
    OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
    OR current_setting('transaction_isolation')<>'read committed'
    OR (NEW.tenant_id::text=current_setting('bop.tenant_id',true) AND NEW.brand_id=platform_helpers.current_brand_id()
      AND NEW.store_id=platform_helpers.current_store_id()) IS NOT TRUE THEN
    RAISE EXCEPTION 'RECEIPT_TEMPLATE_SUBMIT_SCOPE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  IF jsonb_typeof(NEW.receipt_json) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'RECEIPT_TEMPLATE_SUBMIT_RECEIPT_INVALID' USING ERRCODE='23514';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(NEW.receipt_json))<>14
    OR NEW.receipt_json->>'profile' IS DISTINCT FROM 'DigitalReceiptTemplateSubmitReceiptV1'
    OR NEW.receipt_json->'tenantReference' IS DISTINCT FROM to_jsonb(NEW.tenant_id::text)
    OR NEW.receipt_json->'brandReference' IS DISTINCT FROM to_jsonb(NEW.brand_id::text)
    OR NEW.receipt_json->'storeReference' IS DISTINCT FROM to_jsonb(NEW.store_id::text)
    OR NEW.receipt_json->'actorReference' IS DISTINCT FROM to_jsonb(NEW.actor_id::text)
    OR NEW.receipt_json->'operationReference' IS DISTINCT FROM to_jsonb(NEW.operation_id::text)
    OR NEW.receipt_json->'templateReference' IS DISTINCT FROM to_jsonb(NEW.template_id::text)
    OR NEW.receipt_json->'expectedVersionReference' IS DISTINCT FROM to_jsonb(NEW.expected_version_id::text)
    OR NEW.receipt_json->'expectedRevision' IS DISTINCT FROM to_jsonb(NEW.expected_revision)
    OR NEW.receipt_json->'intentDigest' IS DISTINCT FROM to_jsonb(NEW.intent_digest::text)
    OR NEW.receipt_json->'outcome' IS DISTINCT FROM to_jsonb(NEW.outcome::text)
    OR NEW.receipt_json->'auditReference' IS DISTINCT FROM to_jsonb(NEW.audit_reference::text)
    OR NEW.receipt_json->'occurredAt' IS DISTINCT FROM to_jsonb(to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  THEN RAISE EXCEPTION 'RECEIPT_TEMPLATE_SUBMIT_RECEIPT_INVALID' USING ERRCODE='23514'; END IF;
  SELECT * INTO original FROM rms_device.digital_receipt_template_submission WHERE operation_id=NEW.operation_id;
  SELECT xmin INTO original_xmin FROM rms_device.digital_receipt_template_submission WHERE operation_id=NEW.operation_id;
  IF NEW.outcome='Abandoned' THEN
    IF original.operation_id IS NOT NULL OR NEW.receipt_json->'submission' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'RECEIPT_TEMPLATE_SUBMIT_ABANDONED_INVALID' USING ERRCODE='23514';
    END IF;
  ELSE
    IF original.operation_id IS NULL OR original_xmin IS DISTINCT FROM mod(pg_current_xact_id()::text::numeric,4294967296)::text::xid
      OR (original.tenant_id,original.brand_id,original.store_id,original.submitted_by_id,original.template_id,original.version_id,
        original.draft_revision,original.audit_reference,original.submitted_at,original.review_lifecycle_id,original.review_version,original.record_digest)
        IS DISTINCT FROM (NEW.tenant_id,NEW.brand_id,NEW.store_id,NEW.actor_id,NEW.template_id,NEW.expected_version_id,
        NEW.expected_revision,NEW.audit_reference,NEW.occurred_at,NEW.result_review_lifecycle_id,NEW.result_review_version,NEW.submission_digest)
      OR NEW.receipt_json->'submission' IS DISTINCT FROM original.record_json THEN
      RAISE EXCEPTION 'RECEIPT_TEMPLATE_SUBMIT_SOURCE_INCOHERENT' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_device.digital_receipt_template_submit_operation_guard() FROM PUBLIC;
CREATE TRIGGER digital_receipt_template_submit_operation_insert BEFORE INSERT ON rms_device.digital_receipt_template_submit_operation
  FOR EACH ROW EXECUTE FUNCTION rms_device.digital_receipt_template_submit_operation_guard();
CREATE FUNCTION rms_device.reject_receipt_template_submit_operation_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'RECEIPT_TEMPLATE_SUBMIT_IMMUTABLE' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_device.reject_receipt_template_submit_operation_mutation() FROM PUBLIC;
CREATE TRIGGER digital_receipt_template_submit_operation_no_mutation BEFORE UPDATE OR DELETE ON rms_device.digital_receipt_template_submit_operation
  FOR EACH ROW EXECUTE FUNCTION rms_device.reject_receipt_template_submit_operation_mutation();
CREATE TRIGGER digital_receipt_template_submit_operation_no_truncate BEFORE TRUNCATE ON rms_device.digital_receipt_template_submit_operation
  FOR EACH STATEMENT EXECUTE FUNCTION rms_device.reject_receipt_template_submit_operation_mutation();
ALTER TABLE rms_device.digital_receipt_template_submit_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_device.digital_receipt_template_submit_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY digital_receipt_template_submit_operation_scope ON rms_device.digital_receipt_template_submit_operation
  USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE)
  WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_device.digital_receipt_template_submit_operation FROM PUBLIC;
-- Historical standalone submissions remain readable. New ordinary producers acquire
-- their stage-operation barrier before the existing Template root and write both rows.
-- This invoker guard refuses visible terminal originals without exposing foreign scope.
CREATE FUNCTION rms_device.digital_receipt_template_submission_terminal_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_SCHEMA<>'rms_device' OR TG_TABLE_NAME<>'digital_receipt_template_submission'
    OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
    OR (NEW.tenant_id::text=current_setting('bop.tenant_id',true) AND NEW.brand_id=platform_helpers.current_brand_id()
      AND NEW.store_id=platform_helpers.current_store_id()) IS NOT TRUE THEN
    RAISE EXCEPTION 'RECEIPT_TEMPLATE_SUBMIT_SCOPE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM rms_device.digital_receipt_template_submit_operation
    WHERE operation_id=NEW.operation_id AND tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id) THEN
    RAISE EXCEPTION 'RECEIPT_TEMPLATE_SUBMIT_ALREADY_TERMINAL' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_device.digital_receipt_template_submission_terminal_guard() FROM PUBLIC;
CREATE TRIGGER digital_receipt_template_submission_terminal BEFORE INSERT ON rms_device.digital_receipt_template_submission
  FOR EACH ROW EXECUTE FUNCTION rms_device.digital_receipt_template_submission_terminal_guard();
