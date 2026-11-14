-- bop-rms-migration: 1
-- owner: @rms/dining
-- schema: rms_dining
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Immutable acknowledgement; task_json is NOT the current Task lifecycle state.
CREATE TABLE rms_dining.dining_exception_task (
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 store_id platform_helpers.uuid_v7 NOT NULL,
 session_id platform_helpers.uuid_v7 NOT NULL,
 order_id platform_helpers.uuid_v7 NOT NULL,
 evidence_version bigint NOT NULL CHECK(evidence_version BETWEEN 1 AND 9007199254740991),
 intent_hash text NOT NULL CHECK(intent_hash ~ '^[0-9a-f]{64}$'),
 evidence_digest text NOT NULL CHECK(evidence_digest ~ '^[0-9a-f]{64}$'),
 task_id platform_helpers.uuid_v7 NOT NULL,
 requested_at text NOT NULL CHECK(requested_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' AND to_char(requested_at::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=requested_at),
 task_json jsonb NOT NULL,
 PRIMARY KEY(brand_id,store_id,session_id,order_id,evidence_version),
 UNIQUE(brand_id,store_id,task_id),
 FOREIGN KEY(tenant_id,brand_id,store_id,session_id) REFERENCES rms_dining.dining_session(tenant_id,brand_id,store_id,session_id),
 CHECK((jsonb_typeof(task_json)='object' AND octet_length(task_json::text)<=1048576
  AND task_json->>'taskReference'=task_id::text
  AND task_json#>>'{scope,kind}'='Store'
  AND task_json#>>'{scope,brandReference}'=brand_id::text
  AND task_json#>>'{scope,storeReference}'=store_id::text
  AND task_json#>>'{source,sourceType}'='DINING_SESSION'
  AND task_json#>>'{source,sourceReference}'=session_id::text
  AND task_json#>>'{source,snapshotDigest}'='sha256:'||evidence_digest
  AND task_json->>'taskType'='DINING_UNPAID_BATCH_EXCEPTION'
  AND task_json->>'severityCode'='CRITICAL' AND task_json->>'priorityCode'='CRITICAL'
  AND task_json->>'status' IN ('Assigned','Claimed')
  AND task_json#>>'{currentAssignment,target,kind}'='Queue'
  AND (task_json->>'updatedAt')::timestamptz<=requested_at::timestamptz) IS TRUE)
);
CREATE FUNCTION rms_dining.reject_exception_task_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$ BEGIN RAISE EXCEPTION 'Dining exception acknowledgement is immutable' USING ERRCODE='55000'; END; $$;
REVOKE ALL ON FUNCTION rms_dining.reject_exception_task_mutation() FROM PUBLIC;
CREATE TRIGGER dining_exception_task_no_mutation BEFORE UPDATE OR DELETE ON rms_dining.dining_exception_task FOR EACH ROW EXECUTE FUNCTION rms_dining.reject_exception_task_mutation();
CREATE TRIGGER dining_exception_task_no_truncate BEFORE TRUNCATE ON rms_dining.dining_exception_task FOR EACH STATEMENT EXECUTE FUNCTION rms_dining.reject_exception_task_mutation();
ALTER TABLE rms_dining.dining_exception_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_dining.dining_exception_task FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_exception_task_scope ON rms_dining.dining_exception_task
 USING(brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id())
 WITH CHECK(brand_id=platform_helpers.current_brand_id() AND store_id=platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_dining.dining_exception_task FROM PUBLIC;
