-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_dining.dining_session_move_operation (
  operation_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  session_id platform_helpers.uuid_v7 NOT NULL,
  source_table_id platform_helpers.uuid_v7 NOT NULL,
  target_table_id platform_helpers.uuid_v7 NOT NULL CHECK (source_table_id<>target_table_id),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL CHECK (occurred_at=date_trunc('milliseconds',occurred_at)),
  record_json jsonb NOT NULL,
  CONSTRAINT dining_session_move_operation_pk PRIMARY KEY (brand_id,store_id,operation_id),
  CONSTRAINT dining_session_move_operation_session_fk FOREIGN KEY (tenant_id,brand_id,store_id,session_id) REFERENCES rms_dining.dining_session(tenant_id,brand_id,store_id,session_id),
  CONSTRAINT dining_session_move_operation_source_fk FOREIGN KEY (tenant_id,brand_id,store_id,source_table_id) REFERENCES rms_dining.dining_table(tenant_id,brand_id,store_id,table_id),
  CONSTRAINT dining_session_move_operation_target_fk FOREIGN KEY (tenant_id,brand_id,store_id,target_table_id) REFERENCES rms_dining.dining_table(tenant_id,brand_id,store_id,table_id),
  CONSTRAINT dining_session_move_operation_shape CHECK ((
    jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=1048576
    AND record_json ?& ARRAY['command','operationReference','intentDigest','session','sourceTable','targetTable','audit','event']
    AND record_json - ARRAY['command','operationReference','intentDigest','session','sourceTable','targetTable','audit','event']='{}'::jsonb
    AND record_json->>'operationReference'=operation_id::text AND record_json->>'intentDigest'=intent_digest
    AND jsonb_typeof(record_json->'command')='object' AND record_json->'command' ?& ARRAY['operationReference','diningSessionReference','sourceTableReference','targetTableReference','expectedSessionVersion','expectedSourceTableVersion','expectedTargetTableVersion','partySize','observedAt']
    AND (record_json->'command') - ARRAY['operationReference','diningSessionReference','sourceTableReference','targetTableReference','expectedSessionVersion','expectedSourceTableVersion','expectedTargetTableVersion','partySize','observedAt']='{}'::jsonb
    AND jsonb_typeof(record_json->'session')='object' AND record_json->'session' ?& ARRAY['diningSessionReference','brandReference','storeReference','tableReference','tableAssignmentVersion','phase','version','startedByActorReference','startedAt','hostParticipantReference']
    AND (record_json->'session') - ARRAY['diningSessionReference','brandReference','storeReference','tableReference','tableAssignmentVersion','phase','version','startedByActorReference','startedAt','hostParticipantReference']='{}'::jsonb
    AND jsonb_typeof(record_json->'sourceTable')='object' AND record_json->'sourceTable' ?& ARRAY['tableReference','tenantReference','brandReference','storeReference','stableLabel','areaReference','areaCode','capacity','accessibilityAttributes','lifecycle','qrStatus','qrVersion','operationalState','blockReasonCode','activeDiningSessionReference','aggregateVersion','createdAt','observedAt']
    AND (record_json->'sourceTable') - ARRAY['tableReference','tenantReference','brandReference','storeReference','stableLabel','areaReference','areaCode','capacity','accessibilityAttributes','lifecycle','qrStatus','qrVersion','operationalState','blockReasonCode','activeDiningSessionReference','aggregateVersion','createdAt','observedAt']='{}'::jsonb
    AND jsonb_typeof(record_json->'targetTable')='object' AND record_json->'targetTable' ?& ARRAY['tableReference','tenantReference','brandReference','storeReference','stableLabel','areaReference','areaCode','capacity','accessibilityAttributes','lifecycle','qrStatus','qrVersion','operationalState','blockReasonCode','activeDiningSessionReference','aggregateVersion','createdAt','observedAt']
    AND (record_json->'targetTable') - ARRAY['tableReference','tenantReference','brandReference','storeReference','stableLabel','areaReference','areaCode','capacity','accessibilityAttributes','lifecycle','qrStatus','qrVersion','operationalState','blockReasonCode','activeDiningSessionReference','aggregateVersion','createdAt','observedAt']='{}'::jsonb
    AND jsonb_typeof(record_json->'event')='object' AND record_json->'event' ?& ARRAY['eventType','diningSessionReference','sourceTableReference','targetTableReference','aggregateVersion','occurredAt']
    AND (record_json->'event') - ARRAY['eventType','diningSessionReference','sourceTableReference','targetTableReference','aggregateVersion','occurredAt']='{}'::jsonb
    AND record_json->'command'->>'operationReference'=operation_id::text
    AND record_json->'command'->>'diningSessionReference'=session_id::text
    AND record_json->'command'->>'sourceTableReference'=source_table_id::text AND record_json->'command'->>'targetTableReference'=target_table_id::text
    AND (record_json->'command'->>'observedAt')::timestamptz=occurred_at
    AND record_json->'command'->>'observedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    AND jsonb_typeof(record_json->'command'->'expectedSessionVersion')='number' AND (record_json->'command'->>'expectedSessionVersion')::numeric BETWEEN 1 AND 9007199254740990
    AND (record_json->'command'->>'expectedSessionVersion')::numeric=trunc((record_json->'command'->>'expectedSessionVersion')::numeric)
    AND jsonb_typeof(record_json->'command'->'expectedSourceTableVersion')='number' AND (record_json->'command'->>'expectedSourceTableVersion')::numeric BETWEEN 1 AND 9007199254740990
    AND (record_json->'command'->>'expectedSourceTableVersion')::numeric=trunc((record_json->'command'->>'expectedSourceTableVersion')::numeric)
    AND jsonb_typeof(record_json->'command'->'expectedTargetTableVersion')='number' AND (record_json->'command'->>'expectedTargetTableVersion')::numeric BETWEEN 1 AND 9007199254740990
    AND (record_json->'command'->>'expectedTargetTableVersion')::numeric=trunc((record_json->'command'->>'expectedTargetTableVersion')::numeric)
    AND jsonb_typeof(record_json->'command'->'partySize')='number' AND (record_json->'command'->>'partySize')::numeric BETWEEN 1 AND 1000
    AND (record_json->'command'->>'partySize')::numeric=trunc((record_json->'command'->>'partySize')::numeric)
    AND record_json->'session'->>'diningSessionReference'=session_id::text
    AND record_json->'session'->>'brandReference'=brand_id::text AND record_json->'session'->>'storeReference'=store_id::text
    AND record_json->'session'->>'tableReference'=target_table_id::text AND record_json->'session'->>'phase'='Active'
    AND jsonb_typeof(record_json->'session'->'version')='number' AND (record_json->'session'->>'version')::numeric=(record_json->'command'->>'expectedSessionVersion')::numeric+1
    AND record_json->'session'->'tableAssignmentVersion'=record_json->'targetTable'->'aggregateVersion'
    AND (record_json->'session'->>'startedAt')::timestamptz<=occurred_at
    AND record_json->'sourceTable'->>'tableReference'=source_table_id::text AND record_json->'sourceTable'->>'tenantReference'=tenant_id::text
    AND record_json->'sourceTable'->>'brandReference'=brand_id::text AND record_json->'sourceTable'->>'storeReference'=store_id::text
    AND record_json->'sourceTable'->>'lifecycle'='Published' AND record_json->'sourceTable'->'observedAt'=record_json->'command'->'observedAt'
    AND jsonb_typeof(record_json->'sourceTable'->'aggregateVersion')='number' AND (record_json->'sourceTable'->>'aggregateVersion')::numeric=(record_json->'command'->>'expectedSourceTableVersion')::numeric+1
    AND record_json->'targetTable'->>'tableReference'=target_table_id::text AND record_json->'targetTable'->>'tenantReference'=tenant_id::text
    AND record_json->'targetTable'->>'brandReference'=brand_id::text AND record_json->'targetTable'->>'storeReference'=store_id::text
    AND record_json->'targetTable'->>'lifecycle'='Published' AND record_json->'targetTable'->'observedAt'=record_json->'command'->'observedAt'
    AND jsonb_typeof(record_json->'targetTable'->'aggregateVersion')='number' AND (record_json->'targetTable'->>'aggregateVersion')::numeric=(record_json->'command'->>'expectedTargetTableVersion')::numeric+1
    AND record_json->'sourceTable'->'activeDiningSessionReference'='null'::jsonb
    AND record_json->'targetTable'->>'activeDiningSessionReference'=session_id::text AND record_json->'targetTable'->>'operationalState'='Available'
    AND jsonb_typeof(record_json->'targetTable'->'capacity')='number' AND (record_json->'targetTable'->>'capacity')::numeric >= (record_json->'command'->>'partySize')::numeric
    AND jsonb_typeof(record_json->'audit')='object' AND record_json->'audit'->>'brandId'=brand_id::text AND record_json->'audit'->>'storeId'=store_id::text
    AND record_json->'audit' ?& ARRAY['auditId','brandId','storeId','actor','actionCode','targetType','targetId','reasonCode','correlationId','occurredAt','sourceChannel','dataClassification','retentionPolicyCode','retentionPolicyVersion']
    AND (record_json->'audit') - ARRAY['auditId','brandId','storeId','actor','actionCode','targetType','targetId','reasonCode','correlationId','occurredAt','sourceChannel','dataClassification','retentionPolicyCode','retentionPolicyVersion','beforeSummary','afterSummary','deviceNetworkReference','correctsAuditId']='{}'::jsonb
    AND jsonb_typeof(record_json->'audit'->'actor')='object' AND record_json->'audit'->'actor' ?& ARRAY['type','reference']
    AND (record_json->'audit'->'actor') - ARRAY['type','reference']='{}'::jsonb
    AND record_json->'audit'->'actor'->>'type'='User'  AND record_json->'audit'->>'actionCode'='DINING_SESSION_MOVE_TABLE'
    AND record_json->'audit'->>'targetType'='DiningSession' AND record_json->'audit'->>'targetId'=session_id::text
    AND record_json->'audit'->'occurredAt'=record_json->'command'->'observedAt'
    AND record_json->'event'->>'eventType'='DiningSessionTableMoved' AND record_json->'event'->>'diningSessionReference'=session_id::text
    AND record_json->'event'->>'sourceTableReference'=source_table_id::text AND record_json->'event'->>'targetTableReference'=target_table_id::text
    AND record_json->'event'->'occurredAt'=record_json->'command'->'observedAt'
    AND record_json->'event'->>'aggregateVersion'=record_json->'session'->>'version'
  ) IS TRUE)
);
CREATE RULE dining_session_move_operation_no_update AS ON UPDATE TO rms_dining.dining_session_move_operation DO INSTEAD NOTHING;
CREATE RULE dining_session_move_operation_no_delete AS ON DELETE TO rms_dining.dining_session_move_operation DO INSTEAD NOTHING;
ALTER TABLE rms_dining.dining_session_move_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_session_move_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_session_move_operation_scope_policy ON rms_dining.dining_session_move_operation
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_session_move_operation FROM PUBLIC;
