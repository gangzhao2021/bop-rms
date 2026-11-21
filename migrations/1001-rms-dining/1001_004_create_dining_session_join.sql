-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_dining.dining_participant (
 participant_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,brand_id platform_helpers.uuid_v7 NOT NULL,store_id platform_helpers.uuid_v7 NOT NULL,session_id platform_helpers.uuid_v7 NOT NULL,
 version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),status text NOT NULL CHECK (status IN ('Active','Left')),
 participant_snapshot jsonb NOT NULL,
 CONSTRAINT dining_participant_scope_unique UNIQUE (tenant_id,brand_id,store_id,session_id,participant_id),
 CONSTRAINT dining_participant_session_fk FOREIGN KEY (tenant_id,brand_id,store_id,session_id) REFERENCES rms_dining.dining_session(tenant_id,brand_id,store_id,session_id),
 CONSTRAINT dining_participant_shape CHECK ((
jsonb_typeof(participant_snapshot)='object' AND participant_snapshot ?& ARRAY['participantReference','diningSessionReference','status','version','joinedAt','leftAt'] AND (participant_snapshot) - ARRAY['participantReference','diningSessionReference','status','version','joinedAt','leftAt']='{}'::jsonb
 AND participant_snapshot->>'participantReference'=participant_id::text AND participant_snapshot->>'diningSessionReference'=session_id::text
 AND participant_snapshot->>'status'=status AND jsonb_typeof(participant_snapshot->'version')='number' AND (participant_snapshot->>'version')::numeric=version
 AND participant_snapshot->>'joinedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
 AND (status<>'Active' OR (version=1 AND participant_snapshot->'leftAt'='null'::jsonb))
 AND (status<>'Left' OR (version=2 AND participant_snapshot->>'leftAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' AND (participant_snapshot->>'leftAt')::timestamptz >= (participant_snapshot->>'joinedAt')::timestamptz))
 ) IS TRUE)
);
CREATE TABLE rms_dining.dining_identity_admission (
 admission_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,brand_id platform_helpers.uuid_v7 NOT NULL,store_id platform_helpers.uuid_v7 NOT NULL,session_id platform_helpers.uuid_v7 NOT NULL,participant_id platform_helpers.uuid_v7 NOT NULL,
 version bigint NOT NULL CHECK (version IN (1,2)),status text NOT NULL CHECK (status IN ('Active','Consumed')),
 admission_snapshot jsonb NOT NULL,
 CONSTRAINT dining_identity_admission_participant_unique UNIQUE (participant_id),
 CONSTRAINT dining_identity_admission_participant_fk FOREIGN KEY (tenant_id,brand_id,store_id,session_id,participant_id) REFERENCES rms_dining.dining_participant(tenant_id,brand_id,store_id,session_id,participant_id),
 CONSTRAINT dining_identity_admission_shape CHECK ((
jsonb_typeof(admission_snapshot)='object' AND admission_snapshot ?& ARRAY['admissionReference','diningSessionReference','participantReference','storeReference','tableReference','tableAssignmentVersion','operationReference','operationIntentHash','status','version','issuedAt','consumedAt'] AND (admission_snapshot) - ARRAY['admissionReference','diningSessionReference','participantReference','storeReference','tableReference','tableAssignmentVersion','operationReference','operationIntentHash','status','version','issuedAt','consumedAt']='{}'::jsonb
 AND admission_snapshot->>'admissionReference'=admission_id::text AND admission_snapshot->>'diningSessionReference'=session_id::text AND admission_snapshot->>'participantReference'=participant_id::text AND admission_snapshot->>'storeReference'=store_id::text
 AND admission_snapshot->>'tableReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND admission_snapshot->>'operationReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND admission_snapshot->>'operationIntentHash' ~ '^[0-9a-f]{64}$'
 AND jsonb_typeof(admission_snapshot->'tableAssignmentVersion')='number' AND (admission_snapshot->>'tableAssignmentVersion')::numeric BETWEEN 1 AND 9007199254740991 AND (admission_snapshot->>'tableAssignmentVersion')::numeric=trunc((admission_snapshot->>'tableAssignmentVersion')::numeric)
 AND admission_snapshot->>'status'=status AND jsonb_typeof(admission_snapshot->'version')='number' AND (admission_snapshot->>'version')::numeric=version
 AND admission_snapshot->>'issuedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
 AND (status<>'Active' OR (version=1 AND admission_snapshot->'consumedAt'='null'::jsonb))
 AND (status<>'Consumed' OR (version=2 AND admission_snapshot->>'consumedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' AND (admission_snapshot->>'consumedAt')::timestamptz >= (admission_snapshot->>'issuedAt')::timestamptz))
 ) IS TRUE)
);
CREATE TABLE rms_dining.dining_session_join_operation (
 operation_id platform_helpers.uuid_v7 NOT NULL,
 tenant_id platform_helpers.uuid_v7 NOT NULL,brand_id platform_helpers.uuid_v7 NOT NULL,store_id platform_helpers.uuid_v7 NOT NULL,session_id platform_helpers.uuid_v7 NOT NULL,
 guest_session_id platform_helpers.uuid_v7 NOT NULL,participant_id platform_helpers.uuid_v7 NOT NULL,admission_id platform_helpers.uuid_v7 NOT NULL,capability_id platform_helpers.uuid_v7 NOT NULL,
 intent_hash text NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),record_json jsonb NOT NULL,
 CONSTRAINT dining_session_join_operation_pk PRIMARY KEY (brand_id,store_id,operation_id),
 CONSTRAINT dining_session_join_operation_guest_unique UNIQUE (tenant_id,brand_id,store_id,session_id,guest_session_id),
 CONSTRAINT dining_session_join_operation_participant_unique UNIQUE (participant_id),
 CONSTRAINT dining_session_join_operation_admission_unique UNIQUE (admission_id),
 CONSTRAINT dining_session_join_operation_capability_unique UNIQUE (capability_id),
 CONSTRAINT dining_session_join_operation_participant_fk FOREIGN KEY (tenant_id,brand_id,store_id,session_id,participant_id) REFERENCES rms_dining.dining_participant(tenant_id,brand_id,store_id,session_id,participant_id),
 CONSTRAINT dining_session_join_operation_admission_fk FOREIGN KEY (admission_id) REFERENCES rms_dining.dining_identity_admission(admission_id),
 CONSTRAINT dining_session_join_operation_capability_fk FOREIGN KEY (capability_id) REFERENCES rms_dining.dining_join_capability(capability_id),
 CONSTRAINT dining_session_join_operation_shape CHECK ((
 octet_length(record_json::text)<=32768 AND
jsonb_typeof(record_json)='object' AND record_json ?& ARRAY['session','participant','admission','capability','operationReference','operationIntentHash'] AND (record_json) - ARRAY['session','participant','admission','capability','operationReference','operationIntentHash']='{}'::jsonb
 AND record_json->>'operationReference'=operation_id::text AND record_json->>'operationIntentHash'=intent_hash
 AND jsonb_typeof(record_json->'session')='object' AND record_json->'session' ?& ARRAY['diningSessionReference','brandReference','storeReference','tableReference','tableAssignmentVersion','phase','version','startedByActorReference','startedAt','hostParticipantReference'] AND (record_json->'session') - ARRAY['diningSessionReference','brandReference','storeReference','tableReference','tableAssignmentVersion','phase','version','startedByActorReference','startedAt','hostParticipantReference']='{}'::jsonb
 AND jsonb_typeof(record_json->'participant')='object' AND record_json->'participant' ?& ARRAY['participantReference','diningSessionReference','status','version','joinedAt','leftAt'] AND (record_json->'participant') - ARRAY['participantReference','diningSessionReference','status','version','joinedAt','leftAt']='{}'::jsonb
 AND jsonb_typeof(record_json->'admission')='object' AND record_json->'admission' ?& ARRAY['admissionReference','diningSessionReference','participantReference','storeReference','tableReference','tableAssignmentVersion','operationReference','operationIntentHash','status','version','issuedAt','consumedAt'] AND (record_json->'admission') - ARRAY['admissionReference','diningSessionReference','participantReference','storeReference','tableReference','tableAssignmentVersion','operationReference','operationIntentHash','status','version','issuedAt','consumedAt']='{}'::jsonb
 AND jsonb_typeof(record_json->'capability')='object' AND record_json->'capability' ?& ARRAY['capabilityReference','purpose','kind','storeReference','tableReference','diningSessionReference','selectorHash','pepperVersion','assignmentVersion','generation','status','version','issuedAt','expiresAt','consumedAt','revokedAt'] AND (record_json->'capability') - ARRAY['capabilityReference','purpose','kind','storeReference','tableReference','diningSessionReference','selectorHash','pepperVersion','assignmentVersion','generation','status','version','issuedAt','expiresAt','consumedAt','revokedAt']='{}'::jsonb
 AND record_json->'session'->>'diningSessionReference'=session_id::text AND record_json->'session'->>'brandReference'=brand_id::text AND record_json->'session'->>'storeReference'=store_id::text
 AND record_json->'session'->>'phase'='Active' AND jsonb_typeof(record_json->'session'->'version')='number' AND (record_json->'session'->>'version')::numeric BETWEEN 2 AND 9007199254740991
 AND record_json->'session'->>'hostParticipantReference' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND record_json->'participant'->>'participantReference'=participant_id::text AND record_json->'participant'->>'diningSessionReference'=session_id::text
 AND record_json->'participant'->>'status'='Active' AND record_json->'participant'->'version'='1'::jsonb AND record_json->'participant'->'leftAt'='null'::jsonb
 AND record_json->'admission'->>'admissionReference'=admission_id::text AND record_json->'admission'->>'participantReference'=participant_id::text AND record_json->'admission'->>'diningSessionReference'=session_id::text AND record_json->'admission'->>'storeReference'=store_id::text
 AND record_json->'admission'->>'operationReference'=operation_id::text AND record_json->'admission'->>'operationIntentHash'=intent_hash
 AND record_json->'admission'->>'status'='Active' AND record_json->'admission'->'version'='1'::jsonb AND record_json->'admission'->'consumedAt'='null'::jsonb
 AND record_json->'capability'->>'capabilityReference'=capability_id::text AND record_json->'capability'->>'diningSessionReference'=session_id::text AND record_json->'capability'->>'storeReference'=store_id::text
 AND record_json->'capability'->>'purpose'='DiningJoin' AND record_json->'capability'->>'status'='Consumed' AND record_json->'capability'->'version'='2'::jsonb AND record_json->'capability'->'revokedAt'='null'::jsonb
 AND record_json->'capability'->>'selectorHash' ~ '^[0-9a-f]{64}$'
 AND record_json->'participant'->>'joinedAt'=record_json->'admission'->>'issuedAt' AND record_json->'participant'->>'joinedAt'=record_json->'capability'->>'consumedAt'
 AND record_json->'session'->>'tableReference'=record_json->'admission'->>'tableReference' AND record_json->'session'->>'tableReference'=record_json->'capability'->>'tableReference'
 AND record_json->'session'->'tableAssignmentVersion'=record_json->'admission'->'tableAssignmentVersion' AND record_json->'session'->'tableAssignmentVersion'=record_json->'capability'->'assignmentVersion'
 ) IS TRUE)
);
CREATE RULE dining_session_join_operation_no_update AS ON UPDATE TO rms_dining.dining_session_join_operation DO INSTEAD NOTHING;
CREATE RULE dining_session_join_operation_no_delete AS ON DELETE TO rms_dining.dining_session_join_operation DO INSTEAD NOTHING;
CREATE RULE dining_participant_no_delete AS ON DELETE TO rms_dining.dining_participant DO INSTEAD NOTHING;
CREATE RULE dining_participant_transition_guard AS ON UPDATE TO rms_dining.dining_participant
 WHERE (OLD.participant_id IS DISTINCT FROM NEW.participant_id OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.brand_id IS DISTINCT FROM NEW.brand_id OR OLD.store_id IS DISTINCT FROM NEW.store_id OR OLD.session_id IS DISTINCT FROM NEW.session_id OR OLD.status<>'Active' OR NEW.status<>'Left' OR NEW.version<>OLD.version+1 OR (OLD.participant_snapshot - ARRAY['status','version','leftAt']) IS DISTINCT FROM (NEW.participant_snapshot - ARRAY['status','version','leftAt'])) DO INSTEAD NOTHING;
CREATE RULE dining_identity_admission_no_delete AS ON DELETE TO rms_dining.dining_identity_admission DO INSTEAD NOTHING;
CREATE RULE dining_identity_admission_transition_guard AS ON UPDATE TO rms_dining.dining_identity_admission
 WHERE (OLD.admission_id IS DISTINCT FROM NEW.admission_id OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.brand_id IS DISTINCT FROM NEW.brand_id OR OLD.store_id IS DISTINCT FROM NEW.store_id OR OLD.session_id IS DISTINCT FROM NEW.session_id OR OLD.participant_id IS DISTINCT FROM NEW.participant_id OR OLD.status<>'Active' OR NEW.status<>'Consumed' OR NEW.version<>OLD.version+1 OR (OLD.admission_snapshot - ARRAY['status','version','consumedAt']) IS DISTINCT FROM (NEW.admission_snapshot - ARRAY['status','version','consumedAt'])) DO INSTEAD NOTHING;
ALTER TABLE rms_dining.dining_participant ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_participant FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_participant_scope_policy ON rms_dining.dining_participant USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_participant FROM PUBLIC;
ALTER TABLE rms_dining.dining_identity_admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_identity_admission FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_identity_admission_scope_policy ON rms_dining.dining_identity_admission USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_identity_admission FROM PUBLIC;
ALTER TABLE rms_dining.dining_session_join_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_session_join_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_session_join_operation_scope_policy ON rms_dining.dining_session_join_operation USING (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id()) WITH CHECK (brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_session_join_operation FROM PUBLIC;
