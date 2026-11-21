-- bop-rms-migration: 1
-- owner: @rms/printing-device
-- schema: rms_device
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_device.digital_receipt_template_lifecycle_operation (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 actor_id platform_helpers.uuid_v7 NOT NULL,
 action text NOT NULL CHECK (action IN ('Approve','Publish')),
 template_id platform_helpers.uuid_v7 NOT NULL,
 expected_version_id platform_helpers.uuid_v7 NOT NULL,
 expected_revision bigint NOT NULL CHECK (expected_revision BETWEEN 1 AND 2147483647),
 review_lifecycle_id platform_helpers.uuid_v7 NOT NULL,
 expected_review_version bigint NOT NULL CHECK (expected_review_version BETWEEN 2 AND 2147483646),
 expected_review_operation_id platform_helpers.uuid_v7 NOT NULL CHECK (expected_review_operation_id<>operation_id),
 intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 outcome text NOT NULL CHECK (outcome IN ('Committed','Abandoned')),
 result_digest text,
 audit_reference platform_helpers.uuid_v7 NOT NULL,
 occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
 receipt_json jsonb NOT NULL CHECK (jsonb_typeof(receipt_json)='object' AND octet_length(receipt_json::text)<=16384),
 receipt_digest text NOT NULL CHECK (receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
 data_classification text NOT NULL CHECK (data_classification='Confidential'),
 CONSTRAINT digital_receipt_template_lifecycle_result CHECK (
   (outcome='Abandoned' AND result_digest IS NULL) OR
   (outcome='Committed' AND result_digest IS NOT NULL AND result_digest ~ '^sha256:[0-9a-f]{64}$'))
);
CREATE FUNCTION rms_device.digital_receipt_template_lifecycle_operation_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE original rms_device.digital_receipt_template_submission%ROWTYPE;
 draft rms_device.digital_receipt_template_draft_revision%ROWTYPE;
 published rms_device.digital_receipt_template_version%ROWTYPE;
 published_xmin xid;
 result jsonb;
 envelope jsonb;
 member text;
 stamp text;
 normalized timestamptz;
BEGIN
 IF TG_TABLE_SCHEMA<>'rms_device' OR TG_TABLE_NAME<>'digital_receipt_template_lifecycle_operation'
   OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
   OR current_setting('transaction_isolation')<>'read committed'
   OR (NEW.tenant_id::text=current_setting('bop.tenant_id',true)
     AND NEW.brand_id=platform_helpers.current_brand_id() AND NEW.store_id=platform_helpers.current_store_id()) IS NOT TRUE THEN
   RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_SCOPE_UNAVAILABLE' USING ERRCODE='55000';
 END IF;
 IF jsonb_typeof(NEW.receipt_json) IS DISTINCT FROM 'object'
   OR (SELECT count(*) FROM jsonb_object_keys(NEW.receipt_json))<>18
   OR NEW.receipt_json->>'profile' IS DISTINCT FROM 'DigitalReceiptTemplateLifecycleReceiptV1'
   OR NEW.receipt_json->'tenantReference' IS DISTINCT FROM to_jsonb(NEW.tenant_id::text)
   OR NEW.receipt_json->'brandReference' IS DISTINCT FROM to_jsonb(NEW.brand_id::text)
   OR NEW.receipt_json->'storeReference' IS DISTINCT FROM to_jsonb(NEW.store_id::text)
   OR NEW.receipt_json->'actorReference' IS DISTINCT FROM to_jsonb(NEW.actor_id::text)
   OR NEW.receipt_json->'action' IS DISTINCT FROM to_jsonb(NEW.action::text)
   OR NEW.receipt_json->'operationReference' IS DISTINCT FROM to_jsonb(NEW.operation_id::text)
   OR NEW.receipt_json->'templateReference' IS DISTINCT FROM to_jsonb(NEW.template_id::text)
   OR NEW.receipt_json->'expectedVersionReference' IS DISTINCT FROM to_jsonb(NEW.expected_version_id::text)
   OR NEW.receipt_json->'expectedRevision' IS DISTINCT FROM to_jsonb(NEW.expected_revision)
   OR NEW.receipt_json->'reviewLifecycleReference' IS DISTINCT FROM to_jsonb(NEW.review_lifecycle_id::text)
   OR NEW.receipt_json->'expectedReviewVersion' IS DISTINCT FROM to_jsonb(NEW.expected_review_version)
   OR NEW.receipt_json->'expectedReviewOperationReference' IS DISTINCT FROM to_jsonb(NEW.expected_review_operation_id::text)
   OR NEW.receipt_json->'intentDigest' IS DISTINCT FROM to_jsonb(NEW.intent_digest::text)
   OR NEW.receipt_json->'outcome' IS DISTINCT FROM to_jsonb(NEW.outcome::text)
   OR NEW.receipt_json->'auditReference' IS DISTINCT FROM to_jsonb(NEW.audit_reference::text)
   OR NEW.receipt_json->'occurredAt' IS DISTINCT FROM to_jsonb(to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) THEN
   RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_RECEIPT_INVALID' USING ERRCODE='23514';
 END IF;
 result:=NEW.receipt_json->'result';
 SELECT * INTO published FROM rms_device.digital_receipt_template_version
   WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND operation_id=NEW.operation_id;
 IF NEW.outcome='Abandoned' THEN
   IF result IS DISTINCT FROM 'null'::jsonb OR published.operation_id IS NOT NULL THEN
     RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_ABANDONED_INVALID' USING ERRCODE='23514';
   END IF;
   RETURN NEW;
 END IF;
 SELECT * INTO original FROM rms_device.digital_receipt_template_submission
   WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND version_id=NEW.expected_version_id;
 SELECT * INTO draft FROM rms_device.digital_receipt_template_draft_revision
   WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id
     AND template_id=NEW.template_id AND version_id=NEW.expected_version_id;
 IF original.operation_id IS NULL OR draft.version_id IS NULL
   OR (original.template_id,original.draft_revision,original.review_lifecycle_id,original.family_id,original.content_digest,original.authored_by_id)
     IS DISTINCT FROM (NEW.template_id,NEW.expected_revision,NEW.review_lifecycle_id,draft.family_id,draft.content_digest,draft.actor_id)
   OR original.review_version>NEW.expected_review_version OR original.submitted_at>NEW.occurred_at
   OR original.validation_valid_until<=NEW.occurred_at
   OR jsonb_typeof(result) IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_SOURCE_INCOHERENT' USING ERRCODE='23514';
 END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(result))<>10
   OR result->'lifecycleReference' IS DISTINCT FROM to_jsonb(NEW.review_lifecycle_id::text)
   OR result->'lifecycleVersion' IS DISTINCT FROM to_jsonb(NEW.expected_review_version+1)
   OR result->'mutationOperationReference' IS DISTINCT FROM to_jsonb(NEW.operation_id::text)
   OR result->'changedAt' IS DISTINCT FROM NEW.receipt_json->'occurredAt'
   OR jsonb_typeof(result->'approvalEvidenceReference') IS DISTINCT FROM 'string'
   OR (result->>'approvalEvidenceReference') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   OR jsonb_typeof(result->'approvedByReference') IS DISTINCT FROM 'string'
   OR (result->>'approvedByReference') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   OR result->>'approvedByReference' IN (original.authored_by_id::text,original.submitted_by_id::text) THEN
   RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_RESULT_INVALID' USING ERRCODE='23514';
 END IF;
 FOREACH member IN ARRAY ARRAY['approvedAt','approvalValidUntil'] LOOP
   stamp:=result->>member;
   IF jsonb_typeof(result->member) IS DISTINCT FROM 'string'
     OR stamp !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN
     RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_CLOCK_INVALID' USING ERRCODE='23514';
   END IF;
   -- A 400-year surrogate validates canonical business dates including year 0000.
   normalized:=(lpad((substring(stamp,1,4)::integer%400+2000)::text,4,'0')||substring(stamp,5))::timestamptz;
   IF substring(to_char(normalized AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),5)<>substring(stamp,5) THEN
     RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_CLOCK_INVALID' USING ERRCODE='23514';
   END IF;
 END LOOP;
 IF result->>'approvedAt'<to_char(original.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   OR result->>'approvedAt'>NEW.receipt_json->>'occurredAt'
   OR result->>'approvalValidUntil'>to_char(original.validation_valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   OR result->>'approvalValidUntil'<=NEW.receipt_json->>'occurredAt' THEN
   RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_CLOCK_INVALID' USING ERRCODE='23514';
 END IF;
 IF NEW.action='Approve' THEN
   IF result->'state' IS DISTINCT FROM '"Approved"'::jsonb
     OR result->'publishedVersion' IS DISTINCT FROM 'null'::jsonb
     OR result->'approvedByReference' IS DISTINCT FROM to_jsonb(NEW.actor_id::text)
     OR result->'approvedAt' IS DISTINCT FROM NEW.receipt_json->'occurredAt'
     OR NEW.expected_review_version<>original.review_version
     OR NEW.expected_review_operation_id<>original.operation_id OR published.operation_id IS NOT NULL THEN
     RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_APPROVAL_INVALID' USING ERRCODE='23514';
   END IF;
 ELSE
   envelope:=result->'publishedVersion';
   SELECT xmin INTO published_xmin FROM rms_device.digital_receipt_template_version
     WHERE brand_id=NEW.brand_id AND store_id=NEW.store_id AND operation_id=NEW.operation_id;
   IF result->'state' IS DISTINCT FROM '"Published"'::jsonb
     OR jsonb_typeof(envelope) IS DISTINCT FROM 'object' THEN
     RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_PUBLICATION_INVALID' USING ERRCODE='23514';
   END IF;
   IF (SELECT count(*) FROM jsonb_object_keys(envelope))<>17
     OR published.operation_id IS NULL
     OR published_xmin IS DISTINCT FROM mod(pg_current_xact_id()::text::numeric,4294967296)::text::xid
     OR (published.template_id,published.version_id,published.published_at,published.publication_digest)
       IS DISTINCT FROM (NEW.template_id,NEW.expected_version_id,NEW.occurred_at,original.content_digest)
     OR NEW.expected_review_version<=original.review_version
     OR envelope IS DISTINCT FROM published.version_json
     OR envelope->'publicationReference' IS DISTINCT FROM to_jsonb(published.publication_id::text)
     OR envelope->'publishedAt' IS DISTINCT FROM NEW.receipt_json->'occurredAt'
     OR jsonb_typeof(envelope->'effectiveFrom') IS DISTINCT FROM 'string'
     OR envelope->'effectiveUntil' IS DISTINCT FROM draft.snapshot_json->'content'->'effectiveUntil'
     OR envelope->'effectiveFrom' IS DISTINCT FROM (CASE WHEN draft.snapshot_json->'content'->'activation'->>'mode'='Immediate' THEN envelope->'publishedAt' ELSE draft.snapshot_json->'content'->'activation'->'effectiveFrom' END)
     OR envelope->'versionNumber' IS DISTINCT FROM to_jsonb(published.version_number)
     OR envelope->'versionCode' IS DISTINCT FROM to_jsonb(published.version_code)
     OR envelope->'effectiveFrom'<envelope->'publishedAt'
     OR (envelope->'effectiveUntil'<>'null'::jsonb AND envelope->'effectiveUntil'<=envelope->'effectiveFrom') THEN
     RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_PUBLICATION_INVALID' USING ERRCODE='23514';
   END IF;
   IF envelope->'templateReference' IS DISTINCT FROM draft.snapshot_json->'content'->'templateReference' THEN RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_PUBLICATION_INVALID' USING ERRCODE='23514'; END IF;
   IF envelope->'versionReference' IS DISTINCT FROM draft.snapshot_json->'content'->'versionReference' THEN RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_PUBLICATION_INVALID' USING ERRCODE='23514'; END IF;
   IF envelope->'versionNumber' IS DISTINCT FROM draft.snapshot_json->'content'->'versionNumber' THEN RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_PUBLICATION_INVALID' USING ERRCODE='23514'; END IF;
   IF envelope->'versionCode' IS DISTINCT FROM draft.snapshot_json->'content'->'versionCode' THEN RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_PUBLICATION_INVALID' USING ERRCODE='23514'; END IF;
   IF envelope->'brandReference' IS DISTINCT FROM draft.snapshot_json->'content'->'brandReference' THEN RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_PUBLICATION_INVALID' USING ERRCODE='23514'; END IF;
   IF envelope->'storeReference' IS DISTINCT FROM draft.snapshot_json->'content'->'storeReference' THEN RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_PUBLICATION_INVALID' USING ERRCODE='23514'; END IF;
   IF envelope->'locale' IS DISTINCT FROM draft.snapshot_json->'content'->'locale' THEN RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_PUBLICATION_INVALID' USING ERRCODE='23514'; END IF;
   IF envelope->'dataContractVersion' IS DISTINCT FROM draft.snapshot_json->'content'->'dataContractVersion' THEN RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_PUBLICATION_INVALID' USING ERRCODE='23514'; END IF;
   IF envelope->'renderEngineVersion' IS DISTINCT FROM draft.snapshot_json->'content'->'renderEngineVersion' THEN RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_PUBLICATION_INVALID' USING ERRCODE='23514'; END IF;
   IF envelope->'outputProfile' IS DISTINCT FROM draft.snapshot_json->'content'->'outputProfile' THEN RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_PUBLICATION_INVALID' USING ERRCODE='23514'; END IF;
   IF envelope->'layoutDefinitionReference' IS DISTINCT FROM draft.snapshot_json->'content'->'layoutDefinitionReference' THEN RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_PUBLICATION_INVALID' USING ERRCODE='23514'; END IF;
   IF envelope->'complianceRuleReference' IS DISTINCT FROM draft.snapshot_json->'content'->'complianceRuleReference' THEN RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_PUBLICATION_INVALID' USING ERRCODE='23514'; END IF;
   IF envelope->'requiredFields' IS DISTINCT FROM draft.snapshot_json->'content'->'requiredFields' THEN RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_PUBLICATION_INVALID' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_device.digital_receipt_template_lifecycle_operation_guard() FROM PUBLIC;
CREATE TRIGGER digital_receipt_template_lifecycle_operation_insert BEFORE INSERT ON rms_device.digital_receipt_template_lifecycle_operation
 FOR EACH ROW EXECUTE FUNCTION rms_device.digital_receipt_template_lifecycle_operation_guard();
CREATE FUNCTION rms_device.reject_receipt_template_lifecycle_operation_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_IMMUTABLE' USING ERRCODE='55000';
END;
$$;
REVOKE ALL ON FUNCTION rms_device.reject_receipt_template_lifecycle_operation_mutation() FROM PUBLIC;
CREATE TRIGGER digital_receipt_template_lifecycle_operation_no_mutation BEFORE UPDATE OR DELETE ON rms_device.digital_receipt_template_lifecycle_operation
 FOR EACH ROW EXECUTE FUNCTION rms_device.reject_receipt_template_lifecycle_operation_mutation();
CREATE TRIGGER digital_receipt_template_lifecycle_operation_no_truncate BEFORE TRUNCATE ON rms_device.digital_receipt_template_lifecycle_operation
 FOR EACH STATEMENT EXECUTE FUNCTION rms_device.reject_receipt_template_lifecycle_operation_mutation();
ALTER TABLE rms_device.digital_receipt_template_lifecycle_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_device.digital_receipt_template_lifecycle_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY digital_receipt_template_lifecycle_operation_scope ON rms_device.digital_receipt_template_lifecycle_operation
 USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE)
 WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_device.digital_receipt_template_lifecycle_operation FROM PUBLIC;
-- New ordinary publication appends its version before its lifecycle terminal.
-- A visible abandoned original can never later acquire a published Device row.
CREATE FUNCTION rms_device.digital_receipt_template_lifecycle_terminal_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF TG_TABLE_SCHEMA<>'rms_device' OR TG_TABLE_NAME<>'digital_receipt_template_version'
   OR TG_OP<>'INSERT' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' THEN
   RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_SCOPE_UNAVAILABLE' USING ERRCODE='55000';
 END IF;
 IF EXISTS (SELECT 1 FROM rms_device.digital_receipt_template_lifecycle_operation
   WHERE operation_id=NEW.operation_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id) THEN
   RAISE EXCEPTION 'RECEIPT_TEMPLATE_LIFECYCLE_ALREADY_TERMINAL' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_device.digital_receipt_template_lifecycle_terminal_guard() FROM PUBLIC;
CREATE TRIGGER digital_receipt_template_lifecycle_terminal BEFORE INSERT ON rms_device.digital_receipt_template_version
 FOR EACH ROW EXECUTE FUNCTION rms_device.digital_receipt_template_lifecycle_terminal_guard();
