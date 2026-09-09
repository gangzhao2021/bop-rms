-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_dining.dining_closing_operation (
  operation_id platform_helpers.uuid_v7 NOT NULL,
  tenant_id platform_helpers.uuid_v7 NOT NULL,
  brand_id platform_helpers.uuid_v7 NOT NULL,
  store_id platform_helpers.uuid_v7 NOT NULL,
  session_id platform_helpers.uuid_v7 NOT NULL,
  action text NOT NULL CHECK (action IN ('Begin','Cancel','Finalize')),
  expected_version bigint NOT NULL CHECK (expected_version BETWEEN 1 AND 9007199254740990),
  intent_hash text NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
  requested_at text NOT NULL CHECK (
    requested_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    AND to_char(requested_at::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=requested_at
  ),
  record_json jsonb NOT NULL,
  CONSTRAINT dining_closing_operation_pk PRIMARY KEY (brand_id,store_id,operation_id),
  CONSTRAINT dining_closing_operation_session_fk FOREIGN KEY (tenant_id,brand_id,store_id,session_id)
    REFERENCES rms_dining.dining_session(tenant_id,brand_id,store_id,session_id),
  CONSTRAINT dining_closing_operation_shape CHECK ((
    jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=1048576
    AND record_json ?& ARRAY['action','session','operationReference','operationIntentHash','closureEvidenceDigest','taskReferences']
    AND record_json - ARRAY['action','session','operationReference','operationIntentHash','closureEvidenceDigest','taskReferences']='{}'::jsonb
    AND record_json->>'action'=action AND record_json->>'operationReference'=operation_id::text
    AND record_json->>'operationIntentHash'=intent_hash
    AND jsonb_typeof(record_json->'session')='object'
    AND record_json->'session' ?& ARRAY['diningSessionReference','brandReference','storeReference','tableReference','tableAssignmentVersion','phase','version','startedByActorReference','startedAt','hostParticipantReference']
    AND (record_json->'session') - ARRAY['diningSessionReference','brandReference','storeReference','tableReference','tableAssignmentVersion','phase','version','startedByActorReference','startedAt','hostParticipantReference']='{}'::jsonb
    AND record_json->'session'->>'diningSessionReference'=session_id::text
    AND record_json->'session'->>'brandReference'=brand_id::text AND record_json->'session'->>'storeReference'=store_id::text
    AND record_json->'session'->>'phase'=CASE action WHEN 'Begin' THEN 'Closing' WHEN 'Cancel' THEN 'Active' ELSE 'Closed' END
    AND jsonb_typeof(record_json->'session'->'version')='number'
    AND (record_json->'session'->>'version')::numeric=expected_version+1
    AND jsonb_typeof(record_json->'session'->'tableAssignmentVersion')='number'
    AND (record_json->'session'->>'tableAssignmentVersion')::numeric BETWEEN 1 AND 9007199254740991
    AND (record_json->'session'->>'tableAssignmentVersion')::numeric=trunc((record_json->'session'->>'tableAssignmentVersion')::numeric)
    AND record_json->'session'->>'tableReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND record_json->'session'->>'startedByActorReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND (record_json->'session'->'hostParticipantReference'='null'::jsonb OR record_json->'session'->>'hostParticipantReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    AND record_json->'session'->>'startedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    AND (record_json->'session'->>'startedAt')::timestamptz<=requested_at::timestamptz
    AND jsonb_typeof(record_json->'taskReferences')='array'
    AND NOT jsonb_path_exists(record_json,'$.taskReferences[*] ? (@.type() != "string" || !(@ like_regex "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"))')
    AND (CASE WHEN action='Finalize' THEN jsonb_typeof(record_json->'closureEvidenceDigest')='string' AND record_json->>'closureEvidenceDigest' ~ '^[0-9a-f]{64}$'
      ELSE record_json->'closureEvidenceDigest'='null'::jsonb AND record_json->'taskReferences'='[]'::jsonb END)
  ) IS TRUE)
);
CREATE RULE dining_closing_operation_no_update AS ON UPDATE TO rms_dining.dining_closing_operation DO INSTEAD NOTHING;
CREATE RULE dining_closing_operation_no_delete AS ON DELETE TO rms_dining.dining_closing_operation DO INSTEAD NOTHING;
ALTER TABLE rms_dining.dining_closing_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_closing_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_closing_operation_scope_policy ON rms_dining.dining_closing_operation
  USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
  WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_closing_operation FROM PUBLIC;
