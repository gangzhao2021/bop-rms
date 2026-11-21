-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_dining.dining_table_release_operation (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 session_id platform_helpers.uuid_v7 NOT NULL,
 table_id platform_helpers.uuid_v7 NOT NULL,
 expected_session_version bigint NOT NULL CHECK(expected_session_version BETWEEN 1 AND 9007199254740991),
 expected_table_version bigint NOT NULL CHECK(expected_table_version BETWEEN 1 AND 9007199254740990),
 intent_digest text NOT NULL CHECK(intent_digest ~ '^sha256:[a-f0-9]{64}$'),
 occurred_at timestamptz NOT NULL CHECK(occurred_at=date_trunc('milliseconds',occurred_at)),
 record_json jsonb NOT NULL,
 PRIMARY KEY(brand_id,store_id,operation_id),
 UNIQUE(brand_id,store_id,session_id),
 UNIQUE(brand_id,store_id,table_id,expected_table_version),
 FOREIGN KEY(tenant_id,brand_id,store_id,session_id) REFERENCES rms_dining.dining_session(tenant_id,brand_id,store_id,session_id),
 FOREIGN KEY(tenant_id,brand_id,store_id,table_id) REFERENCES rms_dining.dining_table(tenant_id,brand_id,store_id,table_id),
 CHECK((jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=1048576
  AND record_json ?& ARRAY['command','intentDigest','session','beforeTable','afterTable','audit']
  AND record_json-ARRAY['command','intentDigest','session','beforeTable','afterTable','audit']='{}'::jsonb
  AND record_json->>'intentDigest'=intent_digest
  AND record_json#>>'{command,operationReference}'=operation_id::text
  AND record_json#>>'{command,diningSessionReference}'=session_id::text
  AND record_json#>>'{command,tableReference}'=table_id::text
  AND record_json#>>'{command,expectedSessionVersion}'=expected_session_version::text
  AND record_json#>>'{command,expectedTableVersion}'=expected_table_version::text
  AND (record_json#>>'{command,observedAt}')::timestamptz=occurred_at
  AND record_json#>>'{session,phase}'='Closed'
  AND record_json#>>'{session,diningSessionReference}'=session_id::text
  AND record_json#>>'{beforeTable,tenantReference}'=tenant_id::text
  AND record_json#>>'{beforeTable,brandReference}'=brand_id::text
  AND record_json#>>'{beforeTable,storeReference}'=store_id::text
  AND record_json#>>'{beforeTable,tableReference}'=table_id::text
  AND record_json#>>'{beforeTable,activeDiningSessionReference}'=session_id::text
  AND record_json#>>'{beforeTable,aggregateVersion}'=expected_table_version::text
  AND record_json->'afterTable'=(record_json->'beforeTable')||jsonb_build_object('activeDiningSessionReference',NULL,'aggregateVersion',expected_table_version+1,'observedAt',record_json#>>'{command,observedAt}')
  AND record_json#>>'{audit,actionCode}'='DINING_TABLE_RELEASED'
  AND record_json#>>'{audit,correlationId}'=operation_id::text
  AND record_json#>>'{audit,actor,type}'='User') IS TRUE)
);
CREATE FUNCTION rms_dining.validate_table_release_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM rms_dining.dining_session WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND session_id=NEW.session_id AND phase='Closed' AND version=NEW.expected_session_version AND session_snapshot=NEW.record_json->'session')
 OR NOT EXISTS(SELECT 1 FROM rms_dining.dining_table WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND table_id=NEW.table_id AND version=NEW.expected_table_version+1 AND table_snapshot=NEW.record_json->'afterTable') THEN
 RAISE EXCEPTION 'release source mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION rms_dining.validate_table_release_insert() FROM PUBLIC;
CREATE TRIGGER dining_table_release_source BEFORE INSERT ON rms_dining.dining_table_release_operation FOR EACH ROW EXECUTE FUNCTION rms_dining.validate_table_release_insert();
CREATE FUNCTION rms_dining.reject_table_release_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$ BEGIN RAISE EXCEPTION 'immutable table release history' USING ERRCODE='55000'; END; $$;
REVOKE ALL ON FUNCTION rms_dining.reject_table_release_mutation() FROM PUBLIC;
CREATE TRIGGER dining_table_release_no_mutation BEFORE UPDATE OR DELETE ON rms_dining.dining_table_release_operation FOR EACH ROW EXECUTE FUNCTION rms_dining.reject_table_release_mutation();
CREATE TRIGGER dining_table_release_no_truncate BEFORE TRUNCATE ON rms_dining.dining_table_release_operation FOR EACH STATEMENT EXECUTE FUNCTION rms_dining.reject_table_release_mutation();
ALTER TABLE rms_dining.dining_table_release_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_table_release_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_table_release_scope ON rms_dining.dining_table_release_operation
 USING(brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK(brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_table_release_operation FROM PUBLIC;
