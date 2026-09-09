-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE SCHEMA rms_dining;
REVOKE ALL ON SCHEMA rms_dining FROM PUBLIC;

CREATE TABLE rms_dining.dining_table (
  table_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  table_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at)),
  observed_at timestamptz NOT NULL CHECK (observed_at >= created_at AND observed_at=date_trunc('milliseconds',observed_at)),
  CONSTRAINT dining_table_scoped_identity UNIQUE (tenant_id,brand_id,store_id,table_id),
  CONSTRAINT dining_table_snapshot_shape CHECK ((
    jsonb_typeof(table_snapshot)='object'
    AND octet_length(table_snapshot::text)<=32768
    AND table_snapshot ?& ARRAY['tableReference','tenantReference','brandReference','storeReference','stableLabel','areaReference','areaCode','capacity','accessibilityAttributes','lifecycle','qrStatus','qrVersion','operationalState','blockReasonCode','activeDiningSessionReference','aggregateVersion','createdAt','observedAt']
    AND table_snapshot - ARRAY['tableReference','tenantReference','brandReference','storeReference','stableLabel','areaReference','areaCode','capacity','accessibilityAttributes','lifecycle','qrStatus','qrVersion','operationalState','blockReasonCode','activeDiningSessionReference','aggregateVersion','createdAt','observedAt']='{}'::jsonb
  ) IS TRUE),
  CONSTRAINT dining_table_snapshot_identity CHECK ((
    table_snapshot->>'tableReference'=table_id::text
    AND table_snapshot->>'tenantReference'=tenant_id::text
    AND table_snapshot->>'brandReference'=brand_id::text
    AND table_snapshot->>'storeReference'=store_id::text
    AND jsonb_typeof(table_snapshot->'aggregateVersion')='number'
    AND (table_snapshot->>'aggregateVersion')::numeric=version
    AND (table_snapshot->>'createdAt')::timestamptz=created_at AND table_snapshot->>'createdAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    AND (table_snapshot->>'observedAt')::timestamptz=observed_at AND table_snapshot->>'observedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  ) IS TRUE),
  CONSTRAINT dining_table_snapshot_state CHECK ((
    table_snapshot->>'lifecycle' IN ('Draft','Published')
    AND table_snapshot->>'qrStatus' IN ('Inactive','Active','Revoked')
    AND table_snapshot->>'operationalState' IN ('Available','TemporarilyBlocked')
    AND jsonb_typeof(table_snapshot->'capacity')='number'
    AND (table_snapshot->>'capacity')::numeric BETWEEN 1 AND 1000
    AND (table_snapshot->>'capacity')::numeric=trunc((table_snapshot->>'capacity')::numeric)
    AND jsonb_typeof(table_snapshot->'qrVersion')='number'
    AND (table_snapshot->>'qrVersion')::numeric BETWEEN 0 AND 9007199254740991
    AND (table_snapshot->>'qrVersion')::numeric=trunc((table_snapshot->>'qrVersion')::numeric)
    AND ((table_snapshot->>'qrStatus'='Inactive')=((table_snapshot->>'qrVersion')::numeric=0))
    AND jsonb_typeof(table_snapshot->'accessibilityAttributes')='array'
    AND jsonb_array_length(table_snapshot->'accessibilityAttributes')<=16
    AND ((table_snapshot->>'operationalState'='TemporarilyBlocked')=(table_snapshot->'blockReasonCode'<>'null'::jsonb))
    AND (table_snapshot->>'lifecycle'<>'Draft' OR
      (table_snapshot->>'qrStatus'='Inactive' AND table_snapshot->>'operationalState'='Available'
       AND table_snapshot->'activeDiningSessionReference'='null'::jsonb))
  ) IS TRUE)
);

CREATE TABLE rms_dining.dining_table_operation (
  operation_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  table_id platform_helpers.uuid_v7 NOT NULL,
  result_version bigint NOT NULL CHECK (result_version BETWEEN 1 AND 9007199254740991),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  record_json jsonb NOT NULL,
  occurred_at timestamptz NOT NULL CHECK (occurred_at=date_trunc('milliseconds',occurred_at)),
  CONSTRAINT dining_table_operation_pk PRIMARY KEY (brand_id,store_id,operation_id),
  CONSTRAINT dining_table_operation_version UNIQUE (tenant_id,brand_id,store_id,table_id,result_version),
  CONSTRAINT dining_table_operation_table_fk FOREIGN KEY (tenant_id,brand_id,store_id,table_id)
    REFERENCES rms_dining.dining_table(tenant_id,brand_id,store_id,table_id),
  CONSTRAINT dining_table_operation_shape CHECK ((
    jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=131072
    AND record_json ?& ARRAY['operationReference','intentDigest','table','audit','event']
    AND record_json - ARRAY['operationReference','intentDigest','table','audit','event']='{}'::jsonb
    AND record_json->>'operationReference'=operation_id::text
    AND record_json->>'intentDigest'=intent_digest
    AND record_json->'table'->>'tableReference'=table_id::text
    AND record_json->'table'->>'tenantReference'=tenant_id::text
    AND record_json->'table'->>'brandReference'=brand_id::text
    AND record_json->'table'->>'storeReference'=store_id::text
    AND (record_json->'table'->>'aggregateVersion')::numeric=result_version
    AND (record_json->'table'->>'observedAt')::timestamptz=occurred_at AND record_json->'table'->>'observedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  ) IS TRUE)
);

CREATE RULE dining_table_no_delete AS ON DELETE TO rms_dining.dining_table DO INSTEAD NOTHING;
CREATE RULE dining_table_identity_version_guard AS ON UPDATE TO rms_dining.dining_table
  WHERE (OLD.table_id IS DISTINCT FROM NEW.table_id OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.brand_id IS DISTINCT FROM NEW.brand_id OR OLD.store_id IS DISTINCT FROM NEW.store_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at OR NEW.version<>OLD.version+1
    OR NEW.observed_at<OLD.observed_at)
  DO INSTEAD NOTHING;
CREATE RULE dining_table_operation_no_update AS ON UPDATE TO rms_dining.dining_table_operation DO INSTEAD NOTHING;
CREATE RULE dining_table_operation_no_delete AS ON DELETE TO rms_dining.dining_table_operation DO INSTEAD NOTHING;
CREATE INDEX dining_table_store_observed_idx ON rms_dining.dining_table (tenant_id,brand_id,store_id,observed_at DESC);

ALTER TABLE rms_dining.dining_table ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_table FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_table_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_table_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_table_scope_policy ON rms_dining.dining_table
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
CREATE POLICY dining_table_operation_scope_policy ON rms_dining.dining_table_operation
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_table FROM PUBLIC;
REVOKE ALL ON TABLE rms_dining.dining_table_operation FROM PUBLIC;
