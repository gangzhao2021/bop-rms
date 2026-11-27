-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_store.store_setup_draft_revision (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  setup_draft_id platform_helpers.uuid_v7 NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  operation_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=2097152),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at)),
  updated_at timestamptz NOT NULL CHECK (updated_at>=created_at AND updated_at=date_trunc('milliseconds',updated_at)),
  data_classification text NOT NULL CHECK (data_classification='ConfigurationMetadata'),
  CONSTRAINT store_setup_revision_pk PRIMARY KEY (tenant_id,brand_id,store_id,setup_draft_id,revision),
  CONSTRAINT store_setup_revision_scope_sequence UNIQUE (tenant_id,brand_id,store_id,revision),
  CONSTRAINT store_setup_revision_result_tuple UNIQUE (operation_id,tenant_id,brand_id,store_id,setup_draft_id,revision,snapshot_digest,actor_id,updated_at)
);
CREATE TABLE rms_store.store_setup_draft_operation (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  expected_setup_id platform_helpers.uuid_v7,
  expected_revision bigint NOT NULL CHECK (expected_revision BETWEEN 0 AND 2147483647),
  outcome text NOT NULL CHECK (outcome IN ('Committed','Abandoned')),
  result_setup_id platform_helpers.uuid_v7,
  result_revision bigint,
  snapshot_digest text,
  audit_reference platform_helpers.uuid_v7 NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL CHECK (occurred_at=date_trunc('milliseconds',occurred_at)),
  data_classification text NOT NULL CHECK (data_classification='ConfigurationMetadata'),
  CONSTRAINT store_setup_operation_expected CHECK ((expected_setup_id IS NULL)=(expected_revision=0)),
  CONSTRAINT store_setup_operation_terminal CHECK (
    (outcome='Abandoned' AND result_setup_id IS NULL AND result_revision IS NULL AND snapshot_digest IS NULL)
    OR (outcome='Committed' AND result_setup_id IS NOT NULL AND result_revision IS NOT NULL AND result_revision BETWEEN 1 AND 2147483647
      AND snapshot_digest IS NOT NULL AND snapshot_digest ~ '^sha256:[0-9a-f]{64}$'
      AND result_revision=expected_revision+1
      AND (expected_setup_id IS NULL OR result_setup_id=expected_setup_id))
  ),
  CONSTRAINT store_setup_operation_result_tuple UNIQUE (operation_id,tenant_id,brand_id,store_id,result_setup_id,result_revision,snapshot_digest,actor_id,occurred_at),
  CONSTRAINT store_setup_operation_revision_fk FOREIGN KEY (operation_id,tenant_id,brand_id,store_id,result_setup_id,result_revision,snapshot_digest,actor_id,occurred_at)
    REFERENCES rms_store.store_setup_draft_revision (operation_id,tenant_id,brand_id,store_id,setup_draft_id,revision,snapshot_digest,actor_id,updated_at)
    DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE rms_store.store_setup_draft_revision
  ADD CONSTRAINT store_setup_revision_operation_fk FOREIGN KEY (operation_id,tenant_id,brand_id,store_id,setup_draft_id,revision,snapshot_digest,actor_id,updated_at)
    REFERENCES rms_store.store_setup_draft_operation (operation_id,tenant_id,brand_id,store_id,result_setup_id,result_revision,snapshot_digest,actor_id,occurred_at)
    DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION rms_store.store_setup_draft_insert_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE previous rms_store.store_setup_draft_revision%ROWTYPE;
  member_name text;
  member_value jsonb;
  snapshot jsonb;
BEGIN
  IF TG_TABLE_SCHEMA<>'rms_store' OR TG_TABLE_NAME NOT IN ('store_setup_draft_revision','store_setup_draft_operation')
    OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
    OR current_setting('transaction_isolation')<>'read committed'
    OR (NEW.tenant_id::text=current_setting('bop.tenant_id',true)
      AND NEW.brand_id=platform_helpers.current_brand_id()
      AND NEW.store_id=platform_helpers.current_store_id()) IS NOT TRUE THEN
    RAISE EXCEPTION 'STORE_SETUP_SCOPE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('StoreSetupOperation:'||NEW.operation_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('StoreSetupRoot:'||NEW.tenant_id::text||':'||NEW.brand_id::text||':'||NEW.store_id::text,0));
  IF TG_TABLE_NAME='store_setup_draft_revision' THEN
    snapshot:=NEW.snapshot_json;
    IF jsonb_typeof(snapshot) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'STORE_SETUP_SNAPSHOT_INVALID' USING ERRCODE='23514';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(snapshot))<>15
      OR snapshot->>'profile' IS DISTINCT FROM 'StoreSetupDraftV1'
      OR snapshot->>'setupDraftReference' IS DISTINCT FROM NEW.setup_draft_id::text
      OR snapshot->>'tenantReference' IS DISTINCT FROM NEW.tenant_id::text
      OR snapshot->>'brandReference' IS DISTINCT FROM NEW.brand_id::text
      OR snapshot->>'storeReference' IS DISTINCT FROM NEW.store_id::text
      OR snapshot->'revision' IS DISTINCT FROM to_jsonb(NEW.revision)
      OR snapshot->>'authoredByReference' IS DISTINCT FROM NEW.actor_id::text
      OR snapshot->>'createdAt' IS DISTINCT FROM to_char(NEW.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      OR snapshot->>'updatedAt' IS DISTINCT FROM to_char(NEW.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      OR snapshot->>'purposeCode' IS DISTINCT FROM 'STORE_SETUP_DRAFT'
      OR snapshot->>'dataClassification' IS DISTINCT FROM NEW.data_classification
      OR snapshot->>'currencyCode' IS DISTINCT FROM 'CAD'
      OR (snapshot->>'defaultLocale' ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|[0-9]{3})$') IS NOT TRUE
      OR NOT snapshot ? 'baseConfigurationReference'
      OR (snapshot->'baseConfigurationReference'<>'null'::jsonb AND (snapshot->>'baseConfigurationReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') IS NOT TRUE)
      OR jsonb_typeof(snapshot->'content') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'STORE_SETUP_SNAPSHOT_INVALID' USING ERRCODE='23514';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(snapshot->'content'))<>15 THEN
      RAISE EXCEPTION 'STORE_SETUP_CONTENT_INVALID' USING ERRCODE='23514';
    END IF;
    FOREACH member_name IN ARRAY ARRAY['source','brandBaseVersionReference','timeZone','businessDayStartLocalTime','addressReference','contactReference','receiptReference','taxConfigurationReference','paymentConfigurationReference','capacityConfigurationReference','enabledServiceModes','weeklySchedule','exceptions','effectiveFrom','effectiveUntil'] LOOP
      member_value:=snapshot->'content'->member_name;
      IF jsonb_typeof(member_value) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'STORE_SETUP_CONTENT_INVALID' USING ERRCODE='23514';
      END IF;
      IF ((member_value='{"state":"Unconfigured"}'::jsonb)
          OR (member_value->>'state'='Configured' AND member_value ? 'value'
            AND (SELECT count(*) FROM jsonb_object_keys(member_value))=2
            AND (member_value->'value'<>'null'::jsonb OR member_name IN ('capacityConfigurationReference','effectiveUntil')))) IS NOT TRUE THEN
        RAISE EXCEPTION 'STORE_SETUP_CONTENT_INVALID' USING ERRCODE='23514';
      END IF;
      IF member_value->>'state'='Configured' THEN
        IF member_name IN ('brandBaseVersionReference','addressReference','contactReference','receiptReference','taxConfigurationReference','paymentConfigurationReference','capacityConfigurationReference') THEN
          IF member_value->'value'<>'null'::jsonb AND (jsonb_typeof(member_value->'value')='string'
            AND member_value->>'value' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') IS NOT TRUE THEN
            RAISE EXCEPTION 'STORE_SETUP_CONTENT_INVALID' USING ERRCODE='23514';
          END IF;
        ELSIF member_name IN ('enabledServiceModes','weeklySchedule','exceptions') THEN
          IF jsonb_typeof(member_value->'value') IS DISTINCT FROM 'array' THEN
            RAISE EXCEPTION 'STORE_SETUP_CONTENT_INVALID' USING ERRCODE='23514';
          END IF;
        ELSIF member_name='source' THEN
          IF (jsonb_typeof(member_value->'value')='string' AND member_value->>'value' IN ('BrandInherited','StoreOverride')) IS NOT TRUE THEN
            RAISE EXCEPTION 'STORE_SETUP_CONTENT_INVALID' USING ERRCODE='23514';
          END IF;
        ELSIF member_value->'value'<>'null'::jsonb AND jsonb_typeof(member_value->'value') IS DISTINCT FROM 'string' THEN
          RAISE EXCEPTION 'STORE_SETUP_CONTENT_INVALID' USING ERRCODE='23514';
        END IF;
      END IF;
    END LOOP;
    SELECT * INTO previous FROM rms_store.store_setup_draft_revision
      WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id
      ORDER BY revision DESC LIMIT 1;
    IF (previous.setup_draft_id IS NULL AND (NEW.revision<>1 OR NEW.created_at<>NEW.updated_at))
      OR (previous.setup_draft_id IS NOT NULL AND (NEW.setup_draft_id<>previous.setup_draft_id
        OR NEW.revision<>previous.revision+1 OR NEW.created_at<>previous.created_at OR NEW.updated_at<previous.updated_at)) THEN
      RAISE EXCEPTION 'STORE_SETUP_REVISION_CONFLICT' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_store.store_setup_draft_insert_guard() FROM PUBLIC;
CREATE TRIGGER store_setup_revision_insert_guard BEFORE INSERT ON rms_store.store_setup_draft_revision
  FOR EACH ROW EXECUTE FUNCTION rms_store.store_setup_draft_insert_guard();
CREATE TRIGGER store_setup_operation_insert_guard BEFORE INSERT ON rms_store.store_setup_draft_operation
  FOR EACH ROW EXECUTE FUNCTION rms_store.store_setup_draft_insert_guard();

CREATE FUNCTION rms_store.store_setup_draft_coherent() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE original rms_store.store_setup_draft_operation%ROWTYPE;
  source rms_store.store_setup_draft_revision%ROWTYPE;
  current_xid xid;
BEGIN
  current_xid:=mod(pg_current_xact_id()::text::numeric,4294967296)::text::xid;
  IF TG_TABLE_SCHEMA<>'rms_store' OR TG_TABLE_NAME NOT IN ('store_setup_draft_revision','store_setup_draft_operation')
    OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
    OR (NEW.tenant_id::text=current_setting('bop.tenant_id',true)
      AND NEW.brand_id=platform_helpers.current_brand_id()
      AND NEW.store_id=platform_helpers.current_store_id()) IS NOT TRUE THEN
    RAISE EXCEPTION 'STORE_SETUP_SCOPE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  SELECT * INTO original FROM rms_store.store_setup_draft_operation WHERE operation_id=NEW.operation_id AND xmin=current_xid;
  IF original.operation_id IS NULL THEN
    RAISE EXCEPTION 'STORE_SETUP_ORIGINAL_MISSING' USING ERRCODE='23514';
  END IF;
  SELECT * INTO source FROM rms_store.store_setup_draft_revision WHERE operation_id=NEW.operation_id AND xmin=current_xid;
  -- Only the ordinary top-level host is supported; a SAVEPOINT source is not a
  -- substitute for the same top-level original operation. No old source backfill.
  IF original.outcome='Abandoned' THEN
    IF EXISTS(SELECT 1 FROM rms_store.store_setup_draft_revision WHERE operation_id=NEW.operation_id) THEN
      RAISE EXCEPTION 'STORE_SETUP_OPERATION_ABANDONED' USING ERRCODE='23514';
    END IF;
  ELSIF source.operation_id IS NULL OR (source.tenant_id,source.brand_id,source.store_id,source.setup_draft_id,source.revision,source.actor_id,source.snapshot_digest,source.updated_at)
    IS DISTINCT FROM (original.tenant_id,original.brand_id,original.store_id,original.result_setup_id,original.result_revision,original.actor_id,original.snapshot_digest,original.occurred_at) THEN
    RAISE EXCEPTION 'STORE_SETUP_ORIGINAL_INCOHERENT' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_store.store_setup_draft_coherent() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER store_setup_revision_coherence AFTER INSERT ON rms_store.store_setup_draft_revision
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_store.store_setup_draft_coherent();
CREATE CONSTRAINT TRIGGER store_setup_operation_coherence AFTER INSERT ON rms_store.store_setup_draft_operation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_store.store_setup_draft_coherent();

CREATE TRIGGER store_setup_revision_no_mutation BEFORE UPDATE OR DELETE ON rms_store.store_setup_draft_revision
  FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_configuration_history_update();
CREATE TRIGGER store_setup_operation_no_mutation BEFORE UPDATE OR DELETE ON rms_store.store_setup_draft_operation
  FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_configuration_history_update();
CREATE TRIGGER store_setup_revision_no_truncate BEFORE TRUNCATE ON rms_store.store_setup_draft_revision
  FOR EACH STATEMENT EXECUTE FUNCTION rms_store.reject_store_configuration_history_update();
CREATE TRIGGER store_setup_operation_no_truncate BEFORE TRUNCATE ON rms_store.store_setup_draft_operation
  FOR EACH STATEMENT EXECUTE FUNCTION rms_store.reject_store_configuration_history_update();
ALTER TABLE rms_store.store_setup_draft_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_setup_draft_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_setup_draft_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_setup_draft_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY store_setup_revision_scope ON rms_store.store_setup_draft_revision
  USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE)
  WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE);
CREATE POLICY store_setup_operation_scope ON rms_store.store_setup_draft_operation
  USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE)
  WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_store.store_setup_draft_revision FROM PUBLIC;
REVOKE ALL ON TABLE rms_store.store_setup_draft_operation FROM PUBLIC;
