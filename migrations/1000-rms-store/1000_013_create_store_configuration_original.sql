-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- New ordinary originals do not backfill or reinterpret historical 005 intents.
CREATE TABLE rms_store.store_configuration_original_operation (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  action_code text NOT NULL CHECK (action_code IN ('Materialize','Validate','Submit','Approve','Publish')),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  command_json jsonb NOT NULL CHECK (jsonb_typeof(command_json)='object' AND octet_length(command_json::text)<=2101248),
  outcome text NOT NULL CHECK (outcome IN ('Committed','Abandoned')),
  committed_operation_id platform_helpers.uuid_v7,
  legacy_input_json jsonb,
  legacy_intent_digest text,
  receipt_json jsonb NOT NULL CHECK (jsonb_typeof(receipt_json)='object' AND octet_length(receipt_json::text)<=2101248),
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
  audit_reference platform_helpers.uuid_v7 NOT NULL,
  occurred_at timestamptz NOT NULL CHECK (occurred_at=date_trunc('milliseconds',occurred_at)),
  data_classification text NOT NULL CHECK (data_classification='ConfigurationMetadata'),
  CONSTRAINT store_configuration_original_terminal CHECK (
    (outcome='Abandoned' AND committed_operation_id IS NULL AND legacy_input_json IS NULL AND legacy_intent_digest IS NULL)
    OR (outcome='Committed' AND committed_operation_id IS NOT NULL AND committed_operation_id=operation_id
      AND legacy_input_json IS NOT NULL AND jsonb_typeof(legacy_input_json)='object'
      AND octet_length(legacy_input_json::text)<=2101248 AND legacy_intent_digest IS NOT NULL
      AND legacy_intent_digest ~ '^sha256:[0-9a-f]{64}$')
  ),
  CONSTRAINT store_configuration_original_committed_fk FOREIGN KEY (brand_id,store_id,committed_operation_id)
    REFERENCES rms_store.store_configuration_authoring_operation (brand_id,store_id,operation_id)
);
ALTER TABLE rms_store.store_configuration_original_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_configuration_original_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY store_configuration_original_scope ON rms_store.store_configuration_original_operation
  USING ((tenant_id::text=current_setting('bop.tenant_id',true)) IS TRUE
    AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true)) IS TRUE
    AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON rms_store.store_configuration_original_operation FROM PUBLIC;

CREATE FUNCTION rms_store.check_store_configuration_original_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
  c jsonb := NEW.command_json;
  r jsonb := NEW.receipt_json;
  h jsonb;
  p jsonb;
  old rms_store.store_configuration_authoring_operation%ROWTYPE;
  old_xid xid;
  mapped text;
  expected bigint;
  expected_keys integer;
  at_text text;
BEGIN
  IF (NEW.tenant_id::text=current_setting('bop.tenant_id',true)
    AND NEW.brand_id=platform_helpers.current_brand_id()
    AND NEW.store_id=platform_helpers.current_store_id()) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='store configuration original scope mismatch';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('StoreConfigurationOriginal:'||NEW.operation_id::text,0)) THEN
    RAISE EXCEPTION USING ERRCODE='55P03', MESSAGE='store configuration original identity busy';
  END IF;
  expected_keys := CASE WHEN NEW.action_code='Materialize' THEN 10 ELSE 8 END;
  IF (jsonb_typeof(c)='object' AND (SELECT count(*) FROM jsonb_object_keys(c))=expected_keys
    AND c @> jsonb_build_object('profile','StoreConfigurationOrdinaryCommandV1','tenantReference',NEW.tenant_id::text,
      'brandReference',NEW.brand_id::text,'storeReference',NEW.store_id::text,'actorReference',NEW.actor_id::text,
      'operationReference',NEW.operation_id::text,'action',NEW.action_code)
    AND c ? 'expectedHead') IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='store configuration original command mismatch';
  END IF;
  h := c->'expectedHead';
  IF (jsonb_typeof(h)='object' AND (SELECT count(*) FROM jsonb_object_keys(h))=3
    AND h ?& ARRAY['configurationReference','configurationVersion','contentDigest']
    AND jsonb_typeof(h->'configurationVersion')='number'
    AND h->>'configurationVersion' ~ '^(0|[1-9][0-9]*)$') IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='store configuration original head mismatch';
  END IF;
  expected := (h->>'configurationVersion')::bigint;
  IF expected>9007199254740991 OR (
    (expected=0 AND NEW.action_code='Materialize' AND h->'configurationReference'='null'::jsonb AND h->'contentDigest'='null'::jsonb)
    OR (expected>0 AND (h->>'configurationReference')::platform_helpers.uuid_v7 IS NOT NULL
      AND h->>'contentDigest' ~ '^sha256:[0-9a-f]{64}$')
  ) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='store configuration original head binding mismatch';
  END IF;
  IF NEW.action_code='Materialize' THEN
    p := c->'setupSelector';
    IF (expected<9007199254740991 AND c->>'reasonCode' ~ '^[A-Z][A-Z0-9_.:-]{0,63}$'
      AND jsonb_typeof(p)='object' AND (SELECT count(*) FROM jsonb_object_keys(p))=3
      AND p ?& ARRAY['setupDraftReference','sourceRevision','sourceSnapshotDigest']
      AND (p->>'setupDraftReference')::platform_helpers.uuid_v7 IS NOT NULL
      AND jsonb_typeof(p->'sourceRevision')='number' AND p->>'sourceRevision' ~ '^[1-9][0-9]*$'
      AND (p->>'sourceRevision')::bigint BETWEEN 1 AND 2147483647
      AND p->>'sourceSnapshotDigest' ~ '^sha256:[0-9a-f]{64}$') IS NOT TRUE THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='store configuration original setup pins mismatch';
    END IF;
  END IF;
  at_text := to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  IF (jsonb_typeof(r)='object' AND (SELECT count(*) FROM jsonb_object_keys(r))=expected_keys+6
    AND (r-ARRAY['intentDigest','outcome','operation','auditReference','occurredAt','dataClassification','profile'])=(c-'profile')
    AND r @> jsonb_build_object('profile','StoreConfigurationOrdinaryReceiptV1','intentDigest',NEW.intent_digest,
      'outcome',NEW.outcome,'auditReference',NEW.audit_reference::text,'occurredAt',at_text,
      'dataClassification','ConfigurationMetadata')) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='store configuration original receipt mismatch';
  END IF;
  SELECT a.* INTO old FROM rms_store.store_configuration_authoring_operation a
    WHERE a.brand_id=NEW.brand_id AND a.store_id=NEW.store_id AND a.operation_id=NEW.operation_id;
  SELECT a.xmin INTO old_xid FROM rms_store.store_configuration_authoring_operation a
    WHERE a.brand_id=NEW.brand_id AND a.store_id=NEW.store_id AND a.operation_id=NEW.operation_id;
  IF NEW.outcome='Abandoned' THEN
    IF old.operation_id IS NOT NULL OR r->'operation' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='store configuration original abandonment mismatch';
    END IF;
  ELSE
    mapped := CASE WHEN NEW.action_code='Materialize' THEN 'SaveDraft' ELSE NEW.action_code END;
    p := NEW.legacy_input_json;
    IF (old.operation_id=NEW.operation_id AND old_xid=mod(pg_current_xact_id()::text::numeric,4294967296)::text::xid
      AND old.command_type=mapped AND old.actor_reference=NEW.actor_id
      AND old.purpose_code='STORE_CONFIGURATION' AND old.audit_reference=NEW.audit_reference
      AND old.occurred_at=NEW.occurred_at AND old.expected_version=expected
      AND old.intent_digest=NEW.legacy_intent_digest AND old.data_classification='ConfigurationMetadata'
      AND jsonb_typeof(p)='object' AND (SELECT count(*) FROM jsonb_object_keys(p))=7
      AND p ?& ARRAY['command','operationReference','actorReference','purposeCode','auditReference','expectedVersion','configuration']
      AND p @> jsonb_build_object('command',mapped,'operationReference',NEW.operation_id::text,
        'actorReference',NEW.actor_id::text,'purposeCode','STORE_CONFIGURATION','auditReference',NEW.audit_reference::text,
        'expectedVersion',expected)
      AND jsonb_typeof(p->'configuration')='object'
      AND p->'configuration' @> jsonb_build_object('brandReference',NEW.brand_id::text,'storeReference',NEW.store_id::text)
      AND r->'operation'=jsonb_build_object('command',mapped,'operationReference',NEW.operation_id::text,
        'brandReference',NEW.brand_id::text,'storeReference',NEW.store_id::text,'intentDigest',old.intent_digest,
        'resultingVersion',old.configuration_version,'configuration',old.configuration_json)) IS NOT TRUE THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='store configuration original committed binding mismatch';
    END IF;
    IF NEW.action_code='Materialize' THEN
      IF (old.configuration_json->'setupBasis' @> jsonb_build_object('tenantReference',NEW.tenant_id::text,
        'setupDraftReference',c->'setupSelector'->>'setupDraftReference',
        'sourceRevision',(c->'setupSelector'->>'sourceRevision')::bigint,
        'sourceSnapshotDigest',c->'setupSelector'->>'sourceSnapshotDigest')
        AND old.configuration_json->'supersedesConfigurationReference'=h->'configurationReference'
        AND old.configuration_json->>'reasonCode'=c->>'reasonCode'
        AND old.configuration_json->>'authoredByReference'=NEW.actor_id::text) IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='store configuration original materialization mismatch';
      END IF;
    ELSIF old.configuration_id::text IS DISTINCT FROM h->>'configurationReference' THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='store configuration original configuration mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_store.check_store_configuration_original_insert() FROM PUBLIC;
CREATE TRIGGER store_configuration_original_insert BEFORE INSERT ON rms_store.store_configuration_original_operation
  FOR EACH ROW EXECUTE FUNCTION rms_store.check_store_configuration_original_insert();

CREATE FUNCTION rms_store.fence_store_configuration_original() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  -- Legacy writers already hold the 005 table lock: never wait for the new
  -- ordinary global lock here. Contention rolls back the whole attempted write.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('StoreConfigurationOriginal:'||NEW.operation_id::text,0)) THEN
    RAISE EXCEPTION USING ERRCODE='55P03', MESSAGE='store configuration original identity busy';
  END IF;
  IF EXISTS (SELECT 1 FROM rms_store.store_configuration_original_operation o
    WHERE o.tenant_id::text=current_setting('bop.tenant_id',true)
      AND o.brand_id=NEW.brand_id AND o.store_id=NEW.store_id AND o.operation_id=NEW.operation_id) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='store configuration original already terminal';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_store.fence_store_configuration_original() FROM PUBLIC;
CREATE TRIGGER store_configuration_authoring_original_fence BEFORE INSERT ON rms_store.store_configuration_authoring_operation
  FOR EACH ROW EXECUTE FUNCTION rms_store.fence_store_configuration_original();

CREATE FUNCTION rms_store.reject_store_configuration_original_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='store configuration originals are immutable';
END;
$$;
REVOKE ALL ON FUNCTION rms_store.reject_store_configuration_original_mutation() FROM PUBLIC;
CREATE TRIGGER store_configuration_original_no_update BEFORE UPDATE ON rms_store.store_configuration_original_operation
  FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_configuration_original_mutation();
CREATE TRIGGER store_configuration_original_no_delete BEFORE DELETE ON rms_store.store_configuration_original_operation
  FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_configuration_original_mutation();
CREATE TRIGGER store_configuration_original_no_truncate BEFORE TRUNCATE ON rms_store.store_configuration_original_operation
  FOR EACH STATEMENT EXECUTE FUNCTION rms_store.reject_store_configuration_original_mutation();
