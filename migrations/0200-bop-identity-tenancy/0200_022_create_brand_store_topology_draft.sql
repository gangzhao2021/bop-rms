-- bop-rms-migration: 1
-- owner: @bop/tenant
-- schema: bop_tenant
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE bop_tenant.brand_store_topology_draft_revision (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL REFERENCES bop_tenant.brand(brand_id),
  draft_id platform_helpers.uuid_v7 NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  operation_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=2101248),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
  updated_at timestamptz NOT NULL CHECK (isfinite(updated_at) AND updated_at>=created_at AND updated_at=date_trunc('milliseconds',updated_at)),
  CONSTRAINT brand_store_topology_revision_pk PRIMARY KEY (tenant_id,brand_id,revision),
  CONSTRAINT brand_store_topology_revision_result_tuple UNIQUE (operation_id,tenant_id,brand_id,draft_id,revision,actor_id,audit_id,snapshot_digest,updated_at)
);
CREATE TABLE bop_tenant.brand_store_topology_draft_operation (
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL REFERENCES bop_tenant.brand(brand_id),
  operation_id platform_helpers.uuid_v7 PRIMARY KEY,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  expected_revision integer NOT NULL CHECK (expected_revision BETWEEN 0 AND 2147483646),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('Committed','Abandoned')),
  result_revision integer,
  result_draft_id platform_helpers.uuid_v7,
  snapshot_digest text,
  command_json jsonb CHECK (command_json IS NULL OR (jsonb_typeof(command_json)='object' AND octet_length(command_json::text)<=2101248)),
  audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at) AND occurred_at=date_trunc('milliseconds',occurred_at)),
  CONSTRAINT brand_store_topology_operation_terminal CHECK (
    (outcome='Abandoned' AND result_revision IS NULL AND result_draft_id IS NULL AND snapshot_digest IS NULL AND command_json IS NULL)
    OR (outcome='Committed' AND result_revision IS NOT NULL AND result_revision BETWEEN 1 AND 2147483647
      AND result_revision::bigint=expected_revision::bigint+1 AND result_draft_id IS NOT NULL
      AND snapshot_digest IS NOT NULL AND snapshot_digest ~ '^sha256:[0-9a-f]{64}$' AND command_json IS NOT NULL)
  ),
  CONSTRAINT brand_store_topology_operation_result_tuple UNIQUE (operation_id,tenant_id,brand_id,result_draft_id,result_revision,actor_id,audit_id,snapshot_digest,occurred_at),
  CONSTRAINT brand_store_topology_operation_revision_fk FOREIGN KEY (operation_id,tenant_id,brand_id,result_draft_id,result_revision,actor_id,audit_id,snapshot_digest,occurred_at)
    REFERENCES bop_tenant.brand_store_topology_draft_revision(operation_id,tenant_id,brand_id,draft_id,revision,actor_id,audit_id,snapshot_digest,updated_at)
    DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE bop_tenant.brand_store_topology_draft_revision
  ADD CONSTRAINT brand_store_topology_revision_operation_fk FOREIGN KEY (operation_id,tenant_id,brand_id,draft_id,revision,actor_id,audit_id,snapshot_digest,updated_at)
    REFERENCES bop_tenant.brand_store_topology_draft_operation(operation_id,tenant_id,brand_id,result_draft_id,result_revision,actor_id,audit_id,snapshot_digest,occurred_at)
    DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION bop_tenant.brand_store_topology_draft_insert_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE previous bop_tenant.brand_store_topology_draft_revision%ROWTYPE;
  body jsonb;
  content jsonb;
  selector jsonb;
  assignment jsonb;
  selector_ids text[]:=ARRAY[]::text[];
  selector_codes text[]:=ARRAY[]::text[];
  assignment_keys text[]:=ARRAY[]::text[];
  pair_key text;
  code_key text;
  expected_draft text;
  uuid_pattern CONSTANT text:='^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
BEGIN
  IF TG_TABLE_SCHEMA<>'bop_tenant' OR TG_TABLE_NAME NOT IN ('brand_store_topology_draft_revision','brand_store_topology_draft_operation')
    OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
    OR current_setting('transaction_isolation')<>'read committed'
    OR (NEW.tenant_id::text=current_setting('bop.tenant_id',true) AND NEW.brand_id=platform_helpers.current_brand_id()) IS NOT TRUE THEN
    RAISE EXCEPTION 'BRAND_STORE_TOPOLOGY_SCOPE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  -- Both Save and Resolve serialize the original first, then the actual Brand.
  -- This prepares configuration only; it neither writes membership nor activates Stores.
  PERFORM pg_advisory_xact_lock(hashtextextended('BrandStoreTopologyOriginal:'||NEW.operation_id::text,0));
  PERFORM brand_id FROM bop_tenant.brand WHERE brand_id=NEW.brand_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BRAND_STORE_TOPOLOGY_BRAND_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  IF TG_TABLE_NAME='brand_store_topology_draft_revision' THEN
    body:=NEW.snapshot_json;
    IF jsonb_typeof(body) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'BRAND_STORE_TOPOLOGY_SNAPSHOT_INVALID' USING ERRCODE='23514';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(body))<>12
      OR NOT body ?& ARRAY['profile','tenantReference','brandReference','actorReference','revision','content','snapshotDigest','operationReference','auditReference','createdAt','updatedAt','dataClassification']
      OR body->>'profile' IS DISTINCT FROM 'BrandStoreTopologyDraftRevisionV1'
      OR body->>'tenantReference' IS DISTINCT FROM NEW.tenant_id::text
      OR body->>'brandReference' IS DISTINCT FROM NEW.brand_id::text
      OR body->>'actorReference' IS DISTINCT FROM NEW.actor_id::text
      OR body->'revision' IS DISTINCT FROM to_jsonb(NEW.revision)
      OR body->>'snapshotDigest' IS DISTINCT FROM NEW.snapshot_digest
      OR body->>'operationReference' IS DISTINCT FROM NEW.operation_id::text
      OR body->>'auditReference' IS DISTINCT FROM NEW.audit_id::text
      OR body->>'createdAt' IS DISTINCT FROM to_char(NEW.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      OR body->>'updatedAt' IS DISTINCT FROM to_char(NEW.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      OR body->>'dataClassification' IS DISTINCT FROM 'ConfigurationMetadata'
      OR octet_length((body-'content')::text)>4096 THEN
      RAISE EXCEPTION 'BRAND_STORE_TOPOLOGY_SNAPSHOT_INVALID' USING ERRCODE='23514';
    END IF;
    content:=body->'content';
    expected_draft:=NEW.draft_id::text;
    SELECT * INTO previous FROM bop_tenant.brand_store_topology_draft_revision
      WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id ORDER BY revision DESC LIMIT 1;
    IF (previous.draft_id IS NULL AND (NEW.revision<>1 OR NEW.created_at<>NEW.updated_at))
      OR (previous.draft_id IS NOT NULL AND (NEW.draft_id<>previous.draft_id
        OR NEW.revision::bigint<>previous.revision::bigint+1 OR NEW.created_at<>previous.created_at OR NEW.updated_at<previous.updated_at)) THEN
      RAISE EXCEPTION 'BRAND_STORE_TOPOLOGY_REVISION_CONFLICT' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.outcome='Committed' THEN
    body:=NEW.command_json;
    IF jsonb_typeof(body) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'BRAND_STORE_TOPOLOGY_COMMAND_INVALID' USING ERRCODE='23514';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(body))<>7
      OR NOT body ?& ARRAY['profile','tenantReference','brandReference','actorReference','operationReference','expectedRevision','content']
      OR body->>'profile' IS DISTINCT FROM 'BrandStoreTopologySaveV1'
      OR body->>'tenantReference' IS DISTINCT FROM NEW.tenant_id::text
      OR body->>'brandReference' IS DISTINCT FROM NEW.brand_id::text
      OR body->>'actorReference' IS DISTINCT FROM NEW.actor_id::text
      OR body->>'operationReference' IS DISTINCT FROM NEW.operation_id::text
      OR body->'expectedRevision' IS DISTINCT FROM to_jsonb(NEW.expected_revision)
      OR octet_length((body-'content')::text)>4096 THEN
      RAISE EXCEPTION 'BRAND_STORE_TOPOLOGY_COMMAND_INVALID' USING ERRCODE='23514';
    END IF;
    content:=body->'content';
    expected_draft:=NEW.result_draft_id::text;
  ELSE
    RETURN NEW;
  END IF;
  IF jsonb_typeof(content) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'BRAND_STORE_TOPOLOGY_CONTENT_INVALID' USING ERRCODE='23514';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(content))<>6
    OR NOT content ?& ARRAY['profile','tenantReference','brandReference','draftReference','selectors','assignments']
    OR content->>'profile' IS DISTINCT FROM 'BrandStoreTopologyDraftV1'
    OR content->>'tenantReference' IS DISTINCT FROM NEW.tenant_id::text
    OR content->>'brandReference' IS DISTINCT FROM NEW.brand_id::text
    OR (jsonb_typeof(content->'draftReference')='string' AND content->>'draftReference' ~ uuid_pattern) IS NOT TRUE
    OR jsonb_typeof(content->'selectors') IS DISTINCT FROM 'array'
    OR jsonb_typeof(content->'assignments') IS DISTINCT FROM 'array'
    OR octet_length(content::text)>2097152 THEN
    RAISE EXCEPTION 'BRAND_STORE_TOPOLOGY_CONTENT_INVALID' USING ERRCODE='23514';
  END IF;
  IF content->>'draftReference' IS DISTINCT FROM expected_draft
    OR jsonb_array_length(content->'selectors')>1000 OR jsonb_array_length(content->'assignments')>10000 THEN
    RAISE EXCEPTION 'BRAND_STORE_TOPOLOGY_CONTENT_INVALID' USING ERRCODE='23514';
  END IF;
  FOR selector IN SELECT value FROM jsonb_array_elements(content->'selectors') LOOP
    IF jsonb_typeof(selector) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'BRAND_STORE_TOPOLOGY_SELECTOR_INVALID' USING ERRCODE='23514';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(selector))<>4 OR NOT selector ?& ARRAY['kind','reference','code','name']
      OR (jsonb_typeof(selector->'kind')='string' AND selector->>'kind' IN ('Region','StoreGroup')
        AND jsonb_typeof(selector->'reference')='string' AND selector->>'reference' ~ uuid_pattern
        AND jsonb_typeof(selector->'code')='string' AND selector->>'code' ~ '^[A-Z][A-Z0-9_-]{0,62}$'
        AND jsonb_typeof(selector->'name')='string' AND char_length(selector->>'name') BETWEEN 1 AND 120
        AND btrim(selector->>'name')=selector->>'name' AND selector->>'name' !~ '[[:cntrl:]<>]') IS NOT TRUE THEN
      RAISE EXCEPTION 'BRAND_STORE_TOPOLOGY_SELECTOR_INVALID' USING ERRCODE='23514';
    END IF;
    code_key:=selector->>'kind'||':'||(selector->>'code');
    IF selector->>'reference'=ANY(selector_ids) OR code_key=ANY(selector_codes) THEN
      RAISE EXCEPTION 'BRAND_STORE_TOPOLOGY_SELECTOR_INVALID' USING ERRCODE='23514';
    END IF;
    selector_ids:=array_append(selector_ids,selector->>'reference');
    selector_codes:=array_append(selector_codes,code_key);
  END LOOP;
  FOR assignment IN SELECT value FROM jsonb_array_elements(content->'assignments') LOOP
    IF jsonb_typeof(assignment) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'BRAND_STORE_TOPOLOGY_ASSIGNMENT_INVALID' USING ERRCODE='23514';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(assignment))<>2 OR NOT assignment ?& ARRAY['storeReference','selectorReference']
      OR (jsonb_typeof(assignment->'storeReference')='string' AND assignment->>'storeReference' ~ uuid_pattern
        AND jsonb_typeof(assignment->'selectorReference')='string' AND assignment->>'selectorReference' ~ uuid_pattern
        AND assignment->>'selectorReference'=ANY(selector_ids)) IS NOT TRUE THEN
      RAISE EXCEPTION 'BRAND_STORE_TOPOLOGY_ASSIGNMENT_INVALID' USING ERRCODE='23514';
    END IF;
    pair_key:=assignment->>'storeReference'||':'||(assignment->>'selectorReference');
    IF pair_key=ANY(assignment_keys) THEN
      RAISE EXCEPTION 'BRAND_STORE_TOPOLOGY_ASSIGNMENT_INVALID' USING ERRCODE='23514';
    END IF;
    assignment_keys:=array_append(assignment_keys,pair_key);
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_tenant.brand_store_topology_draft_insert_guard() FROM PUBLIC;
CREATE TRIGGER brand_store_topology_revision_insert_guard BEFORE INSERT ON bop_tenant.brand_store_topology_draft_revision
  FOR EACH ROW EXECUTE FUNCTION bop_tenant.brand_store_topology_draft_insert_guard();
CREATE TRIGGER brand_store_topology_operation_insert_guard BEFORE INSERT ON bop_tenant.brand_store_topology_draft_operation
  FOR EACH ROW EXECUTE FUNCTION bop_tenant.brand_store_topology_draft_insert_guard();

CREATE FUNCTION bop_tenant.brand_store_topology_draft_coherent() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE original bop_tenant.brand_store_topology_draft_operation%ROWTYPE;
  source bop_tenant.brand_store_topology_draft_revision%ROWTYPE;
  current_xid xid;
BEGIN
  current_xid:=mod(pg_current_xact_id()::text::numeric,4294967296)::text::xid;
  IF TG_TABLE_SCHEMA<>'bop_tenant' OR TG_TABLE_NAME NOT IN ('brand_store_topology_draft_revision','brand_store_topology_draft_operation')
    OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT'
    OR (NEW.tenant_id::text=current_setting('bop.tenant_id',true) AND NEW.brand_id=platform_helpers.current_brand_id()) IS NOT TRUE THEN
    RAISE EXCEPTION 'BRAND_STORE_TOPOLOGY_SCOPE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  SELECT * INTO original FROM bop_tenant.brand_store_topology_draft_operation WHERE operation_id=NEW.operation_id AND xmin=current_xid;
  IF original.operation_id IS NULL THEN
    RAISE EXCEPTION 'BRAND_STORE_TOPOLOGY_ORIGINAL_MISSING' USING ERRCODE='23514';
  END IF;
  SELECT * INTO source FROM bop_tenant.brand_store_topology_draft_revision WHERE operation_id=NEW.operation_id AND xmin=current_xid;
  -- A historical or SAVEPOINT row cannot substitute for this same-top-level terminal operation.
  IF original.outcome='Abandoned' THEN
    IF EXISTS(SELECT 1 FROM bop_tenant.brand_store_topology_draft_revision WHERE operation_id=NEW.operation_id) THEN
      RAISE EXCEPTION 'BRAND_STORE_TOPOLOGY_OPERATION_ABANDONED' USING ERRCODE='23514';
    END IF;
  ELSIF source.operation_id IS NULL OR
    (source.tenant_id,source.brand_id,source.draft_id,source.revision,source.actor_id,source.audit_id,source.snapshot_digest,source.updated_at)
      IS DISTINCT FROM (original.tenant_id,original.brand_id,original.result_draft_id,original.result_revision,original.actor_id,original.audit_id,original.snapshot_digest,original.occurred_at)
    OR original.command_json->'content' IS DISTINCT FROM source.snapshot_json->'content' THEN
    RAISE EXCEPTION 'BRAND_STORE_TOPOLOGY_ORIGINAL_INCOHERENT' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bop_tenant.brand_store_topology_draft_coherent() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER brand_store_topology_revision_coherence AFTER INSERT ON bop_tenant.brand_store_topology_draft_revision
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_tenant.brand_store_topology_draft_coherent();
CREATE CONSTRAINT TRIGGER brand_store_topology_operation_coherence AFTER INSERT ON bop_tenant.brand_store_topology_draft_operation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bop_tenant.brand_store_topology_draft_coherent();
CREATE TRIGGER brand_store_topology_revision_no_mutation BEFORE UPDATE OR DELETE ON bop_tenant.brand_store_topology_draft_revision
  FOR EACH ROW EXECUTE FUNCTION bop_tenant.reject_brand_admin_history_update();
CREATE TRIGGER brand_store_topology_operation_no_mutation BEFORE UPDATE OR DELETE ON bop_tenant.brand_store_topology_draft_operation
  FOR EACH ROW EXECUTE FUNCTION bop_tenant.reject_brand_admin_history_update();
CREATE TRIGGER brand_store_topology_revision_no_truncate BEFORE TRUNCATE ON bop_tenant.brand_store_topology_draft_revision
  FOR EACH STATEMENT EXECUTE FUNCTION bop_tenant.reject_brand_admin_history_update();
CREATE TRIGGER brand_store_topology_operation_no_truncate BEFORE TRUNCATE ON bop_tenant.brand_store_topology_draft_operation
  FOR EACH STATEMENT EXECUTE FUNCTION bop_tenant.reject_brand_admin_history_update();
ALTER TABLE bop_tenant.brand_store_topology_draft_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.brand_store_topology_draft_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.brand_store_topology_draft_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_tenant.brand_store_topology_draft_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY brand_store_topology_revision_scope ON bop_tenant.brand_store_topology_draft_revision
  USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE)
  WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE);
CREATE POLICY brand_store_topology_operation_scope ON bop_tenant.brand_store_topology_draft_operation
  USING ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE)
  WITH CHECK ((tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL) IS TRUE);
REVOKE ALL ON TABLE bop_tenant.brand_store_topology_draft_revision FROM PUBLIC;
REVOKE ALL ON TABLE bop_tenant.brand_store_topology_draft_operation FROM PUBLIC;
