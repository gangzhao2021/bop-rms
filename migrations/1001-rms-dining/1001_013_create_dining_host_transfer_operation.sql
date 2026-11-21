-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
CREATE TABLE rms_dining.dining_host_transfer_operation (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 operation_id platform_helpers.uuid_v7 NOT NULL,
 session_id platform_helpers.uuid_v7 NOT NULL,
 target_participant_id platform_helpers.uuid_v7 NOT NULL,
 expected_version bigint NOT NULL CHECK(expected_version BETWEEN 1 AND 2147483646),
 occurred_at timestamptz NOT NULL CHECK(occurred_at=date_trunc('milliseconds',occurred_at)),
 record_json jsonb NOT NULL,
 PRIMARY KEY(brand_id,store_id,operation_id),
 UNIQUE(brand_id,store_id,session_id,expected_version),
 FOREIGN KEY(tenant_id,brand_id,store_id,session_id) REFERENCES rms_dining.dining_session(tenant_id,brand_id,store_id,session_id),
 FOREIGN KEY(tenant_id,brand_id,store_id,session_id,target_participant_id) REFERENCES rms_dining.dining_participant(tenant_id,brand_id,store_id,session_id,participant_id),
 CHECK((jsonb_typeof(record_json)='object' AND octet_length(record_json::text)<=1048576
 AND record_json ?& ARRAY['command','previousSession','session','targetParticipant']
 AND record_json-ARRAY['command','previousSession','session','targetParticipant']='{}'::jsonb
 AND record_json#>>'{command,operationReference}'=operation_id::text
 AND record_json#>>'{command,tenantReference}'=tenant_id::text
 AND record_json#>>'{command,brandReference}'=brand_id::text
 AND record_json#>>'{command,storeReference}'=store_id::text
 AND record_json#>>'{command,diningSessionReference}'=session_id::text
 AND record_json#>>'{command,targetParticipantReference}'=target_participant_id::text
 AND record_json#>>'{command,expectedSessionVersion}'=expected_version::text
 AND (record_json#>>'{command,observedAt}')::timestamptz=occurred_at
 AND record_json#>>'{command,purposeCode}'='TransferDiningHost'
 AND record_json#>>'{command,permissionCode}'='dining.host.transfer'
 AND record_json#>>'{command,actorType}' IN ('Staff','Participant')
 AND record_json#>>'{command,actorReference}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND record_json#>>'{command,reasonCode}' ~ '^[A-Z][A-Z0-9_]{0,63}$'
 AND record_json#>'{command,expectedHostParticipantReference}'=record_json#>'{previousSession,hostParticipantReference}'
 AND (record_json#>>'{command,actorType}'='Staff' OR record_json#>>'{command,actorReference}'=record_json#>>'{previousSession,hostParticipantReference}')
 AND record_json#>>'{previousSession,diningSessionReference}'=session_id::text
 AND record_json#>>'{previousSession,brandReference}'=brand_id::text
 AND record_json#>>'{previousSession,storeReference}'=store_id::text
 AND record_json#>>'{previousSession,version}'=expected_version::text
 AND record_json#>>'{previousSession,phase}' IN ('Active','Closing')
 AND (record_json#>>'{previousSession,startedAt}')::timestamptz<=occurred_at
 AND record_json#>'{previousSession,hostParticipantReference}'<>to_jsonb(target_participant_id::text)
 AND record_json->'session'=(record_json->'previousSession')||jsonb_build_object('hostParticipantReference',target_participant_id::text,'version',expected_version+1)
 AND record_json#>>'{targetParticipant,participantReference}'=target_participant_id::text
 AND record_json#>>'{targetParticipant,diningSessionReference}'=session_id::text
 AND record_json#>>'{targetParticipant,status}'='Active'
 AND (record_json#>>'{targetParticipant,joinedAt}')::timestamptz BETWEEN (record_json#>>'{previousSession,startedAt}')::timestamptz AND occurred_at) IS TRUE)
);
CREATE FUNCTION rms_dining.validate_host_transfer_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM rms_dining.dining_session WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND session_id=NEW.session_id AND version=NEW.expected_version+1 AND session_snapshot=NEW.record_json->'session')
 OR NOT EXISTS(SELECT 1 FROM rms_dining.dining_participant WHERE tenant_id=NEW.tenant_id AND brand_id=NEW.brand_id AND store_id=NEW.store_id AND session_id=NEW.session_id AND participant_id=NEW.target_participant_id AND participant_snapshot=NEW.record_json->'targetParticipant') THEN
 RAISE EXCEPTION 'host transfer source mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION rms_dining.validate_host_transfer_insert() FROM PUBLIC;
CREATE TRIGGER dining_host_transfer_source BEFORE INSERT ON rms_dining.dining_host_transfer_operation FOR EACH ROW EXECUTE FUNCTION rms_dining.validate_host_transfer_insert();
CREATE FUNCTION rms_dining.reject_host_transfer_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$ BEGIN RAISE EXCEPTION 'immutable host transfer history' USING ERRCODE='55000'; END; $$;
REVOKE ALL ON FUNCTION rms_dining.reject_host_transfer_mutation() FROM PUBLIC;
CREATE TRIGGER dining_host_transfer_no_mutation BEFORE UPDATE OR DELETE ON rms_dining.dining_host_transfer_operation FOR EACH ROW EXECUTE FUNCTION rms_dining.reject_host_transfer_mutation();
CREATE TRIGGER dining_host_transfer_no_truncate BEFORE TRUNCATE ON rms_dining.dining_host_transfer_operation FOR EACH STATEMENT EXECUTE FUNCTION rms_dining.reject_host_transfer_mutation();
ALTER TABLE rms_dining.dining_host_transfer_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_host_transfer_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_host_transfer_scope ON rms_dining.dining_host_transfer_operation
 USING(brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK(brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_host_transfer_operation FROM PUBLIC;
