-- bop-rms-migration: 1
-- owner: @bop/tenant
-- schema: bop_tenant
-- phase: expand
-- risk: high
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE bop_tenant.brand_configuration_authoring_revision (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL REFERENCES bop_tenant.brand(brand_id),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  brand_version bigint NOT NULL CHECK (brand_version BETWEEN 1 AND 9007199254740991),
  configuration_version_id platform_helpers.uuid_v7 NOT NULL,
  configuration_version bigint NOT NULL CHECK (configuration_version BETWEEN 1 AND 9007199254740991),
  command_type text NOT NULL CHECK (command_type IN ('SaveConfigurationDraft','SubmitConfiguration','ApproveConfiguration','PublishConfiguration')),
  operation_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_digest text NOT NULL CHECK (source_digest ~ '^sha256:[0-9a-f]{64}$'),
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=131072),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
  recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at) AND recorded_at>=created_at),
  data_classification text NOT NULL CHECK (data_classification='ConfigurationMetadata'),
  CONSTRAINT brand_configuration_revision_pk PRIMARY KEY (tenant_id,brand_id,revision),
  CONSTRAINT brand_configuration_revision_result_tuple UNIQUE (operation_id,tenant_id,brand_id,revision,configuration_version_id,actor_id,audit_id,source_digest,recorded_at)
);
CREATE TABLE bop_tenant.brand_configuration_authoring_operation (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL REFERENCES bop_tenant.brand(brand_id),
  actor_id platform_helpers.uuid_v7 NOT NULL,
  command_type text NOT NULL CHECK (command_type IN ('SaveConfigurationDraft','SubmitConfiguration','ApproveConfiguration','PublishConfiguration')),
  expected_brand_version bigint NOT NULL CHECK (expected_brand_version BETWEEN 1 AND 9007199254740991),
  expected_revision integer CHECK (expected_revision BETWEEN 1 AND 2147483647),
  expected_configuration_version_id platform_helpers.uuid_v7,
  expected_source_digest text,
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('Committed','Abandoned')),
  result_revision integer,
  result_configuration_version_id platform_helpers.uuid_v7,
  result_source_digest text,
  command_json jsonb CHECK (command_json IS NULL OR (jsonb_typeof(command_json)='object' AND octet_length(command_json::text)<=131072)),
  receipt_json jsonb NOT NULL CHECK (jsonb_typeof(receipt_json)='object' AND octet_length(receipt_json::text)<=393216),
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
  data_classification text NOT NULL CHECK (data_classification='ConfigurationMetadata'),
  CONSTRAINT brand_configuration_operation_head CHECK (
    (expected_revision IS NULL AND expected_configuration_version_id IS NULL AND expected_source_digest IS NULL AND command_type='SaveConfigurationDraft')
    OR (expected_revision IS NOT NULL AND expected_configuration_version_id IS NOT NULL AND expected_source_digest IS NOT NULL AND expected_source_digest ~ '^sha256:[0-9a-f]{64}$')
  ),
  CONSTRAINT brand_configuration_operation_terminal CHECK (
    (outcome='Abandoned' AND result_revision IS NULL AND result_configuration_version_id IS NULL AND result_source_digest IS NULL AND command_json IS NULL)
    OR (outcome='Committed' AND result_revision IS NOT NULL AND result_revision BETWEEN 1 AND 2147483647
      AND result_revision::bigint=COALESCE(expected_revision,0)::bigint+1 AND result_configuration_version_id IS NOT NULL
      AND result_source_digest IS NOT NULL AND result_source_digest ~ '^sha256:[0-9a-f]{64}$' AND command_json IS NOT NULL)
  ),
  CONSTRAINT brand_configuration_operation_result_tuple UNIQUE (operation_id,tenant_id,brand_id,result_revision,result_configuration_version_id,actor_id,audit_id,result_source_digest,occurred_at),
  CONSTRAINT brand_configuration_operation_revision_fk FOREIGN KEY (operation_id,tenant_id,brand_id,result_revision,result_configuration_version_id,actor_id,audit_id,result_source_digest,occurred_at)
    REFERENCES bop_tenant.brand_configuration_authoring_revision(operation_id,tenant_id,brand_id,revision,configuration_version_id,actor_id,audit_id,source_digest,recorded_at)
    DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE bop_tenant.brand_configuration_authoring_revision
  ADD CONSTRAINT brand_configuration_revision_operation_fk FOREIGN KEY (operation_id,tenant_id,brand_id,revision,configuration_version_id,actor_id,audit_id,source_digest,recorded_at)
    REFERENCES bop_tenant.brand_configuration_authoring_operation(operation_id,tenant_id,brand_id,result_revision,result_configuration_version_id,actor_id,audit_id,result_source_digest,occurred_at)
    DEFERRABLE INITIALLY DEFERRED;

-- The old immutable 22-column table is materialized only at Publish. Draft and
-- lifecycle revisions are independent append-only records, never updates to 010.
CREATE FUNCTION bop_tenant.brand_configuration_authoring_insert_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE previous bop_tenant.brand_configuration_authoring_revision%ROWTYPE;
  legacy bop_tenant.brand_configuration_version%ROWTYPE;
  body jsonb;
  config jsonb;
  publishing jsonb;
  item jsonb;
  actual_brand_version bigint;
  expected_head jsonb;
  editable jsonb;
  seen text[];
  field text;
  state text;
  instant_value text;
  calendar_year integer;
  uuid_pattern CONSTANT text:='^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  instant_pattern CONSTANT text:='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$';
BEGIN
  IF TG_TABLE_SCHEMA<>'bop_tenant' OR TG_TABLE_NAME NOT IN ('brand_configuration_authoring_revision','brand_configuration_authoring_operation')
    OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
    OR current_setting('transaction_isolation')<>'read committed'
    OR (NEW.tenant_id::text=current_setting('bop.tenant_id',true) AND NEW.brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS NOT TRUE THEN
    RAISE EXCEPTION 'BRAND_CONFIGURATION_SCOPE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  -- Normal owners acquire these in order before Brand/Core. Raw writers never
  -- wait while holding a Brand/Core lock acquired in the opposite order.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('BrandConfigurationOriginal:'||NEW.operation_id::text,0))
    OR NOT pg_try_advisory_xact_lock(hashtextextended('BrandConfigurationSource:'||NEW.tenant_id::text||':'||NEW.brand_id::text,0)) THEN
    RAISE EXCEPTION 'BRAND_CONFIGURATION_ADMISSION_BUSY' USING ERRCODE='55P03';
  END IF;
  SELECT version INTO actual_brand_version FROM bop_tenant.brand WHERE brand_id=NEW.brand_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BRAND_CONFIGURATION_BRAND_UNAVAILABLE' USING ERRCODE='55000'; END IF;
  IF TG_TABLE_NAME='brand_configuration_authoring_revision' THEN
    body:=NEW.snapshot_json;
    IF jsonb_typeof(body) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(body))<>17
      OR NOT body ?& ARRAY['profile','tenantReference','brandReference','actorReference','revision','brandVersion','command','operationReference','configuration','submittedByReference','publishing','contentDigest','sourceDigest','auditReference','createdAt','recordedAt','dataClassification']
      OR body->>'profile' IS DISTINCT FROM 'TenantBrandConfigurationRevisionV1'
      OR body->>'tenantReference' IS DISTINCT FROM NEW.tenant_id::text OR body->>'brandReference' IS DISTINCT FROM NEW.brand_id::text
      OR body->>'actorReference' IS DISTINCT FROM NEW.actor_id::text OR body->'revision' IS DISTINCT FROM to_jsonb(NEW.revision)
      OR body->'brandVersion' IS DISTINCT FROM to_jsonb(NEW.brand_version) OR NEW.brand_version<>actual_brand_version
      OR body->>'command' IS DISTINCT FROM NEW.command_type OR body->>'operationReference' IS DISTINCT FROM NEW.operation_id::text
      OR body->>'contentDigest' IS DISTINCT FROM NEW.content_digest OR body->>'sourceDigest' IS DISTINCT FROM NEW.source_digest
      OR body->>'auditReference' IS DISTINCT FROM NEW.audit_id::text OR body->>'dataClassification' IS DISTINCT FROM NEW.data_classification
      OR body->>'createdAt' IS DISTINCT FROM to_char(NEW.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      OR body->>'recordedAt' IS DISTINCT FROM to_char(NEW.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN
      RAISE EXCEPTION 'BRAND_CONFIGURATION_REVISION_INVALID' USING ERRCODE='23514';
    END IF;
    config:=body->'configuration';
    IF jsonb_typeof(config) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(config))<>22
      OR NOT config ?& ARRAY['configurationVersionReference','brandReference','configurationVersion','lifecycle','defaultLocale','supportedLocales','mediaThemeReference','catalogSourceReference','platformTemplateReference','overrideAllowedFieldCodes','hardRequirementFieldCodes','effectiveFrom','effectiveUntil','supersedesVersionReference','reasonCode','authoredByReference','approvedByReference','approvalEvidenceReference','publicationReference','createdAt','updatedAt','dataClassification'] THEN
      RAISE EXCEPTION 'BRAND_CONFIGURATION_CONTENT_INVALID' USING ERRCODE='23514';
    END IF;
    state:=CASE NEW.command_type WHEN 'SaveConfigurationDraft' THEN 'Draft' WHEN 'SubmitConfiguration' THEN 'PendingApproval' WHEN 'ApproveConfiguration' THEN 'Approved' ELSE 'Published' END;
    IF config->>'configurationVersionReference' IS DISTINCT FROM NEW.configuration_version_id::text
      OR config->>'brandReference' IS DISTINCT FROM NEW.brand_id::text OR config->'configurationVersion' IS DISTINCT FROM to_jsonb(NEW.configuration_version)
      OR config->>'lifecycle' IS DISTINCT FROM state OR config->>'updatedAt' IS DISTINCT FROM body->>'recordedAt'
      OR config->>'dataClassification' IS DISTINCT FROM 'ConfigurationMetadata'
      OR (jsonb_typeof(config->'createdAt')='string' AND config->>'createdAt' ~ instant_pattern AND config->>'createdAt'<=config->>'updatedAt') IS NOT TRUE
      OR (jsonb_typeof(config->'effectiveFrom')='string' AND config->>'effectiveFrom' ~ instant_pattern) IS NOT TRUE
      OR (config->'effectiveUntil'='null'::jsonb OR (jsonb_typeof(config->'effectiveUntil')='string' AND config->>'effectiveUntil' ~ instant_pattern AND config->>'effectiveUntil'>config->>'effectiveFrom')) IS NOT TRUE
      OR (jsonb_typeof(config->'defaultLocale')='string' AND config->>'defaultLocale' ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|[0-9]{3})$') IS NOT TRUE
      OR jsonb_typeof(config->'supportedLocales') IS DISTINCT FROM 'array' OR jsonb_typeof(config->'overrideAllowedFieldCodes') IS DISTINCT FROM 'array' OR jsonb_typeof(config->'hardRequirementFieldCodes') IS DISTINCT FROM 'array'
      OR (jsonb_typeof(config->'reasonCode')='string' AND config->>'reasonCode' ~ '^[A-Z][A-Z0-9_.:-]{0,63}$') IS NOT TRUE THEN
      RAISE EXCEPTION 'BRAND_CONFIGURATION_CONTENT_INVALID' USING ERRCODE='23514';
    END IF;
    FOREACH field IN ARRAY ARRAY['catalogSourceReference','platformTemplateReference','authoredByReference'] LOOP
      IF (jsonb_typeof(config->field)='string' AND config->>field ~ uuid_pattern) IS NOT TRUE THEN
        RAISE EXCEPTION 'BRAND_CONFIGURATION_REFERENCE_INVALID' USING ERRCODE='23514';
      END IF;
    END LOOP;
    FOREACH field IN ARRAY ARRAY['mediaThemeReference','supersedesVersionReference','approvedByReference','approvalEvidenceReference','publicationReference'] LOOP
      IF (config->field='null'::jsonb OR (jsonb_typeof(config->field)='string' AND config->>field ~ uuid_pattern)) IS NOT TRUE THEN
        RAISE EXCEPTION 'BRAND_CONFIGURATION_REFERENCE_INVALID' USING ERRCODE='23514';
      END IF;
    END LOOP;
    IF (NEW.configuration_version=1) IS DISTINCT FROM (config->'supersedesVersionReference'='null'::jsonb)
      OR (config->'approvedByReference'='null'::jsonb) IS DISTINCT FROM (config->'approvalEvidenceReference'='null'::jsonb)
      OR (state IN ('Draft','PendingApproval')) IS DISTINCT FROM (config->'approvedByReference'='null'::jsonb)
      OR (state='Published') IS DISTINCT FROM (config->'publicationReference'<>'null'::jsonb)
      OR (config->'approvedByReference'<>'null'::jsonb AND config->>'approvedByReference'=config->>'authoredByReference') THEN
      RAISE EXCEPTION 'BRAND_CONFIGURATION_STATE_INVALID' USING ERRCODE='23514';
    END IF;
    FOREACH field IN ARRAY ARRAY['createdAt','effectiveFrom','effectiveUntil'] LOOP
      IF config->field<>'null'::jsonb THEN
        instant_value:=config->>field;
        calendar_year:=substring(instant_value,1,4)::integer;
        -- The pure UTC contract includes year zero; its Gregorian calendar is
        -- checked with the equivalent 400-year surrogate, without inventing a
        -- historical PostgreSQL server timestamp or a Published record.
        BEGIN
          PERFORM make_date(CASE WHEN calendar_year=0 THEN 400 ELSE calendar_year END,
            substring(instant_value,6,2)::integer,substring(instant_value,9,2)::integer);
        EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
          RAISE EXCEPTION 'BRAND_CONFIGURATION_INSTANT_INVALID' USING ERRCODE='23514';
        END;
        IF substring(instant_value,12,2)::integer>23 OR substring(instant_value,15,2)::integer>59
          OR substring(instant_value,18,2)::integer>59 THEN
          RAISE EXCEPTION 'BRAND_CONFIGURATION_INSTANT_INVALID' USING ERRCODE='23514';
        END IF;
      END IF;
    END LOOP;
    FOREACH field IN ARRAY ARRAY['supportedLocales','overrideAllowedFieldCodes','hardRequirementFieldCodes'] LOOP
      seen:=ARRAY[]::text[];
      IF jsonb_array_length(config->field)>(CASE WHEN field='supportedLocales' THEN 20 ELSE 100 END)
        OR (field='supportedLocales' AND jsonb_array_length(config->field)=0) THEN
        RAISE EXCEPTION 'BRAND_CONFIGURATION_FIELDS_INVALID' USING ERRCODE='23514';
      END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(config->field) LOOP
        IF jsonb_typeof(item) IS DISTINCT FROM 'string' OR item#>>'{}'=ANY(seen)
          OR (CASE WHEN field='supportedLocales' THEN item#>>'{}' ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|[0-9]{3})$'
            ELSE item#>>'{}' ~ '^[A-Z][A-Z0-9_.:-]{0,63}$' END) IS NOT TRUE THEN
          RAISE EXCEPTION 'BRAND_CONFIGURATION_FIELDS_INVALID' USING ERRCODE='23514';
        END IF;
        seen:=array_append(seen,item#>>'{}');
      END LOOP;
    END LOOP;
    IF NOT (config->'supportedLocales') ? (config->>'defaultLocale')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(config->'overrideAllowedFieldCodes') a(value)
        JOIN jsonb_array_elements_text(config->'hardRequirementFieldCodes') b(value) USING(value)) THEN
      RAISE EXCEPTION 'BRAND_CONFIGURATION_FIELDS_INVALID' USING ERRCODE='23514';
    END IF;
    publishing:=body->'publishing';
    IF NEW.command_type='SaveConfigurationDraft' THEN
      IF publishing IS DISTINCT FROM 'null'::jsonb OR body->'submittedByReference' IS DISTINCT FROM 'null'::jsonb
        OR config->>'authoredByReference' IS DISTINCT FROM NEW.actor_id::text THEN
        RAISE EXCEPTION 'BRAND_CONFIGURATION_DRAFT_INVALID' USING ERRCODE='23514';
      END IF;
    ELSE
      IF jsonb_typeof(publishing) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(publishing))<>7
        OR NOT publishing ?& ARRAY['familyReference','lifecycleReference','lifecycleVersion','mutationOperationReference','validationEvidenceReference','approvalEvidenceReference','publicationReference']
        OR (jsonb_typeof(body->'submittedByReference')='string' AND body->>'submittedByReference' ~ uuid_pattern) IS NOT TRUE
        OR publishing->>'mutationOperationReference' IS DISTINCT FROM NEW.operation_id::text
        OR (jsonb_typeof(publishing->'lifecycleVersion')='number' AND (publishing->>'lifecycleVersion')::numeric BETWEEN 2 AND 2147483647
          AND trunc((publishing->>'lifecycleVersion')::numeric)=(publishing->>'lifecycleVersion')::numeric) IS NOT TRUE
        OR publishing->'approvalEvidenceReference' IS DISTINCT FROM config->'approvalEvidenceReference'
        OR publishing->'publicationReference' IS DISTINCT FROM config->'publicationReference' THEN
        RAISE EXCEPTION 'BRAND_CONFIGURATION_PUBLISHING_INVALID' USING ERRCODE='23514';
      END IF;
      FOREACH field IN ARRAY ARRAY['familyReference','lifecycleReference','mutationOperationReference','validationEvidenceReference'] LOOP
        IF (jsonb_typeof(publishing->field)='string' AND publishing->>field ~ uuid_pattern) IS NOT TRUE THEN
          RAISE EXCEPTION 'BRAND_CONFIGURATION_PUBLISHING_INVALID' USING ERRCODE='23514';
        END IF;
      END LOOP;
      IF (NEW.command_type='SubmitConfiguration' AND body->>'submittedByReference' IS DISTINCT FROM NEW.actor_id::text)
        OR (NEW.command_type='ApproveConfiguration' AND (config->>'approvedByReference' IS DISTINCT FROM NEW.actor_id::text
          OR body->>'submittedByReference'=NEW.actor_id::text OR config->>'authoredByReference'=NEW.actor_id::text)) THEN
        RAISE EXCEPTION 'BRAND_CONFIGURATION_INDEPENDENCE_INVALID' USING ERRCODE='23514';
      END IF;
    END IF;
    SELECT * INTO previous FROM bop_tenant.brand_configuration_authoring_revision
      WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id ORDER BY revision DESC LIMIT 1;
    IF previous.operation_id IS NULL THEN
      SELECT * INTO legacy FROM bop_tenant.brand_configuration_version WHERE brand_id=NEW.brand_id ORDER BY configuration_version DESC LIMIT 1;
      IF NEW.revision<>1 OR NEW.command_type<>'SaveConfigurationDraft' OR NEW.created_at<>NEW.recorded_at
        OR NEW.configuration_version<>COALESCE(legacy.configuration_version,0)+1
        OR config->'supersedesVersionReference' IS DISTINCT FROM COALESCE(to_jsonb(legacy.configuration_version_id::text),'null'::jsonb) THEN
        RAISE EXCEPTION 'BRAND_CONFIGURATION_INITIAL_CONFLICT' USING ERRCODE='23514';
      END IF;
    ELSE
      IF NEW.revision::bigint<>previous.revision::bigint+1 OR NEW.created_at<>previous.created_at OR NEW.recorded_at<previous.recorded_at THEN
        RAISE EXCEPTION 'BRAND_CONFIGURATION_REVISION_CONFLICT' USING ERRCODE='23514';
      END IF;
      SELECT * INTO legacy FROM bop_tenant.brand_configuration_version WHERE brand_id=NEW.brand_id ORDER BY configuration_version DESC LIMIT 1;
      IF legacy.configuration_version>previous.configuration_version
        OR (legacy.configuration_version=previous.configuration_version AND legacy.configuration_version_id<>previous.configuration_version_id) THEN
        RAISE EXCEPTION 'BRAND_CONFIGURATION_LEGACY_HEAD_CONFLICT' USING ERRCODE='23514';
      END IF;
      IF NEW.command_type='SaveConfigurationDraft' THEN
        IF NEW.configuration_version<>previous.configuration_version+1 OR NEW.configuration_version_id=previous.configuration_version_id
          OR config->>'supersedesVersionReference' IS DISTINCT FROM previous.configuration_version_id::text THEN
          RAISE EXCEPTION 'BRAND_CONFIGURATION_DRAFT_CONFLICT' USING ERRCODE='23514';
        END IF;
      ELSE
        IF previous.command_type IS DISTINCT FROM (CASE NEW.command_type WHEN 'SubmitConfiguration' THEN 'SaveConfigurationDraft' WHEN 'ApproveConfiguration' THEN 'SubmitConfiguration' ELSE 'ApproveConfiguration' END)
          OR NEW.configuration_version_id<>previous.configuration_version_id OR NEW.configuration_version<>previous.configuration_version
          OR NEW.content_digest<>previous.content_digest
          OR (config-ARRAY['lifecycle','approvedByReference','approvalEvidenceReference','publicationReference','updatedAt']) IS DISTINCT FROM
            ((previous.snapshot_json->'configuration')-ARRAY['lifecycle','approvedByReference','approvalEvidenceReference','publicationReference','updatedAt']) THEN
          RAISE EXCEPTION 'BRAND_CONFIGURATION_TRANSITION_CONFLICT' USING ERRCODE='23514';
        END IF;
        IF NEW.command_type IN ('ApproveConfiguration','PublishConfiguration') AND (
          body->'submittedByReference' IS DISTINCT FROM previous.snapshot_json->'submittedByReference'
          OR (publishing-ARRAY['lifecycleVersion','mutationOperationReference','approvalEvidenceReference','publicationReference']) IS DISTINCT FROM
            ((previous.snapshot_json->'publishing')-ARRAY['lifecycleVersion','mutationOperationReference','approvalEvidenceReference','publicationReference'])
          OR (publishing->>'lifecycleVersion')::bigint<>(previous.snapshot_json->'publishing'->>'lifecycleVersion')::bigint+1
          OR (NEW.command_type='PublishConfiguration' AND (config-ARRAY['lifecycle','publicationReference','updatedAt']) IS DISTINCT FROM
            ((previous.snapshot_json->'configuration')-ARRAY['lifecycle','publicationReference','updatedAt']))
        ) THEN RAISE EXCEPTION 'BRAND_CONFIGURATION_PUBLISHING_CONFLICT' USING ERRCODE='23514'; END IF;
      END IF;
    END IF;
  ELSE
    body:=NEW.receipt_json;
    expected_head:=CASE WHEN NEW.expected_revision IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('revision',NEW.expected_revision,'configurationVersionReference',NEW.expected_configuration_version_id,'sourceDigest',NEW.expected_source_digest) END;
    IF jsonb_typeof(body) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(body))<>16
      OR NOT body ?& ARRAY['profile','tenantReference','brandReference','actorReference','command','operationReference','expectedBrandVersion','expectedHead','purposeCode','intentDigest','originalCommand','snapshot','outcome','auditReference','occurredAt','dataClassification']
      OR body->>'profile' IS DISTINCT FROM 'TenantBrandConfigurationOperationV1' OR body->>'tenantReference' IS DISTINCT FROM NEW.tenant_id::text
      OR body->>'brandReference' IS DISTINCT FROM NEW.brand_id::text OR body->>'actorReference' IS DISTINCT FROM NEW.actor_id::text
      OR body->>'command' IS DISTINCT FROM NEW.command_type OR body->>'operationReference' IS DISTINCT FROM NEW.operation_id::text
      OR body->'expectedBrandVersion' IS DISTINCT FROM to_jsonb(NEW.expected_brand_version) OR body->'expectedHead' IS DISTINCT FROM expected_head
      OR body->>'purposeCode' IS DISTINCT FROM 'BRAND_CONFIGURATION' OR body->>'intentDigest' IS DISTINCT FROM NEW.intent_digest
      OR body->>'outcome' IS DISTINCT FROM NEW.outcome OR body->>'auditReference' IS DISTINCT FROM NEW.audit_id::text
      OR body->>'occurredAt' IS DISTINCT FROM to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      OR body->>'dataClassification' IS DISTINCT FROM NEW.data_classification THEN
      RAISE EXCEPTION 'BRAND_CONFIGURATION_RECEIPT_INVALID' USING ERRCODE='23514';
    END IF;
    IF NEW.outcome='Abandoned' THEN
      IF body->'originalCommand' IS DISTINCT FROM 'null'::jsonb OR body->'snapshot' IS DISTINCT FROM 'null'::jsonb THEN
        RAISE EXCEPTION 'BRAND_CONFIGURATION_ABANDONED_INVALID' USING ERRCODE='23514';
      END IF;
    ELSE
      IF NEW.expected_brand_version<>actual_brand_version OR body->'originalCommand' IS DISTINCT FROM NEW.command_json
        OR jsonb_typeof(NEW.command_json) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(NEW.command_json))<>11
        OR NOT NEW.command_json ?& ARRAY['profile','tenantReference','brandReference','actorReference','command','operationReference','expectedBrandVersion','expectedHead','purposeCode','configuration','reviewValidUntil']
        OR NEW.command_json->>'profile' IS DISTINCT FROM 'TenantBrandConfigurationCommandV1'
        OR (NEW.command_json-ARRAY['profile','configuration','reviewValidUntil']) IS DISTINCT FROM (body-ARRAY['profile','intentDigest','originalCommand','snapshot','outcome','auditReference','occurredAt','dataClassification']) THEN
        RAISE EXCEPTION 'BRAND_CONFIGURATION_COMMAND_INVALID' USING ERRCODE='23514';
      END IF;
      IF NEW.command_type='SaveConfigurationDraft' THEN
        editable:=NEW.command_json->'configuration';
        IF jsonb_typeof(editable) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(editable))<>10
          OR NOT editable ?& ARRAY['defaultLocale','supportedLocales','mediaThemeReference','catalogSourceReference','platformTemplateReference','overrideAllowedFieldCodes','hardRequirementFieldCodes','effectiveFrom','effectiveUntil','reasonCode']
          OR editable IS DISTINCT FROM ((body->'snapshot'->'configuration')-ARRAY['configurationVersionReference','brandReference','configurationVersion','lifecycle','supersedesVersionReference','authoredByReference','approvedByReference','approvalEvidenceReference','publicationReference','createdAt','updatedAt','dataClassification']) THEN
          RAISE EXCEPTION 'BRAND_CONFIGURATION_EDITABLE_INVALID' USING ERRCODE='23514';
        END IF;
      ELSIF NEW.command_json->'configuration' IS DISTINCT FROM 'null'::jsonb THEN
        RAISE EXCEPTION 'BRAND_CONFIGURATION_STAGE_INPUT_INVALID' USING ERRCODE='23514';
      END IF;
      IF NEW.command_type='SubmitConfiguration' THEN
        IF jsonb_typeof(NEW.command_json->'reviewValidUntil') IS DISTINCT FROM 'string'
          OR (NEW.command_json->>'reviewValidUntil' ~ instant_pattern) IS NOT TRUE THEN
          RAISE EXCEPTION 'BRAND_CONFIGURATION_REVIEW_EXPIRY_INVALID' USING ERRCODE='23514';
        END IF;
        instant_value:=NEW.command_json->>'reviewValidUntil';
        calendar_year:=substring(instant_value,1,4)::integer;
        BEGIN
          PERFORM make_date(CASE WHEN calendar_year=0 THEN 400 ELSE calendar_year END,
            substring(instant_value,6,2)::integer,substring(instant_value,9,2)::integer);
        EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
          RAISE EXCEPTION 'BRAND_CONFIGURATION_REVIEW_EXPIRY_INVALID' USING ERRCODE='23514';
        END;
        IF substring(instant_value,12,2)::integer>23 OR substring(instant_value,15,2)::integer>59
          OR substring(instant_value,18,2)::integer>59
          OR (instant_value>(body#>>'{snapshot,recordedAt}')) IS NOT TRUE
          OR ((body#>'{snapshot,configuration,effectiveUntil}')<>'null'::jsonb
            AND instant_value>(body#>>'{snapshot,configuration,effectiveUntil}')) THEN
          RAISE EXCEPTION 'BRAND_CONFIGURATION_REVIEW_EXPIRY_INVALID' USING ERRCODE='23514';
        END IF;
      ELSIF NEW.command_json->'reviewValidUntil' IS DISTINCT FROM 'null'::jsonb THEN
        RAISE EXCEPTION 'BRAND_CONFIGURATION_REVIEW_EXPIRY_INVALID' USING ERRCODE='23514';
      END IF;
      IF NEW.expected_revision IS NOT NULL AND NOT EXISTS(SELECT 1 FROM bop_tenant.brand_configuration_authoring_revision
        WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND revision=NEW.expected_revision AND configuration_version_id=NEW.expected_configuration_version_id AND source_digest=NEW.expected_source_digest) THEN
        RAISE EXCEPTION 'BRAND_CONFIGURATION_EXPECTED_HEAD_INVALID' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_tenant.brand_configuration_authoring_insert_guard() FROM PUBLIC;
CREATE TRIGGER brand_configuration_revision_insert_guard BEFORE INSERT ON bop_tenant.brand_configuration_authoring_revision
  FOR EACH ROW EXECUTE FUNCTION bop_tenant.brand_configuration_authoring_insert_guard();
CREATE TRIGGER brand_configuration_operation_insert_guard BEFORE INSERT ON bop_tenant.brand_configuration_authoring_operation
  FOR EACH ROW EXECUTE FUNCTION bop_tenant.brand_configuration_authoring_insert_guard();

CREATE FUNCTION bop_tenant.brand_configuration_authoring_coherent() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE original bop_tenant.brand_configuration_authoring_operation%ROWTYPE;
  source bop_tenant.brand_configuration_authoring_revision%ROWTYPE;
  materialized jsonb;
  current_xid xid;
  actual_brand_version bigint;
BEGIN
  current_xid:=mod(pg_current_xact_id()::text::numeric,4294967296)::text::xid;
  IF TG_TABLE_SCHEMA<>'bop_tenant' OR TG_TABLE_NAME NOT IN ('brand_configuration_authoring_revision','brand_configuration_authoring_operation')
    OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
    OR (NEW.tenant_id::text=current_setting('bop.tenant_id',true) AND NEW.brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS NOT TRUE THEN
    RAISE EXCEPTION 'BRAND_CONFIGURATION_SCOPE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  SELECT * INTO original FROM bop_tenant.brand_configuration_authoring_operation WHERE operation_id=NEW.operation_id AND xmin=current_xid;
  IF original.operation_id IS NULL THEN RAISE EXCEPTION 'BRAND_CONFIGURATION_ORIGINAL_MISSING' USING ERRCODE='23514'; END IF;
  SELECT * INTO source FROM bop_tenant.brand_configuration_authoring_revision WHERE operation_id=NEW.operation_id AND xmin=current_xid;
  IF original.outcome='Abandoned' THEN
    IF EXISTS(SELECT 1 FROM bop_tenant.brand_configuration_authoring_revision WHERE operation_id=original.operation_id) THEN
      RAISE EXCEPTION 'BRAND_CONFIGURATION_OPERATION_ABANDONED' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT version INTO actual_brand_version FROM bop_tenant.brand WHERE brand_id=original.brand_id;
    IF source.operation_id IS NULL OR (source.tenant_id,source.brand_id,source.revision,source.configuration_version_id,source.actor_id,source.audit_id,source.source_digest,source.recorded_at,source.command_type,source.brand_version)
      IS DISTINCT FROM (original.tenant_id,original.brand_id,original.result_revision,original.result_configuration_version_id,original.actor_id,original.audit_id,original.result_source_digest,original.occurred_at,original.command_type,original.expected_brand_version)
      OR original.receipt_json->'snapshot' IS DISTINCT FROM source.snapshot_json
      OR actual_brand_version IS DISTINCT FROM original.expected_brand_version THEN
      RAISE EXCEPTION 'BRAND_CONFIGURATION_ORIGINAL_INCOHERENT' USING ERRCODE='23514';
    END IF;
    IF source.command_type='PublishConfiguration' THEN
      SELECT jsonb_build_object('configurationVersionReference',v.configuration_version_id,'brandReference',v.brand_id,'configurationVersion',v.configuration_version,'lifecycle',v.lifecycle,
        'defaultLocale',v.default_locale,'supportedLocales',to_jsonb(v.supported_locales),'mediaThemeReference',v.media_theme_reference,'catalogSourceReference',v.catalog_source_reference,'platformTemplateReference',v.platform_template_reference,
        'overrideAllowedFieldCodes',to_jsonb(v.override_allowed_field_codes),'hardRequirementFieldCodes',to_jsonb(v.hard_requirement_field_codes),'effectiveFrom',to_char(v.effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'effectiveUntil',CASE WHEN v.effective_until IS NULL THEN NULL ELSE to_char(v.effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,'supersedesVersionReference',v.supersedes_version_reference,
        'reasonCode',v.reason_code,'authoredByReference',v.authored_by_reference,'approvedByReference',v.approved_by_reference,'approvalEvidenceReference',v.approval_evidence_reference,'publicationReference',v.publication_reference,
        'createdAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'updatedAt',to_char(v.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'dataClassification',v.data_classification)
        INTO materialized FROM bop_tenant.brand_configuration_version v
        WHERE v.brand_id=source.brand_id AND v.configuration_version_id=source.configuration_version_id AND v.xmin=current_xid
          AND v.created_at=date_trunc('milliseconds',v.created_at) AND v.updated_at=date_trunc('milliseconds',v.updated_at)
          AND v.effective_from=date_trunc('milliseconds',v.effective_from) AND (v.effective_until IS NULL OR v.effective_until=date_trunc('milliseconds',v.effective_until));
      IF materialized IS DISTINCT FROM source.snapshot_json->'configuration' THEN
        RAISE EXCEPTION 'BRAND_CONFIGURATION_PUBLICATION_INCOHERENT' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_tenant.brand_configuration_authoring_coherent() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER brand_configuration_revision_coherence AFTER INSERT ON bop_tenant.brand_configuration_authoring_revision
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_tenant.brand_configuration_authoring_coherent();
CREATE CONSTRAINT TRIGGER brand_configuration_operation_coherence AFTER INSERT ON bop_tenant.brand_configuration_authoring_operation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_tenant.brand_configuration_authoring_coherent();
CREATE TRIGGER brand_configuration_revision_no_mutation BEFORE UPDATE OR DELETE ON bop_tenant.brand_configuration_authoring_revision
  FOR EACH ROW EXECUTE FUNCTION bop_tenant.reject_brand_admin_history_update();
CREATE TRIGGER brand_configuration_operation_no_mutation BEFORE UPDATE OR DELETE ON bop_tenant.brand_configuration_authoring_operation
  FOR EACH ROW EXECUTE FUNCTION bop_tenant.reject_brand_admin_history_update();
CREATE TRIGGER brand_configuration_revision_no_truncate BEFORE TRUNCATE ON bop_tenant.brand_configuration_authoring_revision
  FOR EACH STATEMENT EXECUTE FUNCTION bop_tenant.reject_brand_admin_history_update();
CREATE TRIGGER brand_configuration_operation_no_truncate BEFORE TRUNCATE ON bop_tenant.brand_configuration_authoring_operation
  FOR EACH STATEMENT EXECUTE FUNCTION bop_tenant.reject_brand_admin_history_update();
ALTER TABLE bop_tenant.brand_configuration_authoring_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.brand_configuration_authoring_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.brand_configuration_authoring_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.brand_configuration_authoring_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY brand_configuration_revision_scope ON bop_tenant.brand_configuration_authoring_revision
  USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE)
  WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE);
CREATE POLICY brand_configuration_operation_scope ON bop_tenant.brand_configuration_authoring_operation
  USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE)
  WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE);
REVOKE ALL ON TABLE bop_tenant.brand_configuration_authoring_revision FROM PUBLIC;
REVOKE ALL ON TABLE bop_tenant.brand_configuration_authoring_operation FROM PUBLIC;
