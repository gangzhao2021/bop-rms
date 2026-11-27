-- bop-rms-migration: 1
-- owner: @rms/pricing
-- schema: rms_pricing
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix

CREATE TABLE rms_pricing.tax_config_material (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  material_id platform_helpers.uuid_v7 PRIMARY KEY,
  material_kind text NOT NULL CHECK (material_kind IN ('RegistrationApplicability','ProfessionalReport','FixtureSuite')),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  current_version_id platform_helpers.uuid_v7 NOT NULL,
  created_at timestamptz NOT NULL CHECK (isfinite(created_at) AND date_trunc('milliseconds',created_at)=created_at),
  updated_at timestamptz NOT NULL CHECK (isfinite(updated_at) AND date_trunc('milliseconds',updated_at)=updated_at AND updated_at>=created_at),
  data_classification text NOT NULL CHECK (data_classification='Confidential'),
  CONSTRAINT tax_config_material_scope_unique UNIQUE (tenant_id,brand_id,store_id,material_id,material_kind)
);
CREATE TABLE rms_pricing.tax_config_material_version (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  material_id platform_helpers.uuid_v7 NOT NULL,
  version_id platform_helpers.uuid_v7 PRIMARY KEY,
  material_kind text NOT NULL CHECK (material_kind IN ('RegistrationApplicability','ProfessionalReport','FixtureSuite')),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  previous_version_id platform_helpers.uuid_v7,
  operation_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  version_json jsonb NOT NULL CHECK (jsonb_typeof(version_json)='object' AND octet_length(version_json::text)<=2097152),
  version_text text NOT NULL CHECK (octet_length(version_text)<=1056768 AND version_text::jsonb=version_json),
  version_digest text NOT NULL CHECK (version_digest='sha256:'||encode(sha256(convert_to(version_text,'UTF8')),'hex')),
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND date_trunc('milliseconds',recorded_at)=recorded_at),
  data_classification text NOT NULL CHECK (data_classification='Confidential'),
  CONSTRAINT tax_config_material_version_revision_unique UNIQUE (material_id,revision),
  CONSTRAINT tax_config_material_version_scope_unique UNIQUE (version_id,tenant_id,brand_id,store_id,material_id,material_kind,revision),
  CONSTRAINT tax_config_material_version_root_fk FOREIGN KEY (tenant_id,brand_id,store_id,material_id,material_kind)
    REFERENCES rms_pricing.tax_config_material(tenant_id,brand_id,store_id,material_id,material_kind) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT tax_config_material_version_parent_fk FOREIGN KEY (previous_version_id) REFERENCES rms_pricing.tax_config_material_version(version_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT tax_config_material_version_parent_check CHECK ((revision=1 AND previous_version_id IS NULL) OR (revision>1 AND previous_version_id IS NOT NULL))
);
CREATE TABLE rms_pricing.tax_config_material_operation (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  action_code text NOT NULL CHECK (action_code IN ('CreateMaterial','ReplaceMaterial')),
  requested_material_id platform_helpers.uuid_v7,
  expected_revision integer,
  material_kind text NOT NULL CHECK (material_kind IN ('RegistrationApplicability','ProfessionalReport','FixtureSuite')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[a-f0-9]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('Committed','Abandoned')),
  result_material_id platform_helpers.uuid_v7,
  result_version_id platform_helpers.uuid_v7,
  result_revision integer,
  receipt_json jsonb NOT NULL CHECK (jsonb_typeof(receipt_json)='object' AND octet_length(receipt_json::text)<=4194304),
  receipt_text text NOT NULL CHECK (octet_length(receipt_text)<=3145728 AND receipt_text::jsonb=receipt_json),
  receipt_digest text NOT NULL CHECK (receipt_digest='sha256:'||encode(sha256(convert_to(receipt_text,'UTF8')),'hex')),
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  audit_json jsonb NOT NULL CHECK (jsonb_typeof(audit_json)='object' AND octet_length(audit_json::text)<=65536),
  event_id platform_helpers.uuid_v7 UNIQUE,
  occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND date_trunc('milliseconds',occurred_at)=occurred_at),
  data_classification text NOT NULL CHECK (data_classification='Confidential'),
  CONSTRAINT tax_config_material_operation_requested_check CHECK (
    (action_code='CreateMaterial' AND requested_material_id IS NULL AND expected_revision IS NULL)
    OR (action_code='ReplaceMaterial' AND requested_material_id IS NOT NULL AND expected_revision IS NOT NULL AND expected_revision BETWEEN 1 AND 2147483646)
  ),
  CONSTRAINT tax_config_material_operation_terminal_check CHECK (
    (outcome='Committed' AND result_material_id IS NOT NULL AND result_version_id IS NOT NULL AND result_revision IS NOT NULL AND result_revision BETWEEN 1 AND 2147483647 AND event_id IS NOT NULL)
    OR (outcome='Abandoned' AND result_material_id IS NULL AND result_version_id IS NULL AND result_revision IS NULL AND event_id IS NULL)
  ),
  CONSTRAINT tax_config_material_operation_result_fk FOREIGN KEY (result_version_id,tenant_id,brand_id,store_id,result_material_id,material_kind,result_revision)
    REFERENCES rms_pricing.tax_config_material_version(version_id,tenant_id,brand_id,store_id,material_id,material_kind,revision) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE rms_pricing.tax_config_material_version ADD CONSTRAINT tax_config_material_version_operation_fk
  FOREIGN KEY (operation_id) REFERENCES rms_pricing.tax_config_material_operation(operation_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE rms_pricing.tax_config_material ADD CONSTRAINT tax_config_material_current_version_fk
  FOREIGN KEY (current_version_id,tenant_id,brand_id,store_id,material_id,material_kind,revision)
  REFERENCES rms_pricing.tax_config_material_version(version_id,tenant_id,brand_id,store_id,material_id,material_kind,revision) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX tax_config_material_scope_roster_idx ON rms_pricing.tax_config_material(tenant_id,brand_id,store_id,material_kind,material_id);

CREATE FUNCTION rms_pricing.tax_config_material_scope_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE op uuid; material uuid;
BEGIN
  IF NEW.tenant_id::text IS DISTINCT FROM nullif(current_setting('bop.tenant_id',true),'') OR NEW.brand_id IS DISTINCT FROM platform_helpers.current_brand_id() OR NEW.store_id IS DISTINCT FROM platform_helpers.current_store_id() OR current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'Tax material scope unavailable' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME='tax_config_material_operation' THEN
    op:=NEW.operation_id; material:=COALESCE(NEW.result_material_id,NEW.requested_material_id);
  ELSIF TG_TABLE_NAME='tax_config_material_version' THEN op:=NEW.operation_id; material:=NEW.material_id;
  ELSE
    material:=NEW.material_id;
    -- Root producer already holds Original before Root; do not acquire an
    -- unknown operation lock after the scoped root and invert that order.
    IF TG_OP='UPDATE' AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.brand_id IS DISTINCT FROM OLD.brand_id OR NEW.store_id IS DISTINCT FROM OLD.store_id OR NEW.material_id IS DISTINCT FROM OLD.material_id OR NEW.material_kind IS DISTINCT FROM OLD.material_kind OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id OR NEW.updated_at<OLD.updated_at) THEN
      RAISE EXCEPTION 'Tax material root transition invalid' USING ERRCODE='23514';
    END IF;
    IF TG_OP='INSERT' AND (NEW.revision<>1 OR NEW.created_at IS DISTINCT FROM NEW.updated_at) THEN RAISE EXCEPTION 'Tax material initial root invalid' USING ERRCODE='23514'; END IF;
  END IF;
  IF op IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('PricingTaxMaterialOriginal:'||op::text,0)); END IF;
  IF material IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('PricingTaxMaterialRoot:'||NEW.tenant_id::text||':'||NEW.brand_id::text||':'||NEW.store_id::text||':'||material::text,0)); END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.tax_config_material_scope_guard() FROM PUBLIC;
CREATE TRIGGER tax_config_material_root_scope BEFORE INSERT OR UPDATE ON rms_pricing.tax_config_material FOR EACH ROW EXECUTE FUNCTION rms_pricing.tax_config_material_scope_guard();
CREATE TRIGGER tax_config_material_version_scope BEFORE INSERT ON rms_pricing.tax_config_material_version FOR EACH ROW EXECUTE FUNCTION rms_pricing.tax_config_material_scope_guard();
CREATE TRIGGER tax_config_material_operation_scope BEFORE INSERT ON rms_pricing.tax_config_material_operation FOR EACH ROW EXECUTE FUNCTION rms_pricing.tax_config_material_scope_guard();

CREATE FUNCTION rms_pricing.reject_tax_config_material_mutation() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN RAISE EXCEPTION 'immutable Tax material history' USING ERRCODE='55000'; END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.reject_tax_config_material_mutation() FROM PUBLIC;
CREATE TRIGGER tax_config_material_root_no_delete BEFORE DELETE ON rms_pricing.tax_config_material FOR EACH ROW EXECUTE FUNCTION rms_pricing.reject_tax_config_material_mutation();
CREATE TRIGGER tax_config_material_root_no_truncate BEFORE TRUNCATE ON rms_pricing.tax_config_material FOR EACH STATEMENT EXECUTE FUNCTION rms_pricing.reject_tax_config_material_mutation();
CREATE TRIGGER tax_config_material_version_no_mutation BEFORE UPDATE OR DELETE ON rms_pricing.tax_config_material_version FOR EACH ROW EXECUTE FUNCTION rms_pricing.reject_tax_config_material_mutation();
CREATE TRIGGER tax_config_material_version_no_truncate BEFORE TRUNCATE ON rms_pricing.tax_config_material_version FOR EACH STATEMENT EXECUTE FUNCTION rms_pricing.reject_tax_config_material_mutation();
CREATE TRIGGER tax_config_material_operation_no_mutation BEFORE UPDATE OR DELETE ON rms_pricing.tax_config_material_operation FOR EACH ROW EXECUTE FUNCTION rms_pricing.reject_tax_config_material_mutation();
CREATE TRIGGER tax_config_material_operation_no_truncate BEFORE TRUNCATE ON rms_pricing.tax_config_material_operation FOR EACH STATEMENT EXECUTE FUNCTION rms_pricing.reject_tax_config_material_mutation();

CREATE FUNCTION rms_pricing.tax_config_material_coherent() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE root_row record; version_row record; operation_row record; parent_row record;
  body jsonb; content jsonb; receipt jsonb; entry jsonb; fixture jsonb; expected jsonb; line jsonb; component jsonb; pin jsonb; issuer jsonb;
  instant text; validation_instant text; validation_at timestamptz;
  top_xid text:=mod(pg_current_xact_id()::text::numeric,4294967296)::text;
  uuid_pattern text:='^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  instant_pattern text:='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$';
  digest_pattern text:='^sha256:[a-f0-9]{64}$';
  minor_pattern text:='^(0|[1-9][0-9]*|-[1-9][0-9]*)$';
BEGIN
  IF NEW.tenant_id::text IS DISTINCT FROM nullif(current_setting('bop.tenant_id',true),'') OR NEW.brand_id IS DISTINCT FROM platform_helpers.current_brand_id() OR NEW.store_id IS DISTINCT FROM platform_helpers.current_store_id() THEN RAISE EXCEPTION 'Tax material coherence scope unavailable' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='tax_config_material' THEN
    SELECT * INTO root_row FROM rms_pricing.tax_config_material WHERE material_id=NEW.material_id;
    SELECT v.*,v.xmin::text AS held_xmin INTO version_row FROM rms_pricing.tax_config_material_version v WHERE v.version_id=root_row.current_version_id;
    IF version_row.version_id IS NULL OR version_row.held_xmin IS DISTINCT FROM top_xid OR version_row.tenant_id IS DISTINCT FROM root_row.tenant_id OR version_row.brand_id IS DISTINCT FROM root_row.brand_id OR version_row.store_id IS DISTINCT FROM root_row.store_id OR version_row.material_id IS DISTINCT FROM root_row.material_id OR version_row.material_kind IS DISTINCT FROM root_row.material_kind OR version_row.revision IS DISTINCT FROM root_row.revision OR version_row.recorded_at IS DISTINCT FROM root_row.updated_at OR version_row.version_json->>'createdAt' IS DISTINCT FROM to_char(root_row.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN RAISE EXCEPTION 'Tax material root source incoherent' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME='tax_config_material_operation' THEN
    receipt:=NEW.receipt_json;
    IF NOT(receipt ?& ARRAY['profile','tenantReference','brandReference','storeReference','actorReference','action','operationReference','materialReference','expectedRevision','materialKind','command','intentDigest','outcome','version','auditReference','eventReference','occurredAt']) OR (SELECT count(*) FROM jsonb_object_keys(receipt))<>17 OR receipt->>'profile' IS DISTINCT FROM 'TaxConfigMaterialOperationV1' OR receipt->>'tenantReference' IS DISTINCT FROM NEW.tenant_id::text OR receipt->>'brandReference' IS DISTINCT FROM NEW.brand_id::text OR receipt->>'storeReference' IS DISTINCT FROM NEW.store_id::text OR receipt->>'actorReference' IS DISTINCT FROM NEW.actor_id::text OR receipt->>'action' IS DISTINCT FROM NEW.action_code OR receipt->>'operationReference' IS DISTINCT FROM NEW.operation_id::text OR receipt->>'materialReference' IS DISTINCT FROM NEW.requested_material_id::text OR receipt->'expectedRevision' IS DISTINCT FROM COALESCE(to_jsonb(NEW.expected_revision),'null'::jsonb) OR receipt->>'materialKind' IS DISTINCT FROM NEW.material_kind OR receipt->>'intentDigest' IS DISTINCT FROM NEW.intent_digest OR receipt->>'outcome' IS DISTINCT FROM NEW.outcome OR receipt->>'auditReference' IS DISTINCT FROM NEW.audit_id::text OR receipt->>'eventReference' IS DISTINCT FROM NEW.event_id::text OR receipt->>'occurredAt' IS DISTINCT FROM to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN RAISE EXCEPTION 'Tax material terminal tuple incoherent' USING ERRCODE='23514'; END IF;
    IF NEW.audit_json->>'auditId' IS DISTINCT FROM NEW.audit_id::text OR NEW.audit_json->>'brandId' IS DISTINCT FROM NEW.brand_id::text OR NEW.audit_json->>'storeId' IS DISTINCT FROM NEW.store_id::text OR NEW.audit_json->'actor'->>'type' IS DISTINCT FROM 'User' OR NEW.audit_json->'actor'->>'reference' IS DISTINCT FROM NEW.actor_id::text OR NEW.audit_json->>'correlationId' IS DISTINCT FROM NEW.operation_id::text OR NEW.audit_json->>'occurredAt' IS DISTINCT FROM receipt->>'occurredAt' OR NEW.audit_json->>'dataClassification' IS DISTINCT FROM 'Confidential' THEN RAISE EXCEPTION 'Tax material audit metadata incoherent' USING ERRCODE='23514'; END IF;
    SELECT v.*,v.xmin::text AS held_xmin INTO version_row FROM rms_pricing.tax_config_material_version v WHERE v.operation_id=NEW.operation_id;
    IF NEW.outcome='Abandoned' THEN
      IF receipt->'command' IS DISTINCT FROM 'null'::jsonb OR receipt->'version' IS DISTINCT FROM 'null'::jsonb OR version_row.version_id IS NOT NULL THEN RAISE EXCEPTION 'Tax material abandoned source incoherent' USING ERRCODE='23514'; END IF;
    ELSE
      IF version_row.version_id IS NULL OR version_row.held_xmin IS DISTINCT FROM top_xid OR version_row.version_id IS DISTINCT FROM NEW.result_version_id OR version_row.material_id IS DISTINCT FROM NEW.result_material_id OR version_row.tenant_id IS DISTINCT FROM NEW.tenant_id OR version_row.brand_id IS DISTINCT FROM NEW.brand_id OR version_row.store_id IS DISTINCT FROM NEW.store_id OR version_row.actor_id IS DISTINCT FROM NEW.actor_id OR version_row.material_kind IS DISTINCT FROM NEW.material_kind OR version_row.revision IS DISTINCT FROM COALESCE(NEW.expected_revision,0)+1 OR NEW.result_revision IS DISTINCT FROM version_row.revision OR version_row.recorded_at IS DISTINCT FROM NEW.occurred_at OR receipt->'version' IS DISTINCT FROM version_row.version_json OR (NEW.action_code='ReplaceMaterial' AND NEW.requested_material_id IS DISTINCT FROM NEW.result_material_id) THEN RAISE EXCEPTION 'Tax material committed source incoherent' USING ERRCODE='23514'; END IF;
      IF jsonb_typeof(receipt->'command') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Tax material command unavailable' USING ERRCODE='23514'; END IF;
      body:=receipt->'command';
      IF NOT(body ?& ARRAY['action','operationReference','materialReference','expectedRevision','materialKind','content']) OR (SELECT count(*) FROM jsonb_object_keys(body))<>6 OR body->>'action' IS DISTINCT FROM NEW.action_code OR body->>'operationReference' IS DISTINCT FROM NEW.operation_id::text OR body->>'materialReference' IS DISTINCT FROM NEW.requested_material_id::text OR body->'expectedRevision' IS DISTINCT FROM COALESCE(to_jsonb(NEW.expected_revision),'null'::jsonb) OR body->>'materialKind' IS DISTINCT FROM NEW.material_kind OR body->'content' IS DISTINCT FROM version_row.version_json->'content' THEN RAISE EXCEPTION 'Tax material command source incoherent' USING ERRCODE='23514'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT v.*,v.xmin::text AS held_xmin INTO version_row FROM rms_pricing.tax_config_material_version v WHERE v.version_id=NEW.version_id;
  SELECT * INTO root_row FROM rms_pricing.tax_config_material WHERE material_id=NEW.material_id;
  SELECT o.*,o.xmin::text AS held_xmin INTO operation_row FROM rms_pricing.tax_config_material_operation o WHERE o.operation_id=NEW.operation_id;
  IF version_row.held_xmin IS DISTINCT FROM top_xid OR operation_row.operation_id IS NULL OR operation_row.held_xmin IS DISTINCT FROM top_xid OR operation_row.outcome IS DISTINCT FROM 'Committed' OR operation_row.result_version_id IS DISTINCT FROM NEW.version_id OR operation_row.result_material_id IS DISTINCT FROM NEW.material_id OR operation_row.result_revision IS DISTINCT FROM NEW.revision OR operation_row.tenant_id IS DISTINCT FROM NEW.tenant_id OR operation_row.brand_id IS DISTINCT FROM NEW.brand_id OR operation_row.store_id IS DISTINCT FROM NEW.store_id OR operation_row.actor_id IS DISTINCT FROM NEW.actor_id OR operation_row.material_kind IS DISTINCT FROM NEW.material_kind OR operation_row.occurred_at IS DISTINCT FROM NEW.recorded_at OR root_row.material_id IS NULL OR root_row.revision<NEW.revision THEN RAISE EXCEPTION 'Tax material version original incoherent' USING ERRCODE='23514'; END IF;
  body:=NEW.version_json;
  IF NOT(body ?& ARRAY['profile','tenantReference','brandReference','storeReference','materialReference','versionReference','revision','previousVersionReference','materialKind','content','contentDigest','recordedByActorReference','createdAt','recordedAt','dataClassification','status','qualification']) OR (SELECT count(*) FROM jsonb_object_keys(body))<>17 OR body->>'profile' IS DISTINCT FROM 'TaxConfigMaterialVersionV1' OR body->>'tenantReference' IS DISTINCT FROM NEW.tenant_id::text OR body->>'brandReference' IS DISTINCT FROM NEW.brand_id::text OR body->>'storeReference' IS DISTINCT FROM NEW.store_id::text OR body->>'materialReference' IS DISTINCT FROM NEW.material_id::text OR body->>'versionReference' IS DISTINCT FROM NEW.version_id::text OR body->'revision' IS DISTINCT FROM to_jsonb(NEW.revision) OR body->>'previousVersionReference' IS DISTINCT FROM NEW.previous_version_id::text OR body->>'materialKind' IS DISTINCT FROM NEW.material_kind OR body->>'contentDigest' IS DISTINCT FROM NEW.content_digest OR body->>'recordedByActorReference' IS DISTINCT FROM NEW.actor_id::text OR body->>'createdAt' IS DISTINCT FROM to_char(root_row.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') OR body->>'recordedAt' IS DISTINCT FROM to_char(NEW.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') OR body->>'dataClassification' IS DISTINCT FROM 'Confidential' OR body->>'status' IS DISTINCT FROM 'Recorded' OR body->>'qualification' IS DISTINCT FROM 'NotEvaluated' THEN RAISE EXCEPTION 'Tax material version tuple incoherent' USING ERRCODE='23514'; END IF;
  IF NEW.revision=1 THEN
    IF NEW.previous_version_id IS NOT NULL OR NEW.recorded_at IS DISTINCT FROM root_row.created_at THEN RAISE EXCEPTION 'Tax material initial revision incoherent' USING ERRCODE='23514'; END IF;
  ELSE
    SELECT * INTO parent_row FROM rms_pricing.tax_config_material_version WHERE version_id=NEW.previous_version_id;
    IF parent_row.version_id IS NULL OR parent_row.material_id IS DISTINCT FROM NEW.material_id OR parent_row.tenant_id IS DISTINCT FROM NEW.tenant_id OR parent_row.brand_id IS DISTINCT FROM NEW.brand_id OR parent_row.store_id IS DISTINCT FROM NEW.store_id OR parent_row.material_kind IS DISTINCT FROM NEW.material_kind OR parent_row.revision IS DISTINCT FROM NEW.revision-1 OR parent_row.recorded_at>NEW.recorded_at THEN RAISE EXCEPTION 'Tax material parent incoherent' USING ERRCODE='23514'; END IF;
  END IF;
  content:=body->'content';
  IF jsonb_typeof(content) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Tax material content unavailable' USING ERRCODE='23514'; END IF;
  IF NEW.material_kind='RegistrationApplicability' THEN
    IF (content ?& ARRAY['operatingEntityProfileVersionReference','operatingEntityTaxReference','jurisdictionCode','applicability','sourceIssuedAt','effectiveFrom','effectiveUntil','declaredSourceDigest'] AND (SELECT count(*) FROM jsonb_object_keys(content))=8 AND content->>'operatingEntityProfileVersionReference' ~ uuid_pattern AND (content->'operatingEntityTaxReference'='null'::jsonb OR content->>'operatingEntityTaxReference' ~ uuid_pattern) AND content->>'jurisdictionCode'='CA-ON' AND content->>'applicability' IN ('Applicable','NotApplicable') AND content->>'sourceIssuedAt' ~ instant_pattern AND content->>'effectiveFrom' ~ instant_pattern AND (content->'effectiveUntil'='null'::jsonb OR (content->>'effectiveUntil' ~ instant_pattern AND content->>'effectiveUntil'>content->>'effectiveFrom')) AND (content->'declaredSourceDigest'='null'::jsonb OR content->>'declaredSourceDigest' ~ digest_pattern)) IS NOT TRUE THEN RAISE EXCEPTION 'Tax registration material invalid' USING ERRCODE='23514'; END IF;
  ELSIF NEW.material_kind='ProfessionalReport' THEN
    IF (content ?& ARRAY['targetPublicationCandidate','registrationMaterial','fixtureSuiteMaterial','declaredIssuer','reviewedAt','validUntil','declaredConclusion','declaredSourceDigest'] AND (SELECT count(*) FROM jsonb_object_keys(content))=8 AND content->>'reviewedAt' ~ instant_pattern AND content->>'validUntil' ~ instant_pattern AND content->>'validUntil'>content->>'reviewedAt' AND content->>'declaredConclusion' IN ('Pass','Fail') AND (content->'declaredSourceDigest'='null'::jsonb OR content->>'declaredSourceDigest' ~ digest_pattern)) IS NOT TRUE THEN RAISE EXCEPTION 'Tax professional declaration invalid' USING ERRCODE='23514'; END IF;
    issuer:=content->'declaredIssuer';
    IF jsonb_typeof(issuer) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Tax issuer declaration invalid' USING ERRCODE='23514'; END IF;
    IF (issuer ?& ARRAY['displayName','organizationName','credentialIdentifier'] AND (SELECT count(*) FROM jsonb_object_keys(issuer))=3 AND jsonb_typeof(issuer->'displayName')='string' AND length(issuer->>'displayName') BETWEEN 1 AND 120 AND issuer->>'displayName'=btrim(issuer->>'displayName') AND issuer->>'displayName' !~ '[[:cntrl:]<>]' AND (issuer->'organizationName'='null'::jsonb OR (jsonb_typeof(issuer->'organizationName')='string' AND length(issuer->>'organizationName') BETWEEN 1 AND 160 AND issuer->>'organizationName'=btrim(issuer->>'organizationName') AND issuer->>'organizationName' !~ '[[:cntrl:]<>]')) AND (issuer->'credentialIdentifier'='null'::jsonb OR (jsonb_typeof(issuer->'credentialIdentifier')='string' AND length(issuer->>'credentialIdentifier') BETWEEN 1 AND 120 AND issuer->>'credentialIdentifier'=btrim(issuer->>'credentialIdentifier') AND issuer->>'credentialIdentifier' !~ '[[:cntrl:]<>]'))) IS NOT TRUE THEN RAISE EXCEPTION 'Tax issuer declaration invalid' USING ERRCODE='23514'; END IF;
  ELSE
    IF jsonb_typeof(content->'cases') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Tax fixture declaration invalid' USING ERRCODE='23514'; END IF;
    IF (content ?& ARRAY['targetPublicationCandidate','currencyMetadata','cases','sourceIssuedAt','declaredSourceDigest'] AND (SELECT count(*) FROM jsonb_object_keys(content))=5 AND jsonb_typeof(content->'cases')='array' AND jsonb_array_length(content->'cases') BETWEEN 1 AND 256 AND content->>'sourceIssuedAt' ~ instant_pattern AND (content->'declaredSourceDigest'='null'::jsonb OR content->>'declaredSourceDigest' ~ digest_pattern)) IS NOT TRUE THEN RAISE EXCEPTION 'Tax fixture declaration invalid' USING ERRCODE='23514'; END IF;
    issuer:=content->'currencyMetadata';
    IF jsonb_typeof(issuer) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Tax fixture currency invalid' USING ERRCODE='23514'; END IF;
    IF (issuer ?& ARRAY['currencyCode','minorUnitExponent','metadataVersion','metadataVersionReference','metadataDigest'] AND (SELECT count(*) FROM jsonb_object_keys(issuer))=5 AND issuer->>'currencyCode' ~ '^[A-Z]{3}$' AND jsonb_typeof(issuer->'minorUnitExponent')='number' AND issuer->>'minorUnitExponent' ~ '^[0-6]$' AND jsonb_typeof(issuer->'metadataVersion')='number' AND issuer->>'metadataVersion' ~ '^[1-9][0-9]{0,15}$' AND issuer->>'metadataVersionReference' ~ uuid_pattern AND issuer->>'metadataDigest' ~ digest_pattern) IS NOT TRUE THEN RAISE EXCEPTION 'Tax fixture currency invalid' USING ERRCODE='23514'; END IF;
    IF (issuer->>'metadataVersion')::numeric>9007199254740991 THEN RAISE EXCEPTION 'Tax fixture currency invalid' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.material_kind IN ('ProfessionalReport','FixtureSuite') THEN
    FOR pin IN SELECT value FROM jsonb_each(content) WHERE key IN ('targetPublicationCandidate','registrationMaterial','fixtureSuiteMaterial') LOOP
      IF jsonb_typeof(pin) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Tax material target invalid' USING ERRCODE='23514'; END IF;
      IF (pin ?& ARRAY['versionReference','contentDigest'] AND (SELECT count(*) FROM jsonb_object_keys(pin))=2 AND pin->>'versionReference' ~ uuid_pattern AND pin->>'contentDigest' ~ digest_pattern) IS NOT TRUE THEN RAISE EXCEPTION 'Tax material target invalid' USING ERRCODE='23514'; END IF;
    END LOOP;
  END IF;
  IF NEW.material_kind='FixtureSuite' THEN
    FOR entry IN SELECT value FROM jsonb_array_elements(content->'cases') LOOP
      IF jsonb_typeof(entry) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Tax fixture case invalid' USING ERRCODE='23514'; END IF;
      IF NOT(entry ?& ARRAY['fixture','expected']) OR (SELECT count(*) FROM jsonb_object_keys(entry))<>2 THEN RAISE EXCEPTION 'Tax fixture case invalid' USING ERRCODE='23514'; END IF;
      fixture:=entry->'fixture'; expected:=entry->'expected';
      IF jsonb_typeof(fixture) IS DISTINCT FROM 'object' OR jsonb_typeof(expected) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Tax fixture case invalid' USING ERRCODE='23514'; END IF;
      IF jsonb_typeof(fixture->'lines') IS DISTINCT FROM 'array' OR jsonb_typeof(expected->'receiptPreview') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Tax fixture arrays unavailable' USING ERRCODE='23514'; END IF;
      IF (fixture ?& ARRAY['profile','fixtureReference','kind','evaluatedAt','lines'] AND (SELECT count(*) FROM jsonb_object_keys(fixture))=5 AND fixture->>'profile'='TaxDraftFixtureV1' AND fixture->>'fixtureReference' ~ uuid_pattern AND fixture->>'kind' IN ('Basket','Refund') AND fixture->>'evaluatedAt' ~ instant_pattern AND jsonb_typeof(fixture->'lines')='array' AND jsonb_array_length(fixture->'lines') BETWEEN 1 AND 256) IS NOT TRUE THEN RAISE EXCEPTION 'Tax fixture input invalid' USING ERRCODE='23514'; END IF;
      IF (expected ?& ARRAY['fixtureReference','kind','configurationReference','versionReference','snapshotDigest','netAmountMinor','taxAmountMinor','grossAmountMinor','receiptPreview'] AND (SELECT count(*) FROM jsonb_object_keys(expected))=9 AND expected->>'fixtureReference'=fixture->>'fixtureReference' AND expected->>'kind'=fixture->>'kind' AND expected->>'configurationReference' ~ uuid_pattern AND expected->>'versionReference'=content->'targetPublicationCandidate'->>'versionReference' AND expected->>'snapshotDigest'=content->'targetPublicationCandidate'->>'contentDigest' AND expected->>'netAmountMinor' ~ minor_pattern AND length(expected->>'netAmountMinor')<=20 AND expected->>'taxAmountMinor' ~ minor_pattern AND length(expected->>'taxAmountMinor')<=20 AND expected->>'grossAmountMinor' ~ minor_pattern AND length(expected->>'grossAmountMinor')<=20 AND jsonb_typeof(expected->'receiptPreview')='array' AND jsonb_array_length(expected->'receiptPreview') BETWEEN 1 AND 4096) IS NOT TRUE THEN RAISE EXCEPTION 'Tax fixture expected invalid' USING ERRCODE='23514'; END IF;
      IF (expected->>'netAmountMinor')::numeric+(expected->>'taxAmountMinor')::numeric<>(expected->>'grossAmountMinor')::numeric THEN RAISE EXCEPTION 'Tax fixture declared totals invalid' USING ERRCODE='23514'; END IF;
      FOR line IN SELECT value FROM jsonb_array_elements(fixture->'lines') LOOP
        IF jsonb_typeof(line) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Tax fixture line invalid' USING ERRCODE='23514'; END IF;
        IF jsonb_typeof(line->'calculationReferences') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Tax fixture calculation reference invalid' USING ERRCODE='23514'; END IF;
        IF (line ?& ARRAY['lineReference','calculationReferences','labelCode','taxClassificationReference','orderType','chargeType','amountMinor'] AND (SELECT count(*) FROM jsonb_object_keys(line))=7 AND line->>'lineReference' ~ uuid_pattern AND line->>'labelCode' ~ '^[A-Z][A-Z0-9]*([-_][A-Z0-9]+)*$' AND length(line->>'labelCode')<=64 AND line->>'taxClassificationReference' ~ uuid_pattern AND line->>'orderType' IN ('DineIn','Pickup') AND line->>'chargeType' IN ('Sellable','ServiceCharge','DeliveryFee','Tip') AND line->>'amountMinor' ~ minor_pattern AND length(line->>'amountMinor')<=20 AND jsonb_typeof(line->'calculationReferences')='array' AND jsonb_array_length(line->'calculationReferences') BETWEEN 1 AND 16) IS NOT TRUE THEN RAISE EXCEPTION 'Tax fixture line invalid' USING ERRCODE='23514'; END IF;
        IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(line->'calculationReferences') AS refs(value) WHERE value !~ uuid_pattern) THEN RAISE EXCEPTION 'Tax fixture calculation reference invalid' USING ERRCODE='23514'; END IF;
      END LOOP;
      FOR component IN SELECT value FROM jsonb_array_elements(expected->'receiptPreview') LOOP
        IF jsonb_typeof(component) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Tax fixture explanation invalid' USING ERRCODE='23514'; END IF;
        IF (component ?& ARRAY['lineReference','labelCode','componentCode','treatment','rate','taxAmountMinor'] AND (SELECT count(*) FROM jsonb_object_keys(component))=6 AND component->>'lineReference' ~ uuid_pattern AND component->>'labelCode' ~ '^[A-Z][A-Z0-9]*([-_][A-Z0-9]+)*$' AND length(component->>'labelCode')<=64 AND component->>'componentCode' ~ '^[A-Z][A-Z0-9]*([-_][A-Z0-9]+)*$' AND length(component->>'componentCode')<=64 AND component->>'treatment' IN ('Taxable','Exempt','ZeroRated') AND component->>'rate' ~ '^(0|[1-9][0-9]{0,5})(\.[0-9]{0,11}[1-9])?$' AND component->>'taxAmountMinor' ~ minor_pattern AND length(component->>'taxAmountMinor')<=20) IS NOT TRUE THEN RAISE EXCEPTION 'Tax fixture explanation invalid' USING ERRCODE='23514'; END IF;
      END LOOP;
    END LOOP;
  END IF;
  -- Authored canonical instants use the public ISO year-zero semantics. The
  -- surrogate only validates their Gregorian calendar; it never changes facts.
  FOR instant IN
    SELECT value#>>'{}' FROM jsonb_each(content)
      WHERE key IN ('sourceIssuedAt','effectiveFrom','effectiveUntil','reviewedAt','validUntil') AND value IS DISTINCT FROM 'null'::jsonb
    UNION ALL
    SELECT c.value->'fixture'->>'evaluatedAt'
      FROM jsonb_array_elements(CASE WHEN NEW.material_kind='FixtureSuite' THEN content->'cases' ELSE '[]'::jsonb END) AS c(value)
  LOOP
    IF (instant ~ instant_pattern) IS NOT TRUE THEN RAISE EXCEPTION 'Tax material source instant invalid' USING ERRCODE='23514'; END IF;
    BEGIN
      validation_instant:=lpad((2000+(substring(instant FROM 1 FOR 4)::integer%400))::text,4,'0')||substring(instant FROM 5);
      validation_at:=validation_instant::timestamptz;
      IF to_char(validation_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM validation_instant THEN RAISE EXCEPTION 'Tax material source instant invalid' USING ERRCODE='23514'; END IF;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'Tax material source instant invalid' USING ERRCODE='23514';
    END;
  END LOOP;
  IF (COALESCE(content->>'reviewedAt',content->>'sourceIssuedAt') COLLATE "C")>(body->>'recordedAt' COLLATE "C") THEN RAISE EXCEPTION 'Tax material source recorded in future' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.tax_config_material_coherent() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER tax_config_material_root_coherence AFTER INSERT OR UPDATE ON rms_pricing.tax_config_material DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_pricing.tax_config_material_coherent();
CREATE CONSTRAINT TRIGGER tax_config_material_version_coherence AFTER INSERT ON rms_pricing.tax_config_material_version DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_pricing.tax_config_material_coherent();
CREATE CONSTRAINT TRIGGER tax_config_material_operation_coherence AFTER INSERT ON rms_pricing.tax_config_material_operation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_pricing.tax_config_material_coherent();

ALTER TABLE rms_pricing.tax_config_material ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_config_material FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_config_material_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_config_material_version FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_config_material_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_pricing.tax_config_material_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY tax_config_material_scope ON rms_pricing.tax_config_material USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE) WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE);
CREATE POLICY tax_config_material_version_scope ON rms_pricing.tax_config_material_version USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE) WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE);
CREATE POLICY tax_config_material_operation_scope ON rms_pricing.tax_config_material_operation USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE) WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON rms_pricing.tax_config_material,rms_pricing.tax_config_material_version,rms_pricing.tax_config_material_operation FROM PUBLIC;

-- This boolean arbitrates only this owning material namespace, never another
-- Domain or legacy Tax authoring surface. It discloses no foreign tuple.
CREATE FUNCTION rms_pricing.tax_config_material_operation_available(original_operation platform_helpers.uuid_v7) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
  IF original_operation IS NULL OR nullif(current_setting('bop.tenant_id',true),'') IS NULL OR platform_helpers.current_brand_id() IS NULL OR platform_helpers.current_store_id() IS NULL OR current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'Tax material original scope unavailable' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('PricingTaxMaterialOriginal:'||original_operation::text,0));
  RETURN NOT EXISTS(SELECT 1 FROM rms_pricing.tax_config_material_operation WHERE operation_id=original_operation) AND NOT EXISTS(SELECT 1 FROM rms_pricing.tax_config_material_version WHERE operation_id=original_operation);
END;
$$;
REVOKE ALL ON FUNCTION rms_pricing.tax_config_material_operation_available(platform_helpers.uuid_v7) FROM PUBLIC;
