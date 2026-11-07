-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE UNIQUE INDEX dining_admission_consumption_admission_identity ON rms_dining.dining_identity_admission
 (tenant_id,brand_id,store_id,session_id,participant_id,admission_id);
CREATE UNIQUE INDEX dining_admission_consumption_join_identity ON rms_dining.dining_session_join_operation
 (tenant_id,brand_id,store_id,admission_id,guest_session_id,operation_id);
CREATE TABLE rms_dining.dining_admission_consumption_operation (
 operation_id platform_helpers.uuid_v7 NOT NULL,
 tenant_id platform_helpers.uuid_v7 NOT NULL,brand_id platform_helpers.uuid_v7 NOT NULL,store_id platform_helpers.uuid_v7 NOT NULL,
 session_id platform_helpers.uuid_v7 NOT NULL,participant_id platform_helpers.uuid_v7 NOT NULL,admission_id platform_helpers.uuid_v7 NOT NULL,
 guest_session_id platform_helpers.uuid_v7 NOT NULL,join_operation_id platform_helpers.uuid_v7 NOT NULL,
 intent_hash text NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),record_json jsonb NOT NULL,consumed_at timestamptz NOT NULL,
 CONSTRAINT dining_admission_consumption_pk PRIMARY KEY (brand_id,store_id,operation_id),
 CONSTRAINT dining_admission_consumption_once UNIQUE (admission_id),
 CONSTRAINT dining_admission_consumption_admission_fk FOREIGN KEY (tenant_id,brand_id,store_id,session_id,participant_id,admission_id)
  REFERENCES rms_dining.dining_identity_admission(tenant_id,brand_id,store_id,session_id,participant_id,admission_id),
 CONSTRAINT dining_admission_consumption_join_fk FOREIGN KEY (tenant_id,brand_id,store_id,admission_id,guest_session_id,join_operation_id)
  REFERENCES rms_dining.dining_session_join_operation(tenant_id,brand_id,store_id,admission_id,guest_session_id,operation_id),
 CONSTRAINT dining_admission_consumption_shape CHECK ((
  octet_length(record_json::text)<=16384 AND jsonb_typeof(record_json)='object'
  AND record_json ?& ARRAY['operationReference','operationIntentHash','guestSessionReference','admission']
  AND record_json - ARRAY['operationReference','operationIntentHash','guestSessionReference','admission']='{}'::jsonb
  AND record_json->>'operationReference'=operation_id::text AND record_json->>'guestSessionReference'=guest_session_id::text
  AND jsonb_typeof(record_json->'operationIntentHash')='string' AND record_json->>'operationIntentHash'=intent_hash
  AND jsonb_typeof(record_json->'admission')='object'
  AND record_json->'admission' ?& ARRAY['admissionReference','diningSessionReference','participantReference','storeReference','tableReference','tableAssignmentVersion','operationReference','operationIntentHash','status','version','issuedAt','consumedAt']
  AND (record_json->'admission') - ARRAY['admissionReference','diningSessionReference','participantReference','storeReference','tableReference','tableAssignmentVersion','operationReference','operationIntentHash','status','version','issuedAt','consumedAt']='{}'::jsonb
  AND record_json->'admission'->>'admissionReference'=admission_id::text AND record_json->'admission'->>'diningSessionReference'=session_id::text
  AND record_json->'admission'->>'participantReference'=participant_id::text AND record_json->'admission'->>'storeReference'=store_id::text
  AND record_json->'admission'->>'operationReference'=join_operation_id::text
  AND jsonb_typeof(record_json->'admission'->'operationIntentHash')='string' AND record_json->'admission'->>'operationIntentHash' ~ '^[0-9a-f]{64}$'
  AND record_json->'admission'->>'tableReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND jsonb_typeof(record_json->'admission'->'tableAssignmentVersion')='number'
  AND (record_json->'admission'->>'tableAssignmentVersion')::numeric BETWEEN 1 AND 9007199254740991
  AND (record_json->'admission'->>'tableAssignmentVersion')::numeric=trunc((record_json->'admission'->>'tableAssignmentVersion')::numeric)
  AND record_json->'admission'->>'status'='Consumed' AND record_json->'admission'->'version'='2'::jsonb
  AND record_json->'admission'->>'issuedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  AND record_json->'admission'->>'consumedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  AND (record_json->'admission'->>'consumedAt')::timestamptz=consumed_at
  AND consumed_at >= (record_json->'admission'->>'issuedAt')::timestamptz
 ) IS TRUE)
);
CREATE RULE dining_admission_consumption_no_update AS ON UPDATE TO rms_dining.dining_admission_consumption_operation DO INSTEAD NOTHING;
CREATE RULE dining_admission_consumption_no_delete AS ON DELETE TO rms_dining.dining_admission_consumption_operation DO INSTEAD NOTHING;
ALTER TABLE rms_dining.dining_admission_consumption_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_admission_consumption_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_admission_consumption_scope_policy ON rms_dining.dining_admission_consumption_operation
 USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_admission_consumption_operation FROM PUBLIC;
