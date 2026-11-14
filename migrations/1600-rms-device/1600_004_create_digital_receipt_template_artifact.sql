-- bop-rms-migration: 1
-- owner: @rms/printing-device
-- schema: rms_device
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_device.digital_receipt_template_artifact_version (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  artifact_kind text NOT NULL CHECK (artifact_kind IN ('Layout','Compliance')),
  artifact_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  operation_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  previous_artifact_id platform_helpers.uuid_v7,
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=16384),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
  updated_at timestamptz NOT NULL CHECK (isfinite(updated_at) AND updated_at>=created_at AND updated_at=date_trunc('milliseconds',updated_at)),
  data_classification text NOT NULL CHECK (data_classification='Internal'),
  CONSTRAINT digital_receipt_template_artifact_version_pk PRIMARY KEY (tenant_id,brand_id,store_id,artifact_kind,artifact_id),
  CONSTRAINT digital_receipt_template_artifact_version_scope_sequence UNIQUE (tenant_id,brand_id,store_id,artifact_kind,revision),
  CONSTRAINT digital_receipt_template_artifact_version_result_tuple UNIQUE (operation_id,tenant_id,brand_id,store_id,artifact_kind,artifact_id,revision,snapshot_digest,actor_id,updated_at)
);
CREATE TABLE rms_device.digital_receipt_template_artifact_operation (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  artifact_kind text NOT NULL CHECK (artifact_kind IN ('Layout','Compliance')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  expected_artifact_id platform_helpers.uuid_v7,
  expected_revision bigint NOT NULL CHECK (expected_revision BETWEEN 0 AND 2147483647),
  outcome text NOT NULL CHECK (outcome IN ('Committed','Abandoned')),
  result_artifact_id platform_helpers.uuid_v7,
  result_revision bigint,
  snapshot_digest text,
  audit_reference platform_helpers.uuid_v7 NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
  data_classification text NOT NULL CHECK (data_classification='Internal'),
  CONSTRAINT digital_receipt_template_artifact_operation_expected CHECK ((expected_artifact_id IS NULL)=(expected_revision=0)),
  CONSTRAINT digital_receipt_template_artifact_operation_terminal CHECK (
    (outcome='Abandoned' AND result_artifact_id IS NULL AND result_revision IS NULL AND snapshot_digest IS NULL)
    OR (outcome='Committed' AND result_artifact_id IS NOT NULL AND result_revision IS NOT NULL AND result_revision BETWEEN 1 AND 2147483647
      AND snapshot_digest IS NOT NULL AND snapshot_digest ~ '^sha256:[0-9a-f]{64}$'
      AND result_revision=expected_revision+1
      AND (expected_artifact_id IS NULL OR result_artifact_id<>expected_artifact_id))
  ),
  CONSTRAINT digital_receipt_template_artifact_operation_result_tuple UNIQUE (operation_id,tenant_id,brand_id,store_id,artifact_kind,result_artifact_id,result_revision,snapshot_digest,actor_id,occurred_at),
  CONSTRAINT digital_receipt_template_artifact_operation_revision_fk FOREIGN KEY (operation_id,tenant_id,brand_id,store_id,artifact_kind,result_artifact_id,result_revision,snapshot_digest,actor_id,occurred_at)
    REFERENCES rms_device.digital_receipt_template_artifact_version (operation_id,tenant_id,brand_id,store_id,artifact_kind,artifact_id,revision,snapshot_digest,actor_id,updated_at)
    DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE rms_device.digital_receipt_template_artifact_version
  ADD CONSTRAINT digital_receipt_template_artifact_version_operation_fk FOREIGN KEY (operation_id,tenant_id,brand_id,store_id,artifact_kind,artifact_id,revision,snapshot_digest,actor_id,updated_at)
    REFERENCES rms_device.digital_receipt_template_artifact_operation (operation_id,tenant_id,brand_id,store_id,artifact_kind,result_artifact_id,result_revision,snapshot_digest,actor_id,occurred_at)
    DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION rms_device.digital_receipt_template_artifact_insert_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE previous rms_device.digital_receipt_template_artifact_version%ROWTYPE;
  snapshot jsonb;
BEGIN
  IF TG_TABLE_SCHEMA<>'rms_device' OR TG_TABLE_NAME NOT IN ('digital_receipt_template_artifact_version','digital_receipt_template_artifact_operation')
    OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
    OR current_setting('transaction_isolation')<>'read committed'
    OR (NEW.tenant_id::text=current_setting('bop.tenant_id',true)
      AND NEW.brand_id=platform_helpers.current_brand_id()
      AND NEW.store_id=platform_helpers.current_store_id()) IS NOT TRUE THEN
    RAISE EXCEPTION 'RECEIPT_TEMPLATE_ARTIFACT_SCOPE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ReceiptTemplateArtifactOperation:'||NEW.operation_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('ReceiptTemplateArtifactRoot:'||NEW.tenant_id::text||':'||NEW.brand_id::text||':'||NEW.store_id::text||':'||NEW.artifact_kind,0));
  IF TG_TABLE_NAME='digital_receipt_template_artifact_version' THEN
    snapshot:=NEW.snapshot_json;
    IF jsonb_typeof(snapshot) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'RECEIPT_TEMPLATE_ARTIFACT_SNAPSHOT_INVALID' USING ERRCODE='23514';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(snapshot))<>13
      OR snapshot->>'profile' IS DISTINCT FROM 'DigitalReceiptTemplateArtifactV1'
      OR snapshot->>'artifactReference' IS DISTINCT FROM NEW.artifact_id::text
      OR snapshot->>'artifactKind' IS DISTINCT FROM NEW.artifact_kind
      OR snapshot->>'tenantReference' IS DISTINCT FROM NEW.tenant_id::text
      OR snapshot->>'brandReference' IS DISTINCT FROM NEW.brand_id::text
      OR snapshot->>'storeReference' IS DISTINCT FROM NEW.store_id::text
      OR snapshot->'revision' IS DISTINCT FROM to_jsonb(NEW.revision)
      OR snapshot->>'authoredByReference' IS DISTINCT FROM NEW.actor_id::text
      OR snapshot->'previousArtifactReference' IS DISTINCT FROM coalesce(to_jsonb(NEW.previous_artifact_id::text),'null'::jsonb)
      OR snapshot->>'createdAt' IS DISTINCT FROM to_char(NEW.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      OR snapshot->>'updatedAt' IS DISTINCT FROM to_char(NEW.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      OR snapshot->>'dataClassification' IS DISTINCT FROM NEW.data_classification
      OR jsonb_typeof(snapshot->'content') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'RECEIPT_TEMPLATE_ARTIFACT_SNAPSHOT_INVALID' USING ERRCODE='23514';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(snapshot->'content'))<>5
      OR snapshot->'content'->'dataContractVersion' IS DISTINCT FROM '1'::jsonb
      OR snapshot->'content'->'requiredFields' IS DISTINCT FROM
        '["Issuer","Store","OrderNumber","IssuedAt","Items","Subtotal","Discount","Fee","Tax","Tip","Total","PaymentStatus","RefundedTotal"]'::jsonb THEN
      RAISE EXCEPTION 'RECEIPT_TEMPLATE_ARTIFACT_CONTENT_INVALID' USING ERRCODE='23514';
    END IF;
    IF NEW.artifact_kind='Layout' THEN
      IF snapshot->'content'->>'profile' IS DISTINCT FROM 'AccessibleDigitalReceiptLayoutV1'
        OR snapshot->'content'->'renderEngineVersion' IS DISTINCT FROM '1'::jsonb
        OR snapshot->'content'->>'outputProfile' IS DISTINCT FROM 'AccessibleDigitalReceipt' THEN
        RAISE EXCEPTION 'RECEIPT_TEMPLATE_ARTIFACT_CONTENT_INVALID' USING ERRCODE='23514';
      END IF;
    ELSE
      IF snapshot->'content'->>'profile' IS DISTINCT FROM 'DigitalReceiptRequiredFieldRuleV1'
        OR snapshot->'content'->>'professionalReviewStatus' IS DISTINCT FROM 'NotEvaluated'
        OR snapshot->'content'->>'legalConclusion' IS DISTINCT FROM 'NotEvaluated' THEN
        RAISE EXCEPTION 'RECEIPT_TEMPLATE_ARTIFACT_CONTENT_INVALID' USING ERRCODE='23514';
      END IF;
    END IF;
    SELECT * INTO previous FROM rms_device.digital_receipt_template_artifact_version
      WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND artifact_kind=NEW.artifact_kind
      ORDER BY revision DESC LIMIT 1;
    IF (previous.artifact_id IS NULL AND (NEW.revision<>1 OR NEW.previous_artifact_id IS NOT NULL OR NEW.created_at<>NEW.updated_at))
      OR (previous.artifact_id IS NOT NULL AND (NEW.artifact_id=previous.artifact_id OR NEW.previous_artifact_id IS DISTINCT FROM previous.artifact_id
        OR NEW.revision<>previous.revision+1 OR NEW.created_at<>previous.created_at OR NEW.updated_at<previous.updated_at)) THEN
      RAISE EXCEPTION 'RECEIPT_TEMPLATE_ARTIFACT_REVISION_CONFLICT' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_device.digital_receipt_template_artifact_insert_guard() FROM PUBLIC;
CREATE TRIGGER digital_receipt_template_artifact_version_insert_guard BEFORE INSERT ON rms_device.digital_receipt_template_artifact_version
  FOR EACH ROW EXECUTE FUNCTION rms_device.digital_receipt_template_artifact_insert_guard();
CREATE TRIGGER digital_receipt_template_artifact_operation_insert_guard BEFORE INSERT ON rms_device.digital_receipt_template_artifact_operation
  FOR EACH ROW EXECUTE FUNCTION rms_device.digital_receipt_template_artifact_insert_guard();

CREATE FUNCTION rms_device.digital_receipt_template_artifact_coherent() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE original rms_device.digital_receipt_template_artifact_operation%ROWTYPE;
  source rms_device.digital_receipt_template_artifact_version%ROWTYPE;
  current_xid xid;
BEGIN
  current_xid:=mod(pg_current_xact_id()::text::numeric,4294967296)::text::xid;
  IF TG_TABLE_SCHEMA<>'rms_device' OR TG_TABLE_NAME NOT IN ('digital_receipt_template_artifact_version','digital_receipt_template_artifact_operation')
    OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
    OR (NEW.tenant_id::text=current_setting('bop.tenant_id',true)
      AND NEW.brand_id=platform_helpers.current_brand_id()
      AND NEW.store_id=platform_helpers.current_store_id()) IS NOT TRUE THEN
    RAISE EXCEPTION 'RECEIPT_TEMPLATE_ARTIFACT_SCOPE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  SELECT * INTO original FROM rms_device.digital_receipt_template_artifact_operation WHERE operation_id=NEW.operation_id AND xmin=current_xid;
  IF original.operation_id IS NULL THEN
    RAISE EXCEPTION 'RECEIPT_TEMPLATE_ARTIFACT_ORIGINAL_MISSING' USING ERRCODE='23514';
  END IF;
  SELECT * INTO source FROM rms_device.digital_receipt_template_artifact_version WHERE operation_id=NEW.operation_id AND xmin=current_xid;
  -- Only the ordinary top-level host is supported; a SAVEPOINT source is not a
  -- substitute for the same top-level original operation. No old source backfill.
  IF original.outcome='Abandoned' THEN
    IF EXISTS(SELECT 1 FROM rms_device.digital_receipt_template_artifact_version WHERE operation_id=NEW.operation_id) THEN
      RAISE EXCEPTION 'RECEIPT_TEMPLATE_ARTIFACT_OPERATION_ABANDONED' USING ERRCODE='23514';
    END IF;
  ELSIF source.operation_id IS NULL OR (source.tenant_id,source.brand_id,source.store_id,source.artifact_kind,source.artifact_id,source.revision,source.actor_id,source.snapshot_digest,source.updated_at)
    IS DISTINCT FROM (original.tenant_id,original.brand_id,original.store_id,original.artifact_kind,original.result_artifact_id,original.result_revision,original.actor_id,original.snapshot_digest,original.occurred_at) THEN
    RAISE EXCEPTION 'RECEIPT_TEMPLATE_ARTIFACT_ORIGINAL_INCOHERENT' USING ERRCODE='23514';
  END IF;
  IF original.outcome='Committed' AND (source.previous_artifact_id IS DISTINCT FROM original.expected_artifact_id OR source.revision<>original.expected_revision+1) THEN
    RAISE EXCEPTION 'RECEIPT_TEMPLATE_ARTIFACT_PARENT_INCOHERENT' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_device.digital_receipt_template_artifact_coherent() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER digital_receipt_template_artifact_version_coherence AFTER INSERT ON rms_device.digital_receipt_template_artifact_version
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_device.digital_receipt_template_artifact_coherent();
CREATE CONSTRAINT TRIGGER digital_receipt_template_artifact_operation_coherence AFTER INSERT ON rms_device.digital_receipt_template_artifact_operation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_device.digital_receipt_template_artifact_coherent();

CREATE FUNCTION rms_device.reject_receipt_template_artifact_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'RECEIPT_TEMPLATE_ARTIFACT_IMMUTABLE' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_device.reject_receipt_template_artifact_mutation() FROM PUBLIC;
CREATE TRIGGER digital_receipt_template_artifact_version_no_mutation BEFORE UPDATE OR DELETE ON rms_device.digital_receipt_template_artifact_version
  FOR EACH ROW EXECUTE FUNCTION rms_device.reject_receipt_template_artifact_mutation();
CREATE TRIGGER digital_receipt_template_artifact_operation_no_mutation BEFORE UPDATE OR DELETE ON rms_device.digital_receipt_template_artifact_operation
  FOR EACH ROW EXECUTE FUNCTION rms_device.reject_receipt_template_artifact_mutation();
CREATE TRIGGER digital_receipt_template_artifact_version_no_truncate BEFORE TRUNCATE ON rms_device.digital_receipt_template_artifact_version
  FOR EACH STATEMENT EXECUTE FUNCTION rms_device.reject_receipt_template_artifact_mutation();
CREATE TRIGGER digital_receipt_template_artifact_operation_no_truncate BEFORE TRUNCATE ON rms_device.digital_receipt_template_artifact_operation
  FOR EACH STATEMENT EXECUTE FUNCTION rms_device.reject_receipt_template_artifact_mutation();
ALTER TABLE rms_device.digital_receipt_template_artifact_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_device.digital_receipt_template_artifact_version FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_device.digital_receipt_template_artifact_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_device.digital_receipt_template_artifact_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY digital_receipt_template_artifact_version_scope ON rms_device.digital_receipt_template_artifact_version
  USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE)
  WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE);
CREATE POLICY digital_receipt_template_artifact_operation_scope ON rms_device.digital_receipt_template_artifact_operation
  USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE)
  WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_device.digital_receipt_template_artifact_version FROM PUBLIC;
REVOKE ALL ON TABLE rms_device.digital_receipt_template_artifact_operation FROM PUBLIC;
