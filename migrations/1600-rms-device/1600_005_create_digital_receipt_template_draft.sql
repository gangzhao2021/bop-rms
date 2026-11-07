-- bop-rms-migration: 1
-- owner: @rms/printing-device
-- schema: rms_device
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_device.digital_receipt_template_draft_revision (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  template_id platform_helpers.uuid_v7 NOT NULL,
  family_id platform_helpers.uuid_v7 NOT NULL,
  version_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  publication_version_number bigint NOT NULL CHECK (publication_version_number BETWEEN 1 AND 9007199254740991),
  operation_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  previous_version_id platform_helpers.uuid_v7,
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=16384),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
  updated_at timestamptz NOT NULL CHECK (isfinite(updated_at) AND updated_at>=created_at AND updated_at=date_trunc('milliseconds',updated_at)),
  data_classification text NOT NULL CHECK (data_classification='Internal'),
  CONSTRAINT digital_receipt_template_draft_revision_pk PRIMARY KEY (tenant_id,brand_id,store_id,template_id,version_id),
  CONSTRAINT digital_receipt_template_draft_revision_scope_sequence UNIQUE (tenant_id,brand_id,store_id,template_id,revision),
  CONSTRAINT digital_receipt_template_draft_template_sequence UNIQUE (template_id,revision),
  CONSTRAINT digital_receipt_template_draft_family_sequence UNIQUE (family_id,revision),
  CONSTRAINT digital_receipt_template_draft_revision_result_tuple UNIQUE (operation_id,tenant_id,brand_id,store_id,version_id,revision,snapshot_digest,actor_id,updated_at)
);
CREATE TABLE rms_device.digital_receipt_template_draft_operation (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  template_id platform_helpers.uuid_v7,
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  expected_version_id platform_helpers.uuid_v7,
  expected_revision bigint NOT NULL CHECK (expected_revision BETWEEN 0 AND 2147483647),
  outcome text NOT NULL CHECK (outcome IN ('Committed','Abandoned')),
  result_version_id platform_helpers.uuid_v7,
  result_revision bigint,
  snapshot_digest text,
  audit_reference platform_helpers.uuid_v7 NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
  data_classification text NOT NULL CHECK (data_classification='Internal'),
  CONSTRAINT digital_receipt_template_draft_operation_expected CHECK ((expected_version_id IS NULL)=(expected_revision=0) AND (template_id IS NULL)=(expected_revision=0)),
  CONSTRAINT digital_receipt_template_draft_operation_terminal CHECK (
    (outcome='Abandoned' AND result_version_id IS NULL AND result_revision IS NULL AND snapshot_digest IS NULL)
    OR (outcome='Committed' AND result_version_id IS NOT NULL AND result_revision IS NOT NULL AND result_revision BETWEEN 1 AND 2147483647
      AND snapshot_digest IS NOT NULL AND snapshot_digest ~ '^sha256:[0-9a-f]{64}$'
      AND result_revision=expected_revision+1
      AND (expected_version_id IS NULL OR result_version_id<>expected_version_id))
  ),
  CONSTRAINT digital_receipt_template_draft_operation_result_tuple UNIQUE (operation_id,tenant_id,brand_id,store_id,result_version_id,result_revision,snapshot_digest,actor_id,occurred_at),
  CONSTRAINT digital_receipt_template_draft_operation_revision_fk FOREIGN KEY (operation_id,tenant_id,brand_id,store_id,result_version_id,result_revision,snapshot_digest,actor_id,occurred_at)
    REFERENCES rms_device.digital_receipt_template_draft_revision (operation_id,tenant_id,brand_id,store_id,version_id,revision,snapshot_digest,actor_id,updated_at)
    DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE rms_device.digital_receipt_template_draft_revision
  ADD CONSTRAINT digital_receipt_template_draft_revision_operation_fk FOREIGN KEY (operation_id,tenant_id,brand_id,store_id,version_id,revision,snapshot_digest,actor_id,updated_at)
    REFERENCES rms_device.digital_receipt_template_draft_operation (operation_id,tenant_id,brand_id,store_id,result_version_id,result_revision,snapshot_digest,actor_id,occurred_at)
    DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION rms_device.digital_receipt_template_draft_insert_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE previous rms_device.digital_receipt_template_draft_revision%ROWTYPE;
  snapshot jsonb;
  content jsonb;
  activation jsonb;
  instant text;
  activation_at text;
  until_at text;
  validation_instant text;
  validation_at timestamptz;
BEGIN
  IF TG_TABLE_SCHEMA<>'rms_device' OR TG_TABLE_NAME NOT IN ('digital_receipt_template_draft_revision','digital_receipt_template_draft_operation')
    OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
    OR current_setting('transaction_isolation')<>'read committed'
    OR (NEW.tenant_id::text=current_setting('bop.tenant_id',true)
      AND NEW.brand_id=platform_helpers.current_brand_id()
      AND NEW.store_id=platform_helpers.current_store_id()) IS NOT TRUE THEN
    RAISE EXCEPTION 'RECEIPT_TEMPLATE_DRAFT_SCOPE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ReceiptTemplateDraftOperation:'||NEW.operation_id::text,0));
  IF NEW.template_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('ReceiptTemplate:'||NEW.brand_id::text||':'||NEW.store_id::text||':'||NEW.template_id::text,0));
  END IF;
  IF TG_TABLE_NAME='digital_receipt_template_draft_revision' THEN
    snapshot:=NEW.snapshot_json;
    IF jsonb_typeof(snapshot) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'RECEIPT_TEMPLATE_DRAFT_SNAPSHOT_INVALID' USING ERRCODE='23514';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(snapshot))<>13
      OR snapshot->>'profile' IS DISTINCT FROM 'DigitalReceiptTemplateDraftV2'
      OR snapshot->>'familyReference' IS DISTINCT FROM NEW.family_id::text
      OR snapshot->>'tenantReference' IS DISTINCT FROM NEW.tenant_id::text
      OR snapshot->>'brandReference' IS DISTINCT FROM NEW.brand_id::text
      OR snapshot->>'storeReference' IS DISTINCT FROM NEW.store_id::text
      OR snapshot->'revision' IS DISTINCT FROM to_jsonb(NEW.revision)
      OR snapshot->>'authoredByReference' IS DISTINCT FROM NEW.actor_id::text
      OR snapshot->'previousVersionReference' IS DISTINCT FROM coalesce(to_jsonb(NEW.previous_version_id::text),'null'::jsonb)
      OR snapshot->>'contentDigest' IS DISTINCT FROM NEW.content_digest
      OR snapshot->>'createdAt' IS DISTINCT FROM to_char(NEW.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      OR snapshot->>'updatedAt' IS DISTINCT FROM to_char(NEW.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      OR snapshot->>'dataClassification' IS DISTINCT FROM NEW.data_classification
      OR jsonb_typeof(snapshot->'content') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'RECEIPT_TEMPLATE_DRAFT_SNAPSHOT_INVALID' USING ERRCODE='23514';
    END IF;
    content:=snapshot->'content';
    IF (SELECT count(*) FROM jsonb_object_keys(content))<>18
      OR content->>'profile' IS DISTINCT FROM 'DigitalReceiptTemplateContentV2'
      OR content->>'tenantReference' IS DISTINCT FROM NEW.tenant_id::text
      OR content->>'brandReference' IS DISTINCT FROM NEW.brand_id::text
      OR content->>'storeReference' IS DISTINCT FROM NEW.store_id::text
      OR content->>'templateReference' IS DISTINCT FROM NEW.template_id::text
      OR content->>'versionReference' IS DISTINCT FROM NEW.version_id::text
      OR content->'versionNumber' IS DISTINCT FROM to_jsonb(NEW.publication_version_number)
      OR content->>'versionCode' IS DISTINCT FROM 'RECEIPT_'||NEW.publication_version_number::text
      OR (content->>'locale' ~ '^[a-z]{2,3}(-[A-Z]{2})?$') IS NOT TRUE
      OR content->'dataContractVersion' IS DISTINCT FROM '1'::jsonb
      OR content->'renderEngineVersion' IS DISTINCT FROM '1'::jsonb
      OR content->>'outputProfile' IS DISTINCT FROM 'AccessibleDigitalReceipt'
      OR (content->>'layoutDefinitionReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') IS NOT TRUE
      OR (content->>'complianceRuleReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') IS NOT TRUE
      OR content->'requiredFields' IS DISTINCT FROM
        '["Issuer","Store","OrderNumber","IssuedAt","Items","Subtotal","Discount","Fee","Tax","Tip","Total","PaymentStatus","RefundedTotal"]'::jsonb
      OR content->>'dataClassification' IS DISTINCT FROM 'Internal'
      OR jsonb_typeof(content->'activation') IS DISTINCT FROM 'object'
      OR NOT(content ? 'effectiveUntil') THEN
      RAISE EXCEPTION 'RECEIPT_TEMPLATE_DRAFT_CONTENT_INVALID' USING ERRCODE='23514';
    END IF;
    activation:=content->'activation';
    IF activation->>'mode'='Immediate' THEN
      IF (SELECT count(*) FROM jsonb_object_keys(activation))<>1 THEN
        RAISE EXCEPTION 'RECEIPT_TEMPLATE_DRAFT_CONTENT_INVALID' USING ERRCODE='23514';
      END IF;
    ELSIF activation->>'mode'='Scheduled' THEN
      IF (SELECT count(*) FROM jsonb_object_keys(activation))<>2 OR NOT(activation ? 'effectiveFrom') THEN
        RAISE EXCEPTION 'RECEIPT_TEMPLATE_DRAFT_CONTENT_INVALID' USING ERRCODE='23514';
      END IF;
      instant:=activation->>'effectiveFrom';
      IF (instant ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$') IS NOT TRUE THEN
        RAISE EXCEPTION 'RECEIPT_TEMPLATE_DRAFT_CONTENT_INVALID' USING ERRCODE='23514';
      END IF;
      BEGIN
        -- The public canonical ISO parser admits year 0000. Validate the exact
        -- Gregorian month/day/time in the same 400-year cycle without forcing
        -- PostgreSQL's missing year-zero representation onto authored content.
        activation_at:=instant;
        validation_instant:=lpad((2000+(substring(instant FROM 1 FOR 4)::integer%400))::text,4,'0')||substring(instant FROM 5);
        validation_at:=validation_instant::timestamptz;
        IF to_char(validation_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM validation_instant THEN
          RAISE EXCEPTION 'RECEIPT_TEMPLATE_DRAFT_CONTENT_INVALID' USING ERRCODE='23514';
        END IF;
      EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'RECEIPT_TEMPLATE_DRAFT_CONTENT_INVALID' USING ERRCODE='23514';
      END;
    ELSE
      RAISE EXCEPTION 'RECEIPT_TEMPLATE_DRAFT_CONTENT_INVALID' USING ERRCODE='23514';
    END IF;
    IF content->'effectiveUntil' IS DISTINCT FROM 'null'::jsonb THEN
      instant:=content->>'effectiveUntil';
      IF (instant ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$') IS NOT TRUE THEN
        RAISE EXCEPTION 'RECEIPT_TEMPLATE_DRAFT_CONTENT_INVALID' USING ERRCODE='23514';
      END IF;
      BEGIN
        until_at:=instant;
        validation_instant:=lpad((2000+(substring(instant FROM 1 FOR 4)::integer%400))::text,4,'0')||substring(instant FROM 5);
        validation_at:=validation_instant::timestamptz;
        IF to_char(validation_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM validation_instant OR (activation_at IS NOT NULL AND until_at COLLATE "C"<=activation_at COLLATE "C") THEN
          RAISE EXCEPTION 'RECEIPT_TEMPLATE_DRAFT_CONTENT_INVALID' USING ERRCODE='23514';
        END IF;
      EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'RECEIPT_TEMPLATE_DRAFT_CONTENT_INVALID' USING ERRCODE='23514';
      END;
    END IF;
    SELECT * INTO previous FROM rms_device.digital_receipt_template_draft_revision
      WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND template_id=NEW.template_id
      ORDER BY revision DESC LIMIT 1;
    IF (previous.version_id IS NULL AND (NEW.revision<>1 OR NEW.previous_version_id IS NOT NULL OR NEW.created_at<>NEW.updated_at))
      OR (previous.version_id IS NOT NULL AND (NEW.version_id=previous.version_id OR NEW.previous_version_id IS DISTINCT FROM previous.version_id
        OR NEW.family_id<>previous.family_id OR NEW.revision<>previous.revision+1 OR NEW.created_at<>previous.created_at OR NEW.updated_at<previous.updated_at)) THEN
      RAISE EXCEPTION 'RECEIPT_TEMPLATE_DRAFT_REVISION_CONFLICT' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_device.digital_receipt_template_draft_insert_guard() FROM PUBLIC;
CREATE TRIGGER digital_receipt_template_draft_revision_insert_guard BEFORE INSERT ON rms_device.digital_receipt_template_draft_revision
  FOR EACH ROW EXECUTE FUNCTION rms_device.digital_receipt_template_draft_insert_guard();
CREATE TRIGGER digital_receipt_template_draft_operation_insert_guard BEFORE INSERT ON rms_device.digital_receipt_template_draft_operation
  FOR EACH ROW EXECUTE FUNCTION rms_device.digital_receipt_template_draft_insert_guard();

CREATE FUNCTION rms_device.digital_receipt_template_draft_coherent() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE original rms_device.digital_receipt_template_draft_operation%ROWTYPE;
  source rms_device.digital_receipt_template_draft_revision%ROWTYPE;
  current_xid xid;
BEGIN
  current_xid:=mod(pg_current_xact_id()::text::numeric,4294967296)::text::xid;
  IF TG_TABLE_SCHEMA<>'rms_device' OR TG_TABLE_NAME NOT IN ('digital_receipt_template_draft_revision','digital_receipt_template_draft_operation')
    OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
    OR (NEW.tenant_id::text=current_setting('bop.tenant_id',true)
      AND NEW.brand_id=platform_helpers.current_brand_id()
      AND NEW.store_id=platform_helpers.current_store_id()) IS NOT TRUE THEN
    RAISE EXCEPTION 'RECEIPT_TEMPLATE_DRAFT_SCOPE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  SELECT * INTO original FROM rms_device.digital_receipt_template_draft_operation WHERE operation_id=NEW.operation_id AND xmin=current_xid;
  IF original.operation_id IS NULL THEN
    RAISE EXCEPTION 'RECEIPT_TEMPLATE_DRAFT_ORIGINAL_MISSING' USING ERRCODE='23514';
  END IF;
  SELECT * INTO source FROM rms_device.digital_receipt_template_draft_revision WHERE operation_id=NEW.operation_id AND xmin=current_xid;
  -- Only the ordinary top-level host is supported; a SAVEPOINT source is not a
  -- substitute for the same top-level original operation. No old source backfill.
  IF original.outcome='Abandoned' THEN
    IF EXISTS(SELECT 1 FROM rms_device.digital_receipt_template_draft_revision WHERE operation_id=NEW.operation_id) THEN
      RAISE EXCEPTION 'RECEIPT_TEMPLATE_DRAFT_OPERATION_ABANDONED' USING ERRCODE='23514';
    END IF;
  ELSIF source.operation_id IS NULL OR (source.tenant_id,source.brand_id,source.store_id,source.version_id,source.revision,source.actor_id,source.snapshot_digest,source.updated_at)
    IS DISTINCT FROM (original.tenant_id,original.brand_id,original.store_id,original.result_version_id,original.result_revision,original.actor_id,original.snapshot_digest,original.occurred_at) THEN
    RAISE EXCEPTION 'RECEIPT_TEMPLATE_DRAFT_ORIGINAL_INCOHERENT' USING ERRCODE='23514';
  END IF;
  IF original.outcome='Committed' AND ((original.template_id IS NOT NULL AND source.template_id<>original.template_id) OR source.previous_version_id IS DISTINCT FROM original.expected_version_id OR source.revision<>original.expected_revision+1) THEN
    RAISE EXCEPTION 'RECEIPT_TEMPLATE_DRAFT_PARENT_INCOHERENT' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_device.digital_receipt_template_draft_coherent() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER digital_receipt_template_draft_revision_coherence AFTER INSERT ON rms_device.digital_receipt_template_draft_revision
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_device.digital_receipt_template_draft_coherent();
CREATE CONSTRAINT TRIGGER digital_receipt_template_draft_operation_coherence AFTER INSERT ON rms_device.digital_receipt_template_draft_operation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_device.digital_receipt_template_draft_coherent();

CREATE FUNCTION rms_device.reject_receipt_template_draft_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'RECEIPT_TEMPLATE_DRAFT_IMMUTABLE' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_device.reject_receipt_template_draft_mutation() FROM PUBLIC;
CREATE TRIGGER digital_receipt_template_draft_revision_no_mutation BEFORE UPDATE OR DELETE ON rms_device.digital_receipt_template_draft_revision
  FOR EACH ROW EXECUTE FUNCTION rms_device.reject_receipt_template_draft_mutation();
CREATE TRIGGER digital_receipt_template_draft_operation_no_mutation BEFORE UPDATE OR DELETE ON rms_device.digital_receipt_template_draft_operation
  FOR EACH ROW EXECUTE FUNCTION rms_device.reject_receipt_template_draft_mutation();
CREATE TRIGGER digital_receipt_template_draft_revision_no_truncate BEFORE TRUNCATE ON rms_device.digital_receipt_template_draft_revision
  FOR EACH STATEMENT EXECUTE FUNCTION rms_device.reject_receipt_template_draft_mutation();
CREATE TRIGGER digital_receipt_template_draft_operation_no_truncate BEFORE TRUNCATE ON rms_device.digital_receipt_template_draft_operation
  FOR EACH STATEMENT EXECUTE FUNCTION rms_device.reject_receipt_template_draft_mutation();
ALTER TABLE rms_device.digital_receipt_template_draft_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_device.digital_receipt_template_draft_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_device.digital_receipt_template_draft_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_device.digital_receipt_template_draft_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY digital_receipt_template_draft_revision_scope ON rms_device.digital_receipt_template_draft_revision
  USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE)
  WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE);
CREATE POLICY digital_receipt_template_draft_operation_scope ON rms_device.digital_receipt_template_draft_operation
  USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE)
  WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_device.digital_receipt_template_draft_revision FROM PUBLIC;
REVOKE ALL ON TABLE rms_device.digital_receipt_template_draft_operation FROM PUBLIC;
