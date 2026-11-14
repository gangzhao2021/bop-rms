-- bop-rms-migration: 1
-- owner: @rms/store
-- schema: rms_store
-- phase: expand
-- risk: low
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_store.store_setup_reference_version (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  reference_kind text NOT NULL CHECK (reference_kind IN ('Address','Contact')),
  reference_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  operation_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  previous_reference_id platform_helpers.uuid_v7,
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=65536),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at)),
  updated_at timestamptz NOT NULL CHECK (updated_at>=created_at AND updated_at=date_trunc('milliseconds',updated_at)),
  data_classification text NOT NULL CHECK (data_classification='Internal'),
  CONSTRAINT store_setup_reference_version_pk PRIMARY KEY (tenant_id,brand_id,store_id,reference_kind,reference_id),
  CONSTRAINT store_setup_reference_version_scope_sequence UNIQUE (tenant_id,brand_id,store_id,reference_kind,revision),
  CONSTRAINT store_setup_reference_version_result_tuple UNIQUE (operation_id,tenant_id,brand_id,store_id,reference_kind,reference_id,revision,snapshot_digest,actor_id,updated_at)
);
CREATE TABLE rms_store.store_setup_reference_operation (
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  reference_kind text NOT NULL CHECK (reference_kind IN ('Address','Contact')),
  actor_id platform_helpers.uuid_v7 NOT NULL,
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  expected_reference_id platform_helpers.uuid_v7,
  expected_revision bigint NOT NULL CHECK (expected_revision BETWEEN 0 AND 2147483647),
  outcome text NOT NULL CHECK (outcome IN ('Committed','Abandoned')),
  result_reference_id platform_helpers.uuid_v7,
  result_revision bigint,
  snapshot_digest text,
  audit_reference platform_helpers.uuid_v7 NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL CHECK (occurred_at=date_trunc('milliseconds',occurred_at)),
  data_classification text NOT NULL CHECK (data_classification='Internal'),
  CONSTRAINT store_setup_reference_operation_expected CHECK ((expected_reference_id IS NULL)=(expected_revision=0)),
  CONSTRAINT store_setup_reference_operation_terminal CHECK (
    (outcome='Abandoned' AND result_reference_id IS NULL AND result_revision IS NULL AND snapshot_digest IS NULL)
    OR (outcome='Committed' AND result_reference_id IS NOT NULL AND result_revision IS NOT NULL AND result_revision BETWEEN 1 AND 2147483647
      AND snapshot_digest IS NOT NULL AND snapshot_digest ~ '^sha256:[0-9a-f]{64}$'
      AND result_revision=expected_revision+1
      AND (expected_reference_id IS NULL OR result_reference_id<>expected_reference_id))
  ),
  CONSTRAINT store_setup_reference_operation_result_tuple UNIQUE (operation_id,tenant_id,brand_id,store_id,reference_kind,result_reference_id,result_revision,snapshot_digest,actor_id,occurred_at),
  CONSTRAINT store_setup_reference_operation_revision_fk FOREIGN KEY (operation_id,tenant_id,brand_id,store_id,reference_kind,result_reference_id,result_revision,snapshot_digest,actor_id,occurred_at)
    REFERENCES rms_store.store_setup_reference_version (operation_id,tenant_id,brand_id,store_id,reference_kind,reference_id,revision,snapshot_digest,actor_id,updated_at)
    DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE rms_store.store_setup_reference_version
  ADD CONSTRAINT store_setup_reference_version_operation_fk FOREIGN KEY (operation_id,tenant_id,brand_id,store_id,reference_kind,reference_id,revision,snapshot_digest,actor_id,updated_at)
    REFERENCES rms_store.store_setup_reference_operation (operation_id,tenant_id,brand_id,store_id,reference_kind,result_reference_id,result_revision,snapshot_digest,actor_id,occurred_at)
    DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION rms_store.store_setup_reference_insert_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE previous rms_store.store_setup_reference_version%ROWTYPE;
  member_name text;
  member_value jsonb;
  snapshot jsonb;
BEGIN
  IF TG_TABLE_SCHEMA<>'rms_store' OR TG_TABLE_NAME NOT IN ('store_setup_reference_version','store_setup_reference_operation')
    OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
    OR current_setting('transaction_isolation')<>'read committed'
    OR (NEW.tenant_id::text=current_setting('bop.tenant_id',true)
      AND NEW.brand_id=platform_helpers.current_brand_id()
      AND NEW.store_id=platform_helpers.current_store_id()) IS NOT TRUE THEN
    RAISE EXCEPTION 'STORE_SETUP_REFERENCE_SCOPE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('StoreSetupReferenceOperation:'||NEW.operation_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('StoreSetupReferenceRoot:'||NEW.tenant_id::text||':'||NEW.brand_id::text||':'||NEW.store_id::text||':'||NEW.reference_kind,0));
  IF TG_TABLE_NAME='store_setup_reference_version' THEN
    snapshot:=NEW.snapshot_json;
    IF jsonb_typeof(snapshot) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'STORE_SETUP_REFERENCE_SNAPSHOT_INVALID' USING ERRCODE='23514';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(snapshot))<>13
      OR snapshot->>'profile' IS DISTINCT FROM 'StoreSetupReferenceVersionV1'
      OR snapshot->>'reference' IS DISTINCT FROM NEW.reference_id::text
      OR snapshot->>'kind' IS DISTINCT FROM NEW.reference_kind
      OR snapshot->>'tenantReference' IS DISTINCT FROM NEW.tenant_id::text
      OR snapshot->>'brandReference' IS DISTINCT FROM NEW.brand_id::text
      OR snapshot->>'storeReference' IS DISTINCT FROM NEW.store_id::text
      OR snapshot->'revision' IS DISTINCT FROM to_jsonb(NEW.revision)
      OR snapshot->>'authoredByReference' IS DISTINCT FROM NEW.actor_id::text
      OR snapshot->'previousReference' IS DISTINCT FROM coalesce(to_jsonb(NEW.previous_reference_id::text),'null'::jsonb)
      OR snapshot->>'createdAt' IS DISTINCT FROM to_char(NEW.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      OR snapshot->>'updatedAt' IS DISTINCT FROM to_char(NEW.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      OR snapshot->>'dataClassification' IS DISTINCT FROM NEW.data_classification
      OR jsonb_typeof(snapshot->'content') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'STORE_SETUP_REFERENCE_SNAPSHOT_INVALID' USING ERRCODE='23514';
    END IF;
    IF NEW.reference_kind='Address' THEN
      IF (SELECT count(*) FROM jsonb_object_keys(snapshot->'content'))<>5
        OR (jsonb_typeof(snapshot->'content'->'countryCode')='string' AND snapshot->'content'->>'countryCode' ~ '^[A-Z]{2}$') IS NOT TRUE
        OR (jsonb_typeof(snapshot->'content'->'regionCode')='string' AND snapshot->'content'->>'regionCode' ~ '^[A-Z0-9][A-Z0-9-]{0,15}$') IS NOT TRUE
        OR (jsonb_typeof(snapshot->'content'->'postalCode')='string' AND snapshot->'content'->>'postalCode' ~ '^[A-Z0-9][A-Z0-9 -]{0,15}$') IS NOT TRUE
        OR jsonb_typeof(snapshot->'content'->'addressLines') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'STORE_SETUP_REFERENCE_CONTENT_INVALID' USING ERRCODE='23514';
      END IF;
      IF jsonb_array_length(snapshot->'content'->'addressLines') NOT BETWEEN 1 AND 3 THEN
        RAISE EXCEPTION 'STORE_SETUP_REFERENCE_CONTENT_INVALID' USING ERRCODE='23514';
      END IF;
      FOREACH member_name IN ARRAY ARRAY['locality'] LOOP
        member_value:=snapshot->'content'->member_name;
        IF (jsonb_typeof(member_value)='string' AND char_length(member_value#>>'{}') BETWEEN 1 AND 96
          AND (member_value#>>'{}') !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]<>{}\[\]`*_#]') IS NOT TRUE THEN
          RAISE EXCEPTION 'STORE_SETUP_REFERENCE_CONTENT_INVALID' USING ERRCODE='23514';
        END IF;
      END LOOP;
      FOR member_value IN SELECT value FROM jsonb_array_elements(snapshot->'content'->'addressLines') LOOP
        IF (jsonb_typeof(member_value)='string' AND char_length(member_value#>>'{}') BETWEEN 1 AND 160
          AND (member_value#>>'{}') !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]<>{}\[\]`*_#]') IS NOT TRUE THEN
          RAISE EXCEPTION 'STORE_SETUP_REFERENCE_CONTENT_INVALID' USING ERRCODE='23514';
        END IF;
      END LOOP;
    ELSE
      IF (SELECT count(*) FROM jsonb_object_keys(snapshot->'content'))<>3
        OR (jsonb_typeof(snapshot->'content'->'contactName')='string'
          AND char_length(snapshot->'content'->>'contactName') BETWEEN 1 AND 120
          AND (snapshot->'content'->>'contactName') !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]<>]') IS NOT TRUE
        OR (jsonb_typeof(snapshot->'content'->'businessPhone')='string' AND snapshot->'content'->>'businessPhone' ~ '^\+[1-9][0-9]{7,14}$') IS NOT TRUE
        OR ((snapshot->'content'->'website'='null'::jsonb) OR (jsonb_typeof(snapshot->'content'->'website')='string'
          AND char_length(snapshot->'content'->>'website') BETWEEN 1 AND 512
          AND snapshot->'content'->>'website' ~ '^https://[^/@?#[:space:]]+/[^?#[:space:]]*$')) IS NOT TRUE THEN
        RAISE EXCEPTION 'STORE_SETUP_REFERENCE_CONTENT_INVALID' USING ERRCODE='23514';
      END IF;
      -- Canonical URL serialization is checked by the owning public parser;
      -- SQL enforces the same credential/query/fragment-free lexical boundary.
    END IF;
    SELECT * INTO previous FROM rms_store.store_setup_reference_version
      WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND reference_kind=NEW.reference_kind
      ORDER BY revision DESC LIMIT 1;
    IF (previous.reference_id IS NULL AND (NEW.revision<>1 OR NEW.previous_reference_id IS NOT NULL OR NEW.created_at<>NEW.updated_at))
      OR (previous.reference_id IS NOT NULL AND (NEW.reference_id=previous.reference_id OR NEW.previous_reference_id IS DISTINCT FROM previous.reference_id
        OR NEW.revision<>previous.revision+1 OR NEW.created_at<>previous.created_at OR NEW.updated_at<previous.updated_at)) THEN
      RAISE EXCEPTION 'STORE_SETUP_REFERENCE_REVISION_CONFLICT' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_store.store_setup_reference_insert_guard() FROM PUBLIC;
CREATE TRIGGER store_setup_reference_version_insert_guard BEFORE INSERT ON rms_store.store_setup_reference_version
  FOR EACH ROW EXECUTE FUNCTION rms_store.store_setup_reference_insert_guard();
CREATE TRIGGER store_setup_reference_operation_insert_guard BEFORE INSERT ON rms_store.store_setup_reference_operation
  FOR EACH ROW EXECUTE FUNCTION rms_store.store_setup_reference_insert_guard();

CREATE FUNCTION rms_store.store_setup_reference_coherent() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE original rms_store.store_setup_reference_operation%ROWTYPE;
  source rms_store.store_setup_reference_version%ROWTYPE;
  current_xid xid;
BEGIN
  current_xid:=mod(pg_current_xact_id()::text::numeric,4294967296)::text::xid;
  IF TG_TABLE_SCHEMA<>'rms_store' OR TG_TABLE_NAME NOT IN ('store_setup_reference_version','store_setup_reference_operation')
    OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
    OR (NEW.tenant_id::text=current_setting('bop.tenant_id',true)
      AND NEW.brand_id=platform_helpers.current_brand_id()
      AND NEW.store_id=platform_helpers.current_store_id()) IS NOT TRUE THEN
    RAISE EXCEPTION 'STORE_SETUP_REFERENCE_SCOPE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  SELECT * INTO original FROM rms_store.store_setup_reference_operation WHERE operation_id=NEW.operation_id AND xmin=current_xid;
  IF original.operation_id IS NULL THEN
    RAISE EXCEPTION 'STORE_SETUP_REFERENCE_ORIGINAL_MISSING' USING ERRCODE='23514';
  END IF;
  SELECT * INTO source FROM rms_store.store_setup_reference_version WHERE operation_id=NEW.operation_id AND xmin=current_xid;
  -- Only the ordinary top-level host is supported; a SAVEPOINT source is not a
  -- substitute for the same top-level original operation. No old source backfill.
  IF original.outcome='Abandoned' THEN
    IF EXISTS(SELECT 1 FROM rms_store.store_setup_reference_version WHERE operation_id=NEW.operation_id) THEN
      RAISE EXCEPTION 'STORE_SETUP_REFERENCE_OPERATION_ABANDONED' USING ERRCODE='23514';
    END IF;
  ELSIF source.operation_id IS NULL OR (source.tenant_id,source.brand_id,source.store_id,source.reference_kind,source.reference_id,source.revision,source.actor_id,source.snapshot_digest,source.updated_at)
    IS DISTINCT FROM (original.tenant_id,original.brand_id,original.store_id,original.reference_kind,original.result_reference_id,original.result_revision,original.actor_id,original.snapshot_digest,original.occurred_at) THEN
    RAISE EXCEPTION 'STORE_SETUP_REFERENCE_ORIGINAL_INCOHERENT' USING ERRCODE='23514';
  END IF;
  IF original.outcome='Committed' AND (source.previous_reference_id IS DISTINCT FROM original.expected_reference_id OR source.revision<>original.expected_revision+1) THEN
    RAISE EXCEPTION 'STORE_SETUP_REFERENCE_PARENT_INCOHERENT' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rms_store.store_setup_reference_coherent() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER store_setup_reference_version_coherence AFTER INSERT ON rms_store.store_setup_reference_version
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_store.store_setup_reference_coherent();
CREATE CONSTRAINT TRIGGER store_setup_reference_operation_coherence AFTER INSERT ON rms_store.store_setup_reference_operation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rms_store.store_setup_reference_coherent();

CREATE TRIGGER store_setup_reference_version_no_mutation BEFORE UPDATE OR DELETE ON rms_store.store_setup_reference_version
  FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_configuration_history_update();
CREATE TRIGGER store_setup_reference_operation_no_mutation BEFORE UPDATE OR DELETE ON rms_store.store_setup_reference_operation
  FOR EACH ROW EXECUTE FUNCTION rms_store.reject_store_configuration_history_update();
CREATE TRIGGER store_setup_reference_version_no_truncate BEFORE TRUNCATE ON rms_store.store_setup_reference_version
  FOR EACH STATEMENT EXECUTE FUNCTION rms_store.reject_store_configuration_history_update();
CREATE TRIGGER store_setup_reference_operation_no_truncate BEFORE TRUNCATE ON rms_store.store_setup_reference_operation
  FOR EACH STATEMENT EXECUTE FUNCTION rms_store.reject_store_configuration_history_update();
ALTER TABLE rms_store.store_setup_reference_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_setup_reference_version FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_setup_reference_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_store.store_setup_reference_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY store_setup_reference_version_scope ON rms_store.store_setup_reference_version
  USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE)
  WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE);
CREATE POLICY store_setup_reference_operation_scope ON rms_store.store_setup_reference_operation
  USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE)
  WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) IS TRUE);
REVOKE ALL ON TABLE rms_store.store_setup_reference_version FROM PUBLIC;
REVOKE ALL ON TABLE rms_store.store_setup_reference_operation FROM PUBLIC;
