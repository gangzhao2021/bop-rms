-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_dining.dining_session (
  session_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  table_id platform_helpers.uuid_v7 NOT NULL,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  phase text NOT NULL CHECK (phase IN ('Active','Closing','Closed','Cancelled')),
  session_snapshot jsonb NOT NULL,
  started_at timestamptz NOT NULL CHECK (started_at=date_trunc('milliseconds',started_at)),
  CONSTRAINT dining_session_scoped_identity UNIQUE (tenant_id,brand_id,store_id,session_id),
  CONSTRAINT dining_session_table_fk FOREIGN KEY (tenant_id,brand_id,store_id,table_id)
    REFERENCES rms_dining.dining_table(tenant_id,brand_id,store_id,table_id),
  CONSTRAINT dining_session_snapshot_shape CHECK ((
    jsonb_typeof(session_snapshot)='object' AND octet_length(session_snapshot::text)<=16384
    AND session_snapshot ?& ARRAY['diningSessionReference','brandReference','storeReference','tableReference','tableAssignmentVersion','phase','version','startedByActorReference','startedAt','hostParticipantReference']
    AND session_snapshot - ARRAY['diningSessionReference','brandReference','storeReference','tableReference','tableAssignmentVersion','phase','version','startedByActorReference','startedAt','hostParticipantReference']='{}'::jsonb
    AND session_snapshot->>'diningSessionReference'=session_id::text
    AND session_snapshot->>'brandReference'=brand_id::text AND session_snapshot->>'storeReference'=store_id::text
    AND session_snapshot->>'tableReference'=table_id::text AND session_snapshot->>'phase'=phase
    AND jsonb_typeof(session_snapshot->'version')='number' AND (session_snapshot->>'version')::numeric=version
    AND jsonb_typeof(session_snapshot->'tableAssignmentVersion')='number'
    AND (session_snapshot->>'tableAssignmentVersion')::numeric BETWEEN 1 AND 9007199254740991
    AND (session_snapshot->>'tableAssignmentVersion')::numeric=trunc((session_snapshot->>'tableAssignmentVersion')::numeric)
    AND session_snapshot->>'startedByActorReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND (session_snapshot->'hostParticipantReference'='null'::jsonb OR session_snapshot->>'hostParticipantReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    AND (session_snapshot->>'startedAt')::timestamptz=started_at
    AND session_snapshot->>'startedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  ) IS TRUE)
);
CREATE UNIQUE INDEX dining_session_open_table_idx ON rms_dining.dining_session (tenant_id,brand_id,store_id,table_id) WHERE phase IN ('Active','Closing');

CREATE TABLE rms_dining.dining_join_capability (
  capability_id platform_helpers.uuid_v7 PRIMARY KEY,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  session_id platform_helpers.uuid_v7 NOT NULL,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  status text NOT NULL CHECK (status IN ('Active','Consumed','Revoked','Expired')),
  capability_snapshot jsonb NOT NULL,
  CONSTRAINT dining_join_capability_session_fk FOREIGN KEY (tenant_id,brand_id,store_id,session_id)
    REFERENCES rms_dining.dining_session(tenant_id,brand_id,store_id,session_id),
  CONSTRAINT dining_join_capability_snapshot_shape CHECK ((
    jsonb_typeof(capability_snapshot)='object' AND octet_length(capability_snapshot::text)<=16384
    AND capability_snapshot ?& ARRAY['capabilityReference','purpose','kind','storeReference','tableReference','diningSessionReference','selectorHash','pepperVersion','assignmentVersion','generation','status','version','issuedAt','expiresAt','consumedAt','revokedAt']
    AND capability_snapshot - ARRAY['capabilityReference','purpose','kind','storeReference','tableReference','diningSessionReference','selectorHash','pepperVersion','assignmentVersion','generation','status','version','issuedAt','expiresAt','consumedAt','revokedAt']='{}'::jsonb
    AND capability_snapshot->>'capabilityReference'=capability_id::text
    AND capability_snapshot->>'storeReference'=store_id::text AND capability_snapshot->>'diningSessionReference'=session_id::text
    AND capability_snapshot->>'purpose'='DiningJoin' AND capability_snapshot->>'kind' IN ('Invitation','HumanCode')
    AND capability_snapshot->>'selectorHash' ~ '^[0-9a-f]{64}$'
    AND capability_snapshot->>'tableReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND capability_snapshot->>'status'=status
    AND jsonb_typeof(capability_snapshot->'version')='number' AND (capability_snapshot->>'version')::numeric=version
    AND jsonb_typeof(capability_snapshot->'pepperVersion')='number' AND (capability_snapshot->>'pepperVersion')::numeric BETWEEN 1 AND 9007199254740991
    AND (capability_snapshot->>'pepperVersion')::numeric=trunc((capability_snapshot->>'pepperVersion')::numeric)
    AND jsonb_typeof(capability_snapshot->'assignmentVersion')='number' AND (capability_snapshot->>'assignmentVersion')::numeric BETWEEN 1 AND 9007199254740991
    AND (capability_snapshot->>'assignmentVersion')::numeric=trunc((capability_snapshot->>'assignmentVersion')::numeric)
    AND jsonb_typeof(capability_snapshot->'generation')='number' AND (capability_snapshot->>'generation')::numeric BETWEEN 1 AND 9007199254740991
    AND (capability_snapshot->>'generation')::numeric=trunc((capability_snapshot->>'generation')::numeric)
    AND capability_snapshot->>'issuedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    AND capability_snapshot->>'expiresAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    AND (capability_snapshot->>'expiresAt')::timestamptz>(capability_snapshot->>'issuedAt')::timestamptz
    AND (capability_snapshot->>'expiresAt')::timestamptz<=(capability_snapshot->>'issuedAt')::timestamptz+interval '15 minutes'
    AND (status<>'Active' OR (version=1 AND capability_snapshot->'consumedAt'='null'::jsonb AND capability_snapshot->'revokedAt'='null'::jsonb))
    AND (status='Active' OR version=2)
    AND (status<>'Consumed' OR ((capability_snapshot->>'consumedAt')::timestamptz >= (capability_snapshot->>'issuedAt')::timestamptz AND (capability_snapshot->>'consumedAt')::timestamptz < (capability_snapshot->>'expiresAt')::timestamptz AND capability_snapshot->'revokedAt'='null'::jsonb))
    AND (status<>'Consumed' OR capability_snapshot->>'consumedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')
    AND (status='Consumed' OR capability_snapshot->'consumedAt'='null'::jsonb)
    AND (status<>'Revoked' OR (capability_snapshot->>'revokedAt')::timestamptz >= (capability_snapshot->>'issuedAt')::timestamptz)
    AND (status<>'Revoked' OR capability_snapshot->>'revokedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')
    AND (status='Revoked' OR capability_snapshot->'revokedAt'='null'::jsonb)
  ) IS TRUE)
);
CREATE UNIQUE INDEX dining_join_capability_active_session_idx ON rms_dining.dining_join_capability (tenant_id,brand_id,store_id,session_id) WHERE status='Active';

CREATE TABLE rms_dining.dining_session_start_operation (
  operation_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  session_id platform_helpers.uuid_v7 NOT NULL,
  intent_hash text NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
  record_json jsonb NOT NULL,
  CONSTRAINT dining_session_start_operation_pk PRIMARY KEY (brand_id,store_id,operation_id),
  CONSTRAINT dining_session_start_operation_session UNIQUE (tenant_id,brand_id,store_id,session_id),
  CONSTRAINT dining_session_start_operation_session_fk FOREIGN KEY (tenant_id,brand_id,store_id,session_id)
    REFERENCES rms_dining.dining_session(tenant_id,brand_id,store_id,session_id),
  CONSTRAINT dining_session_start_operation_shape CHECK ((
    jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=65536
    AND record_json ?& ARRAY['session','capability','operationReference','operationIntentHash']
    AND record_json - ARRAY['session','capability','operationReference','operationIntentHash']='{}'::jsonb
    AND record_json->>'operationReference'=operation_id::text AND record_json->>'operationIntentHash'=intent_hash
    AND jsonb_typeof(record_json->'session')='object' AND jsonb_typeof(record_json->'capability')='object'
    AND record_json->'session' ?& ARRAY['diningSessionReference','brandReference','storeReference','tableReference','tableAssignmentVersion','phase','version','startedByActorReference','startedAt','hostParticipantReference']
    AND (record_json->'session') - ARRAY['diningSessionReference','brandReference','storeReference','tableReference','tableAssignmentVersion','phase','version','startedByActorReference','startedAt','hostParticipantReference']='{}'::jsonb
    AND record_json->'capability' ?& ARRAY['capabilityReference','purpose','kind','storeReference','tableReference','diningSessionReference','selectorHash','pepperVersion','assignmentVersion','generation','status','version','issuedAt','expiresAt','consumedAt','revokedAt']
    AND (record_json->'capability') - ARRAY['capabilityReference','purpose','kind','storeReference','tableReference','diningSessionReference','selectorHash','pepperVersion','assignmentVersion','generation','status','version','issuedAt','expiresAt','consumedAt','revokedAt']='{}'::jsonb
    AND record_json->'session'->>'phase'='Active' AND record_json->'session'->'version'='1'::jsonb AND record_json->'session'->'hostParticipantReference'='null'::jsonb
    AND record_json->'capability'->>'purpose'='DiningJoin' AND record_json->'capability'->>'status'='Active'
    AND record_json->'capability'->'version'='1'::jsonb AND record_json->'capability'->'generation'='1'::jsonb
    AND record_json->'capability'->'consumedAt'='null'::jsonb AND record_json->'capability'->'revokedAt'='null'::jsonb
    AND record_json->'capability'->>'selectorHash' ~ '^[0-9a-f]{64}$'
    AND record_json->'capability'->>'issuedAt'=record_json->'session'->>'startedAt'
    AND record_json->'capability'->>'tableReference'=record_json->'session'->>'tableReference'
    AND record_json->'capability'->'assignmentVersion'=record_json->'session'->'tableAssignmentVersion'
    AND record_json->'session'->>'diningSessionReference'=session_id::text
    AND record_json->'session'->>'brandReference'=brand_id::text AND record_json->'session'->>'storeReference'=store_id::text
    AND record_json->'capability'->>'diningSessionReference'=session_id::text AND record_json->'capability'->>'storeReference'=store_id::text
  ) IS TRUE)
);

CREATE RULE dining_session_no_delete AS ON DELETE TO rms_dining.dining_session DO INSTEAD NOTHING;
CREATE RULE dining_session_identity_version_guard AS ON UPDATE TO rms_dining.dining_session
  WHERE (OLD.session_id IS DISTINCT FROM NEW.session_id OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.brand_id IS DISTINCT FROM NEW.brand_id OR OLD.store_id IS DISTINCT FROM NEW.store_id OR OLD.started_at IS DISTINCT FROM NEW.started_at OR OLD.session_snapshot->>'startedByActorReference' IS DISTINCT FROM NEW.session_snapshot->>'startedByActorReference' OR NEW.version<>OLD.version+1)
  DO INSTEAD NOTHING;
CREATE RULE dining_join_capability_no_delete AS ON DELETE TO rms_dining.dining_join_capability DO INSTEAD NOTHING;
CREATE RULE dining_join_capability_identity_version_guard AS ON UPDATE TO rms_dining.dining_join_capability
  WHERE (OLD.capability_id IS DISTINCT FROM NEW.capability_id OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.brand_id IS DISTINCT FROM NEW.brand_id OR OLD.store_id IS DISTINCT FROM NEW.store_id OR OLD.session_id IS DISTINCT FROM NEW.session_id OR NEW.version<>OLD.version+1 OR OLD.status<>'Active' OR NEW.status='Active' OR (OLD.capability_snapshot - ARRAY['status','version','consumedAt','revokedAt']) IS DISTINCT FROM (NEW.capability_snapshot - ARRAY['status','version','consumedAt','revokedAt']))
  DO INSTEAD NOTHING;
CREATE RULE dining_session_start_operation_no_update AS ON UPDATE TO rms_dining.dining_session_start_operation DO INSTEAD NOTHING;
CREATE RULE dining_session_start_operation_no_delete AS ON DELETE TO rms_dining.dining_session_start_operation DO INSTEAD NOTHING;

ALTER TABLE rms_dining.dining_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_session FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_join_capability ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_join_capability FORCE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_session_start_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_session_start_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_session_scope_policy ON rms_dining.dining_session USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
CREATE POLICY dining_join_capability_scope_policy ON rms_dining.dining_join_capability USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
CREATE POLICY dining_session_start_operation_scope_policy ON rms_dining.dining_session_start_operation USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_session,rms_dining.dining_join_capability,rms_dining.dining_session_start_operation FROM PUBLIC;
