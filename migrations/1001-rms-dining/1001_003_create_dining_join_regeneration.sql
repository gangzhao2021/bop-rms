-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE UNIQUE INDEX dining_join_capability_generation_idx ON rms_dining.dining_join_capability (tenant_id,brand_id,store_id,session_id,((capability_snapshot->>'generation')::numeric));
CREATE TABLE rms_dining.dining_join_regeneration_operation (
  operation_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  session_id platform_helpers.uuid_v7 NOT NULL,
  capability_id platform_helpers.uuid_v7 NOT NULL,
  actor_id platform_helpers.uuid_v7 NOT NULL,
  intent_hash text NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
  record_json jsonb NOT NULL,
  occurred_at timestamptz NOT NULL CHECK (occurred_at=date_trunc('milliseconds',occurred_at)),
  CONSTRAINT dining_join_regeneration_operation_pk PRIMARY KEY (brand_id,store_id,operation_id),
  CONSTRAINT dining_join_regeneration_operation_capability UNIQUE (capability_id),
  CONSTRAINT dining_join_regeneration_operation_session_fk FOREIGN KEY (tenant_id,brand_id,store_id,session_id)
    REFERENCES rms_dining.dining_session(tenant_id,brand_id,store_id,session_id),
  CONSTRAINT dining_join_regeneration_operation_capability_fk FOREIGN KEY (capability_id) REFERENCES rms_dining.dining_join_capability(capability_id),
  CONSTRAINT dining_join_regeneration_operation_shape CHECK ((
    jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=32768
    AND record_json ?& ARRAY['capability','operationReference','operationIntentHash']
    AND record_json - ARRAY['capability','operationReference','operationIntentHash']='{}'::jsonb
    AND record_json->>'operationReference'=operation_id::text AND record_json->>'operationIntentHash'=intent_hash
    AND jsonb_typeof(record_json->'capability')='object'
    AND record_json->'capability' ?& ARRAY['capabilityReference','purpose','kind','storeReference','tableReference','diningSessionReference','selectorHash','pepperVersion','assignmentVersion','generation','status','version','issuedAt','expiresAt','consumedAt','revokedAt']
    AND (record_json->'capability') - ARRAY['capabilityReference','purpose','kind','storeReference','tableReference','diningSessionReference','selectorHash','pepperVersion','assignmentVersion','generation','status','version','issuedAt','expiresAt','consumedAt','revokedAt']='{}'::jsonb
    AND record_json->'capability'->>'capabilityReference'=capability_id::text
    AND record_json->'capability'->>'diningSessionReference'=session_id::text AND record_json->'capability'->>'storeReference'=store_id::text
    AND record_json->'capability'->>'purpose'='DiningJoin' AND record_json->'capability'->>'kind' IN ('Invitation','HumanCode')
    AND record_json->'capability'->>'status'='Active' AND record_json->'capability'->'version'='1'::jsonb
    AND record_json->'capability'->'consumedAt'='null'::jsonb AND record_json->'capability'->'revokedAt'='null'::jsonb
    AND record_json->'capability'->>'selectorHash' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(record_json->'capability'->'generation')='number' AND (record_json->'capability'->>'generation')::numeric BETWEEN 2 AND 9007199254740991
    AND (record_json->'capability'->>'generation')::numeric=trunc((record_json->'capability'->>'generation')::numeric)
    AND (record_json->'capability'->>'issuedAt')::timestamptz=occurred_at
    AND record_json->'capability'->>'issuedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  ) IS TRUE)
);
CREATE RULE dining_join_regeneration_operation_no_update AS ON UPDATE TO rms_dining.dining_join_regeneration_operation DO INSTEAD NOTHING;
CREATE RULE dining_join_regeneration_operation_no_delete AS ON DELETE TO rms_dining.dining_join_regeneration_operation DO INSTEAD NOTHING;
ALTER TABLE rms_dining.dining_join_regeneration_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_join_regeneration_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_join_regeneration_operation_scope_policy ON rms_dining.dining_join_regeneration_operation
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_join_regeneration_operation FROM PUBLIC;
